import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { codexApprovalPrompt as approvalPrompt, claudePrompt, pendingClaudeRequest, pendingCodexRequest, publicPrompt,
  validateClaudeAnswer, answerClaudePrompt, claudeQuestionResult } from './prompt-adapter.mjs';
import { acquireNativeControl, sendVerifiedMenuKey } from './native-controls.mjs';
import { deliverNow, deliverNowInfo } from './deliver-now.mjs';
import { codexQueuedInput as nativeQueuedInput, deliveryIdentity } from './deliver-now-control.mjs';
import { nativeSuggestion } from './native-suggestions.mjs';
import { codexContextSuggestion } from './codex-suggestions.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const receipts = path.join(os.homedir(), '.local/share/agent-deck/chat-receipts');
const sessions = new Map();
const histories = new Map();
const prompts = new Map();
const controls = new Map();
const starts = new Map();
const activeSends = new Set();
const activeResponses = new Set();
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9-]{8,100}$/.test(value);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const questionMessages = {
  accepted: '原生会话已确认收到回答。',
  rejected: '原生会话拒绝或取消了本次回答，尚未确认接受；请核对当前会话。',
  cancelled: '原生会话已确认取消当前问题。',
  'next-step': '已进入下一确认步骤，请继续完成当前问题。',
  pending: '已发送选择，正在等待原生会话确认；不会自动再次提交。',
};

function questionReceipt(record) {
  if (!record?.requestId || !Object.hasOwn(questionMessages, record.outcome)) return {};
  return { action: record.action, requestId: record.requestId, finalKeyAttempted: record.finalKeyAttempted === true,
    finalKeySent: record.finalKeySent === true, verified: record.verified === true, outcome: record.outcome,
    nextPromptId: record.nextPromptId || null };
}

async function cachedSession(id, api, fresh = false) {
  if (!identifier(id)) throw new Error('请选择有效会话。');
  const cached = sessions.get(id);
  if (cached?.promise) return cached.promise;
  if (!fresh && cached && Date.now() - cached.time < 2500) return cached.value;
  const entry = { time: Date.now() };
  entry.promise = api.session(id).then(value => {
    entry.value = value; entry.time = Date.now(); delete entry.promise; return value;
  }).catch(error => { sessions.delete(id); throw error; });
  sessions.set(id, entry);
  return entry.promise;
}

async function cli(api, row, args, timeout = 20000) {
  const prefix = row?.profile ? ['-p', row.profile] : [];
  try {
    // send-status can restart a queue worker too, so recovery uses the same build.
    const executable = args[0] === 'session' && (args[1] === 'send-status' || args[1] === 'send' && args.includes('--queue')) && api.queuedSender
      ? await api.queuedSender() : api.deck;
    const { stdout } = await api.exec(executable, [...prefix, ...args], { timeout, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    if (error.stdout) {
      try { return JSON.parse(error.stdout); } catch { /* Unknown delivery must never be retried. */ }
    }
    throw new Error('Agent Deck 未返回可确认的结果，请查询原回执或检查会话。');
  }
}

function supported(row) {
  if (row.ssh_host) throw new Error('聊天记录适配当前只读取本机 WSL 会话。请使用远端会话的高级终端。');
  if (!['claude', 'codex'].includes(row.tool)) throw new Error('此会话类型请使用高级终端。聊天消息当前支持 Claude 和 Codex。');
}

function startupFailure(row) {
  const failure = row.spawn_failure;
  if (!failure) return null;
  return {
    reason: /^[a-zA-Z0-9_.:-]{1,100}$/.test(failure.reason || '') ? failure.reason : 'spawn_failed',
    elapsed_ms: Number.isFinite(failure.elapsed_ms) && failure.elapsed_ms >= 0 ? failure.elapsed_ms : null,
  };
}

// Native status includes background shells; only the current foreground turn
// controls the chat spinner and interrupt button. A fresh hook is authoritative.
export function chatActivity(row, prompt = null) {
  const backgroundWork = row.substate === 'background-work';
  let activity = row.status;
  if (!['stopped', 'error', 'starting'].includes(row.status)) {
    if (prompt) activity = 'awaiting_input';
    else if (row.hook_status_fresh && ['running', 'waiting', 'idle'].includes(row.hook_status)) activity = row.hook_status;
  }
  return { activity, turnRunning: activity === 'running', backgroundWork };
}

async function responseStatus(row, prompt) {
  if (!prompt?.id) return null;
  const key = `${row.id}:${prompt.id}`;
  const record = await fsp.readFile(path.join(receipts, `prompt-${hash(key)}.json`), 'utf8').then(JSON.parse).catch(() => null);
  if (!record || record.sessionId !== row.id || record.promptId !== prompt.id) return null;
  const requestActive = activeResponses.has(key);
  const question = questionReceipt(record);
  const explanation = question.outcome === 'pending' && !question.finalKeySent
    ? record.reason || '选项操作尚未完成，最终确认还未核实送达；请刷新核对，系统不会自动重发。'
    : questionMessages[question.outcome];
  return { promptId: prompt.id, state: requestActive ? 'posting' : 'unknown', requestActive,
    canStopTracking: !requestActive, inputBlocked: true, ...question,
    message: requestActive ? '正在提交当前回答。' : explanation || record.reason || '原确认已经尝试提交；当前问题仍在等待核对。请查询原状态或在独立终端检查。' };
}

async function startSession(id, api) {
  if (starts.has(id)) return starts.get(id);
  const attempt = (async () => {
    const row = await cachedSession(id, api, true);
    supported(row);
    const current = { sessionId: row.id, status: row.status, substate: row.substate || '', startupError: startupFailure(row) };
    if (['running', 'waiting'].includes(row.status)) return { code: 200, body: { ...current, success: true, started: false } };
    if (!['stopped', 'error'].includes(row.status)) {
      return { code: 202, body: { ...current, success: false, started: false, pending: true,
        message: '当前启动状态尚未确定，正在查询原会话。' } };
    }
    // The official CLI calls VerifySpawned; the upstream Web start action does not.
    try { await cli(api, row, ['session', 'start', row.id, '--json'], 30000); }
    catch { /* Read the original session below; an unknown response must not trigger another start. */ }
    sessions.delete(row.id);
    let actual;
    try { actual = await cachedSession(row.id, api, true); }
    catch {
      return { code: 202, body: { sessionId: row.id, success: false, started: false, status: 'unknown', pending: true,
        message: '启动结果尚未确认，请等待原会话状态更新。' } };
    }
    const failure = startupFailure(actual);
    const response = { sessionId: actual.id, status: actual.status, substate: actual.substate || '', startupError: failure };
    if (['running', 'waiting'].includes(actual.status)) return { code: 200, body: { ...response, success: true, started: true } };
    if (!['stopped', 'error'].includes(actual.status)) {
      return { code: 202, body: { ...response, success: false, started: false, pending: true,
        message: '会话仍在启动或核对状态，请等待原会话更新。' } };
    }
    const detail = failure ? `${failure.reason}${failure.elapsed_ms === null ? '' : `，${failure.elapsed_ms} ms`}` : actual.status;
    return { code: 409, body: { ...response, success: false, started: false,
      error: `会话未保持运行（${detail}）。原会话已保留，请检查后重试。` } };
  })();
  starts.set(id, attempt);
  try { return await attempt; } finally { starts.delete(id); }
}

async function history(row, before, api) {
  let stamp = '';
  if (row.transcript_path) {
    for (const name of [row.transcript_path, row.transcript_path + '.zst']) {
      const stat = await fsp.stat(name).catch(() => null);
      if (stat?.isFile()) { stamp = `${name}:${stat.size}:${stat.mtimeMs}`; break; }
    }
  }
  const key = `${row.id}:${before || ''}`;
  const cached = histories.get(key);
  if (cached?.promise) return cached.promise;
  if (cached && cached.stamp === stamp && (stamp || Date.now() - cached.time < 5000)) return cached.value;
  const request = { path: row.transcript_path, tool: row.tool, nativeId: row.codex_session_id,
    codexHome: row.resolved_codex_home, before };
  const entry = { stamp, time: Date.now() };
  entry.promise = (async () => {
    let output;
    try {
      output = await api.exec('/usr/bin/python3', [path.join(root, 'chat-history.py'), JSON.stringify(request)],
        { timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
    } catch (error) {
      if (error.stdout) {
        try { throw new Error(JSON.parse(error.stdout).error || '历史读取未完成。'); }
        catch (parseError) { if (!(parseError instanceof SyntaxError)) throw parseError; }
      }
      throw new Error('历史记录读取未完成，请稍后刷新。');
    }
    const result = JSON.parse(output.stdout);
    if (result.error) throw new Error(result.error);
    entry.value = result; delete entry.promise;
    if (histories.size > 80) histories.delete(histories.keys().next().value);
    return result;
  })().catch(error => { histories.delete(key); throw error; });
  histories.set(key, entry);
  return entry.promise;
}

async function currentPrompt(row, api, fresh = false, turnId = '') {
  if (!['claude', 'codex'].includes(row.tool) || ['stopped', 'error', 'starting'].includes(row.status)) return null;
  if (row.tool === 'codex' && !['waiting', 'idle'].includes(chatActivity(row).activity) && !/approval|permission|menu|question/.test(row.substate || '')) return null;
  const cached = prompts.get(row.id);
  const identity = hash(JSON.stringify(deliveryIdentity(row)));
  if (!fresh && cached && cached.identity === identity && cached.turnId === turnId && Date.now() - cached.time < 3000) return cached.value;
  const pane = await cli(api, row, ['session', 'output', row.id, '--pane', '--primary', '--json']);
  if (pane.session_id && pane.session_id !== row.id) throw new Error('终端会话标识不一致。');
  const pending = row.tool === 'claude' ? await pendingClaudeRequest(row.transcript_path, pane.content).catch(() => null) : null;
  let value = pane.success ? (row.tool === 'claude' ? claudePrompt(pane.content, pending) : approvalPrompt(pane.content)) : null;
  if (value && row.tool === 'codex') {
    const request = await pendingCodexRequest(row.transcript_path).catch(() => null);
    value = request ? { ...value, id: hash(JSON.stringify([row.id, row.codex_session_id, request, value.id])) }
      : { type: 'terminal', kind: 'terminal', supported: false, state: 'unsupported', options: [],
        text: '当前权限请求缺少可核验的原生调用标识，请在高级终端核对。' };
  } else if (value) {
    value.id = hash(JSON.stringify([row.id, row.claude_session_id, value.id]));
  }
  prompts.set(row.id, { value, content: pane.success ? pane.content : '', identity, turnId, time: Date.now() });
  return value;
}

async function respondToPrompt(row, body, api) {
  const release = row.id === body.sessionId && acquireNativeControl(row.id);
  if (!release) {
    return { code: 409, body: { success: false, keySent: false, error: '上一操作正在处理，请等待状态更新。' } };
  }
  let marker, record;
  const responseKey = `${row.id}:${body.promptId}`;
  activeResponses.add(responseKey);
  try {
    const prompt = await currentPrompt(row, api, true);
    if (!prompt?.supported || !prompt.id || prompt.id !== body.promptId) {
      return { code: 409, body: { success: false, keySent: false, prompt: publicPrompt(prompt), error: '当前确认内容已变化，请刷新后重新选择。' } };
    }
    const answer = row.tool === 'claude' ? validateClaudeAnswer(prompt, body) : null;
    const nativeQuestion = row.tool === 'claude' && ['question', 'review'].includes(prompt.type);
    if (row.tool === 'codex' && (!prompt.options.some(option => option.value === String(body.choice)) ||
        body.text !== undefined || body.choices !== undefined || (body.action && body.action !== 'submit'))) {
      return { code: 400, body: { success: false, keySent: false, error: '请选择当前显示的权限选项。' } };
    }
    // The durable reservation prevents duplicate confirmation after a lost HTTP
    // response or server restart. A changed native question receives a new id.
    await fsp.mkdir(receipts, { recursive: true, mode: 0o700 });
    marker = path.join(receipts, `prompt-${hash(`${row.id}:${prompt.id}`)}.json`);
    record = { sessionId: row.id, promptId: prompt.id, stage: 'reserved', keySent: false, createdAt: new Date().toISOString() };
    if (nativeQuestion) Object.assign(record, { action: answer.cancel ? 'cancel' : 'submit', requestId: prompt._native.requestId,
      finalKeyAttempted: false, finalKeySent: false, verified: false, outcome: 'pending', nextPromptId: null });
    try {
      const file = await fsp.open(marker, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(record)); await file.sync(); } finally { await file.close(); }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return { code: 409, body: { success: false, unknown: true, keySent: null, prompt: publicPrompt(prompt),
        error: '此确认已经尝试提交，请查询当前状态；不会重复发送。' } };
    }
    const identity = current => current.id === row.id && current.tool === row.tool && !current.ssh_host &&
      current.tmux_session === row.tmux_session && current.transcript_path === row.transcript_path &&
      current.claude_session_id === row.claude_session_id && current.codex_session_id === row.codex_session_id;
    const read = async () => {
      const actual = await cachedSession(row.id, api, true);
      if (!identity(actual)) throw new Error('原会话已变化，确认操作已停止。');
      return currentPrompt(actual, api, true);
    };
    let result;
    if (row.tool === 'codex') {
      const fresh = await read();
      if (fresh?.id !== prompt.id) throw new Error('当前确认内容已变化，请刷新后重新选择。');
      record.keySent = null;
      await saveReceipt(marker, record);
      const native = await cli(api, row, ['session', 'approve', row.id, String(body.choice), '--json']);
      result = { success: native.success === true, keySent: native.key_sent, verified: native.verified,
        nextPromptSeen: native.next_prompt_seen, error: native.error, prompt: publicPrompt(await read()) };
    } else {
      const native = await answerClaudePrompt(prompt, answer, {
        read,
        pause: () => new Promise(resolve => setTimeout(resolve, 150)),
        send: async (args, final = false) => {
          record.keySent = null;
          if (nativeQuestion && final) record.finalKeyAttempted = true;
          await saveReceipt(marker, record);
          const output = args[0] === '--named-key' ? await sendVerifiedMenuKey(row, args[1], api)
            : await cli(api, row, ['session', 'send-keys', row.id, ...args, '--primary', '--json']);
          if (output.success !== true || (output.session_id && output.session_id !== row.id)) throw new Error('未能确认按键已送达原会话。');
          record.keySent = true;
          if (nativeQuestion && final) record.finalKeySent = true;
          if (nativeQuestion) await saveReceipt(marker, record);
        },
      });
      if (nativeQuestion) {
        let outcome = null;
        const nextPromptId = native.prompt?.supported && native.prompt.id !== prompt.id ? native.prompt.id : null;
        const nextStep = nextPromptId && native.prompt._native?.requestId === record.requestId;
        for (let attempt = 0; attempt < 3; attempt++) {
          outcome = await claudeQuestionResult(row.transcript_path, record.requestId).catch(() => null);
          if (outcome) break;
          if (nextStep) { outcome = 'next-step'; break; }
          if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 400));
        }
        outcome = outcome === 'rejected' && answer.cancel ? 'cancelled' : outcome || 'pending';
        Object.assign(record, { verified: outcome !== 'pending', outcome, nextPromptId });
        result = { success: outcome !== 'rejected', keySent: native.keySent, ...questionReceipt(record),
          state: outcome === 'pending' ? 'waiting' : outcome, prompt: publicPrompt(native.prompt), message: questionMessages[outcome],
          ...(outcome === 'rejected' ? { unknown: false, reason: 'native_question_rejected', error: questionMessages.rejected } : {}) };
      } else {
        result = { success: true, keySent: native.keySent, verified: native.prompt?.id !== prompt.id,
          prompt: publicPrompt(native.prompt), message: native.prompt ? '已更新当前确认步骤。' : '已发送确认，正在等待会话更新。' };
      }
    }
    record = { ...record, stage: result.outcome === 'rejected' ? 'rejected' : result.success ? 'sent' : 'unknown', keySent: result.keySent };
    await saveReceipt(marker, record);
    prompts.delete(row.id); sessions.delete(row.id);
    return { code: result.success ? 200 : 409, body: result };
  } catch (error) {
    if (record && marker) {
      record.stage = 'unknown';
      record.reason = error.message;
      await saveReceipt(marker, record).catch(() => {});
    }
    const prompt = await currentPrompt(await cachedSession(row.id, api, true), api, true).catch(() => null);
    const keySent = record ? record.keySent : (error.keySent ? null : false);
    return { code: 409, body: { success: false, keySent, unknown: keySent !== false,
      ...(prompt?.id === record?.promptId ? questionReceipt(record) : {}), prompt: publicPrompt(prompt), error: error.message } };
  } finally { activeResponses.delete(responseKey); release(); }
}

async function continuationState(data, meta, api) {
  const denied = reason => ({ canContinue: false, continueReason: reason });
  if (data.send_id !== meta.sendId || data.session_id !== meta.sessionId || data.state !== 'typed' ||
      data.settled || data.delivery_evidence?.submitted !== false) return denied('原回执不符合安全恢复条件。');
  const marker = path.join(receipts, `continue-${meta.sendId}.json`);
  if (await fsp.stat(marker).catch(() => null)) return { ...denied('已尝试恢复原消息，请核对原回执和历史。'), continueAttempted: true };
  const row = await cachedSession(meta.sessionId, api, true);
  if (row.tool !== 'codex' || row.status !== 'waiting' || !identifier(row.codex_session_id) || row.ssh_host ||
      (row.hook_status_fresh && ['running', 'starting'].includes(row.hook_status)) ||
      /approval|permission|menu|question/.test(row.substate || '')) return denied('会话不是可确认的空闲输入状态。');
  if ((row.queue || []).some(item => item.id !== meta.sendId && ['queued', 'typing', 'typed', 'submitted'].includes(item.state))) {
    return denied('会话还存在其他待处理输入，请在高级终端核对。');
  }
  if (data.images?.length || typeof data.message !== 'string') return denied('此输入无法完整核对，请使用高级终端。');
  const pane = await cli(api, row, ['session', 'output', row.id, '--pane', '--primary', '--json']);
  if (!pane.success || !nativeQueuedInput(pane.content, data.message)) return denied('无法确认唯一暂存消息与原文一致且输入框为空。');
  return { canContinue: true, row, message: data.message };
}

async function observeSentMessage(data, meta, api) {
  if (data.send_id !== meta.sendId || data.session_id !== meta.sessionId ||
      !['typed', 'submitted'].includes(data.state) || typeof data.message !== 'string') return {};
  const created = typeof (data.sent_at || data.created_at) === 'string' ? Date.parse(data.sent_at || data.created_at) : NaN;
  if (!Number.isFinite(created)) return {};
  const row = await cachedSession(meta.sessionId, api);
  if (row.id !== data.session_id || !['claude', 'codex'].includes(row.tool) ||
      (data.transcript_path && data.transcript_path !== row.transcript_path)) return {};
  const recent = await history(row, null, api);
  const observed = recent.messages.find(message => message.role === 'user' && message.text === data.message &&
    (!Number.isFinite(data.transcript_from) || Number(message.id.split(':')[1]) >= data.transcript_from) &&
    typeof message.timestamp === 'string' && Number.isFinite(Date.parse(message.timestamp)) && Date.parse(message.timestamp) >= created);
  return observed ? { observedInHistory: true, observedMessageId: observed.id } : {};
}

async function continueSend(id, api) {
  if (!identifier(id)) throw new Error('发送回执标识无效。');
  const meta = { ...JSON.parse(await fsp.readFile(path.join(receipts, `send-${id}.json`), 'utf8')), sendId: id };
  const release = acquireNativeControl(meta.sessionId);
  if (!release) return { code: 409, body: { success: false, keySent: false, error: '当前会话的上一操作仍在处理。' } };
  try {
  const data = await cli(api, meta, ['session', 'send-status', id, '--json']);
  const check = await continuationState(data, meta, api);
  if (!check.canContinue) return { code: 409, body: { success: false, sendId: id, status: data.state,
    attempted: Boolean(check.continueAttempted), keySent: false, canContinue: false, error: check.continueReason } };
  const marker = path.join(receipts, `continue-${id}.json`);
  const record = { sendId: id, sessionId: meta.sessionId, nativeId: check.row.codex_session_id,
    messageHash: hash(check.message), attempted: true, keySent: false, stage: 'reserved', createdAt: new Date().toISOString() };
  try {
    const handle = await fsp.open(marker, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
    const directory = await fsp.open(receipts, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return { code: 409, body: { success: false, sendId: id, attempted: true, keySent: false, canContinue: false,
      error: '此回执已经尝试恢复，不会重复执行。' } };
  }
  try {
    // Recheck immediately before moving the native queue item. No text is inserted at either stage.
    const fresh = await cachedSession(meta.sessionId, api, true);
    const receipt = await cli(api, meta, ['session', 'send-status', id, '--json']);
    const before = await cli(api, fresh, ['session', 'output', fresh.id, '--pane', '--primary', '--json']);
    if (receipt.send_id !== id || receipt.session_id !== meta.sessionId || receipt.state !== 'typed' || receipt.settled ||
        receipt.delivery_evidence?.submitted !== false || receipt.message !== check.message ||
        fresh.status !== 'waiting' || fresh.codex_session_id !== record.nativeId ||
        /approval|permission|menu|question/.test(fresh.substate || '') ||
        (fresh.hook_status_fresh && ['running', 'starting'].includes(fresh.hook_status)) ||
        !before.success || !nativeQueuedInput(before.content, check.message)) throw new Error('会话输入已变化，恢复操作已停止。');
    const moved = await cli(api, fresh, ['session', 'send-keys', fresh.id, '--named-key', 'S-Left', '--primary', '--json']);
    if (!moved.success) throw new Error('未能确认原消息已移回输入框，请在高级终端核对。');
    record.stage = 'moved_to_composer';
    await saveReceipt(marker, record);
    await new Promise(resolve => setTimeout(resolve, 250));
    const actual = await cachedSession(meta.sessionId, api, true);
    const after = await cli(api, actual, ['session', 'output', actual.id, '--pane', '--primary', '--json']);
    if (actual.status !== 'waiting' || actual.codex_session_id !== record.nativeId ||
        /approval|permission|menu|question/.test(actual.substate || '') ||
        (actual.hook_status_fresh && ['running', 'starting'].includes(actual.hook_status)) ||
        !after.success || !nativeQueuedInput(after.content, check.message, false)) {
      throw new Error('原消息恢复后未通过核对，请在高级终端处理；没有继续提交。');
    }
    record.stage = 'enter_reserved';
    await saveReceipt(marker, record);
    const result = await cli(api, actual, ['session', 'send-keys', actual.id, '--enter', '--primary', '--json']);
    record.keySent = result.success === true ? true : null;
    record.stage = record.keySent ? 'enter_sent' : 'unknown';
    await saveReceipt(marker, record);
    sessions.delete(actual.id);
    return { code: record.keySent ? 200 : 409, body: { success: record.keySent, sendId: id,
      attempted: true, keySent: record.keySent, canContinue: false,
      message: '已尝试提交原消息，请继续核对原回执和真实历史。' } };
  } catch (error) {
    record.keySent = record.stage === 'enter_reserved' ? null : false;
    record.reason = error.message; await saveReceipt(marker, record);
    return { code: 409, body: { success: false, sendId: id, attempted: true, keySent: record.keySent,
      canContinue: false, error: error.message + ' 不会再次执行恢复按键。' } };
  }
  } finally { release(); }
}

async function attachmentPaths(paths, row, api) {
  if (!Array.isArray(paths) || paths.length > 50) throw new Error('附件列表无效。');
  const owned = path.join(api.uploads, row.id) + path.sep;
  const result = [];
  for (const value of paths) {
    if (typeof value !== 'string' || /[\x00-\x1f]/.test(value) || !path.resolve(value).startsWith(owned)) throw new Error('附件不属于当前会话。');
    const real = await fsp.realpath(value);
    if (!real.startsWith(owned)) throw new Error('附件路径无效。');
    const stat = await fsp.stat(real);
    if (!stat.isFile() || stat.size > 100 * 1024 * 1024) throw new Error('附件不可读取或超过 100 MB。');
    result.push(real);
  }
  return result;
}

function sendResult(data, extra = {}) {
  const states = ['queued', 'typing', 'typed', 'submitted', 'landed', 'failed', 'cancelled'];
  const status = data.state || (states.includes(data.verdict) ? data.verdict : '') ||
    (states.includes(data.delivery) ? data.delivery : '') || data.status || 'unknown';
  const reason = data.reason || data.error || '';
  const requestActive = activeSends.has(`${data.sessionId}:${data.clientId}`) ||
    (!data.settled && ['queued', 'typing', 'typed', 'submitted'].includes(status));
  return { success: data.success !== false, sendId: data.send_id || data.sendId || null, status,
    reason: /composer|draft|menu_open/i.test(reason)
      ? '原生输入框有草稿或正在等待交互；请在高级终端处理，原草稿保留。' + '\n' + reason : reason,
    settled: Boolean(data.settled),
    requestActive, canStopTracking: !requestActive && ['unknown', 'failed', 'cancelled'].includes(status),
    retrySafe: ['failed', 'cancelled'].includes(status),
    landedRowId: data.landed_row_id, landedAt: data.landed_at, ...extra };
}

async function saveReceipt(file, record) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const handle = await fsp.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
  finally { await handle.close(); }
  await fsp.rename(temporary, file);
  const directory = await fsp.open(path.dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function send(body, api) {
  const row = await cachedSession(body.sessionId, api, true);
  supported(row);
  if (!identifier(body.clientId)) throw new Error('发送标识无效，请刷新页面。');
  if (typeof body.text !== 'string' || Buffer.byteLength(body.text) > 48000) throw new Error('消息最大 48 KB。');
  const paths = await attachmentPaths(body.paths || [], row, api);
  if (!body.text.trim() && !paths.length) throw new Error('请填写消息或添加附件。');
  const digest = hash(JSON.stringify([body.text, paths]));
  const file = path.join(receipts, hash(`${row.id}:${body.clientId}`) + '.json');
  await fsp.mkdir(receipts, { recursive: true, mode: 0o700 });
  let record = { clientId: body.clientId, sessionId: row.id, profile: row.profile, digest, conversationIdentity: deliveryIdentity(row),
    status: 'unknown', success: false, reason: '正在确认官方发送回执；请保持原发送标识查询。', createdAt: new Date().toISOString() };
  try {
    const handle = await fsp.open(file, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
    finally { await handle.close(); }
    const directory = await fsp.open(receipts, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (previous.digest !== digest) throw new Error('同一发送标识不能用于不同消息。');
    if (identifier(previous.send_id)) {
      await saveReceipt(path.join(receipts, `send-${previous.send_id}.json`),
        { sessionId: row.id, profile: row.profile, clientId: body.clientId, receipt: file, conversationIdentity: previous.conversationIdentity });
    }
    return sendResult(previous, { clientId: body.clientId });
  }
  if (['stopped', 'error', 'starting'].includes(row.status)) {
    record = { ...record, status: 'failed', reason: '请先启动会话，再发送消息。' };
    await saveReceipt(file, record);
    return sendResult(record, { clientId: body.clientId });
  }
  const message = body.text.trim() + (paths.length ? '\n\n附件（本机文件，请按需读取）：\n' + paths.map(p => `- ${p}`).join('\n') : '');
  const messageFile = file + '.message';
  try {
    await fsp.writeFile(messageFile, message, { flag: 'wx', mode: 0o600 });
    const result = await cli(api, row, ['session', 'send', row.id, '--queue', '--json', '--no-tag',
      '--require-input-prompt', '--message-file', messageFile]);
    record = { ...record, ...result };
    await saveReceipt(file, record);
    if (identifier(result.send_id)) {
      await saveReceipt(path.join(receipts, `send-${result.send_id}.json`),
        { sessionId: row.id, profile: row.profile, clientId: body.clientId, receipt: file, conversationIdentity: record.conversationIdentity });
    }
  } catch (error) {
    record.reason = error.message + ' 不会自动重新投递。';
    await saveReceipt(file, record);
  } finally {
    await fsp.unlink(messageFile).catch(() => {});
  }
  return sendResult(record, { clientId: body.clientId });
}

export async function handleChat(req, res, url, api) {
  if (!url.pathname.startsWith('/desktop/chat/')) return false;
  const respond = (code, body) => { api.reply(res, code, body); return true; };
  if (req.method !== 'GET' && (req.method !== 'POST' || req.headers['x-agentdeck-desktop'] !== '1')) {
    return respond(403, { error: '请从本地聊天界面操作。' });
  }
  try {
    if (req.method === 'GET' && url.pathname === '/desktop/chat/history') {
      const row = await cachedSession(url.searchParams.get('sessionId'), api);
      supported(row);
      const before = url.searchParams.get('before');
      if (before && before.length > 500) throw new Error('分页参数无效。');
      const data = await history(row, before, api);
      const turnId = (data.messages || []).findLast(message => ['user', 'assistant'].includes(message.role))?.id || '';
      let prompt = await currentPrompt(row, api, false, turnId).catch(() => null);
      if (!prompt && /approval|permission|menu|question/.test(row.substate || '')) {
        prompt = { type: 'terminal', supported: false,
          text: row.substate_detail || '会话正在等待交互，请打开高级终端查看并处理。', options: [] };
      }
      const conversationId = hash(JSON.stringify([row.tool, row.claude_session_id, row.codex_session_id, row.transcript_path]));
      const captured = prompts.get(row.id);
      const activity = chatActivity(row, prompt);
      // A native API error is a request outcome, not a successful assistant reply.
      // Keep background tasks and the existing session process intact.
      const requestIssue = !before ? data.requestIssue : null;
      if (requestIssue && !prompt && !['stopped', 'error', 'starting'].includes(row.status)) {
        activity.activity = requestIssue.state === 'retrying' ? 'retrying' : 'request_failed';
        activity.turnRunning = requestIssue.state === 'retrying';
      }
      const foregroundIdle = ['waiting', 'idle'].includes(activity.activity);
      const canSuggest = foregroundIdle && !requestIssue && !before && !prompt && captured?.identity === hash(JSON.stringify(deliveryIdentity(row))) && captured.turnId === turnId && Date.now() - captured.time < 3000;
      const suggestionRow = foregroundIdle ? { ...row, status: 'waiting' } : row;
      const suggestion = canSuggest ? nativeSuggestion(suggestionRow, captured.content, conversationId, turnId) ||
        await codexContextSuggestion(suggestionRow, captured.content, conversationId, data.messages).catch(() => null) : null;
      return respond(200, { ...data, status: row.status, substate: row.substate || '', prompt: publicPrompt(prompt), suggestion,
        conversationId, ...activity, responseStatus: await responseStatus(row, prompt),
        startupError: startupFailure(row),
        canSend: !['stopped', 'error', 'starting'].includes(row.status),
        canInterrupt: activity.turnRunning });
    }
    if (req.method === 'POST' && url.pathname === '/desktop/chat/send') {
      const body = await api.bodyJSON(req);
      if (typeof body.text === 'string' && /^\/[A-Za-z0-9][\w.:-]*(?:\s|$)/.test(body.text.trim())) {
        return respond(400, { success: false, error: '请通过原生命令入口执行 / 命令。' });
      }
      const release = acquireNativeControl(body.sessionId);
      if (!release) return respond(409, { success: false, error: '当前会话的上一操作仍在处理。' });
      const key = `${body.sessionId}:${body.clientId}`;
      activeSends.add(key);
      try { return respond(200, await send(body, api)); } finally { activeSends.delete(key); release(); }
    }
    if (req.method === 'POST' && url.pathname === '/desktop/chat/start') {
      const body = await api.bodyJSON(req);
      const result = await startSession(body.sessionId, api);
      return respond(result.code, result.body);
    }
    if (req.method === 'POST' && url.pathname === '/desktop/chat/continue') {
      const body = await api.bodyJSON(req);
      const result = await continueSend(body.sendId, api);
      return respond(result.code, result.body);
    }
    if (req.method === 'POST' && url.pathname === '/desktop/chat/deliver-now') {
      const body = await api.bodyJSON(req);
      if (!identifier(body.sendId) || !identifier(body.sessionId)) return respond(400, {
        error: '会话或原发送回执标识无效。', sendId: body.sendId, keySent: false, retryAllowed: true });
      try {
        const meta = { ...JSON.parse(await fsp.readFile(path.join(receipts, `send-${body.sendId}.json`), 'utf8')), sendId: body.sendId };
        const result = await deliverNow(body, meta, api);
        sessions.delete(body.sessionId);
        return respond(result.code, result.body);
      } catch (error) {
        return respond(400, { error: error.code ? '无法核对原发送回执，请刷新后重试。' : error.message,
          sendId: body.sendId, keySent: false, retryAllowed: true, deliverNowState: 'refused', deliverNowAttempted: false });
      }
    }
    if (req.method === 'GET' && url.pathname === '/desktop/chat/send-status') {
      let id = url.searchParams.get('sendId');
      if (!id) {
        const sessionId = url.searchParams.get('sessionId'), clientId = url.searchParams.get('clientId');
        if (!identifier(sessionId) || !identifier(clientId)) throw new Error('原发送标识无效。');
        const saved = await fsp.readFile(path.join(receipts, hash(`${sessionId}:${clientId}`) + '.json'), 'utf8')
          .then(JSON.parse).catch(() => null);
        if (!saved || saved.sessionId !== sessionId || saved.clientId !== clientId) return respond(404, {
          status: 'unknown', clientId, sendId: null, requestActive: null, canStopTracking: false,
          reason: '尚未找到原发送回执，请保留原消息并再次查询。' });
        id = saved.send_id || saved.sendId;
        if (!identifier(id)) return respond(200, sendResult(saved, { clientId }));
      }
      if (!identifier(id)) throw new Error('发送回执标识无效。');
      const meta = { ...JSON.parse(await fsp.readFile(path.join(receipts, `send-${id}.json`), 'utf8')), sendId: id };
      let data;
      try { data = await cli(api, meta, ['session', 'send-status', id, '--json']); }
      catch (error) { return respond(200, { status: 'unknown', sendId: id, clientId: meta.clientId,
        requestActive: null, canStopTracking: false, reason: error.message }); }
      if (data.send_id !== id || (data.session_id && data.session_id !== meta.sessionId)) return respond(409, {
        status: 'unknown', sendId: id, clientId: meta.clientId, requestActive: null, canStopTracking: false,
        reason: '原发送回执身份未通过核对，请在独立终端检查。' });
      const result = sendResult(data, { sendId: id, clientId: meta.clientId });
      if (data.send_id === id) {
        const previous = JSON.parse(await fsp.readFile(meta.receipt, 'utf8'));
        await saveReceipt(meta.receipt, { ...previous, ...data });
      }
      Object.assign(result, await observeSentMessage(data, meta, api).catch(() => ({})));
      result.canContinue = false;
      if (!result.observedInHistory && data.state === 'typed') {
        const check = await continuationState(data, meta, api).catch(() => ({ canContinue: false, continueReason: '暂时无法核对原生输入，请查看高级终端。' }));
        result.canContinue = check.canContinue;
        result.continueReason = check.continueReason;
        result.continueAttempted = Boolean(check.continueAttempted);
      }
      if (data.state === 'landed') Object.assign(result, { canDeliverNow: false, deliverNowState: 'delivered',
        deliverNowReason: '已在原会话记录中确认这条消息。' });
      else Object.assign(result, await deliverNowInfo(data, meta, api).catch(() => ({ canDeliverNow: false,
        deliverNowReason: '暂时无法核对原队列，请刷新后查看。' })));
      if (result.deliverNowState === 'pending') { result.requestActive = true; result.canStopTracking = false; }
      return respond(200, result);
    }
    if (req.method === 'POST' && ['/desktop/chat/interrupt', '/desktop/chat/respond'].includes(url.pathname)) {
      const body = await api.bodyJSON(req);
      const row = await cachedSession(body.sessionId, api, true);
      supported(row);
      if (controls.has(row.id) && Date.now() - controls.get(row.id) < 2500) return respond(409, { error: '上一操作正在处理，请等待状态更新。' });
      if (url.pathname.endsWith('/interrupt')) {
        if (!chatActivity(row).turnRunning) return respond(409, { error: '当前没有可确认的运行回合。' });
        const release = acquireNativeControl(row.id);
        if (!release) return respond(409, { error: '当前会话的上一操作仍在处理。' });
        try {
        controls.set(row.id, Date.now());
        const result = await cli(api, row, ['session', 'send-keys', row.id, '--named-key', 'Escape', '--primary', '--json']);
        sessions.delete(row.id);
        return respond(result.success ? 200 : 409, { success: result.success, keySent: result.success,
          message: result.success ? '已发送单次中断按键，正在等待会话状态更新。' : result.error });
        } finally { release(); }
      }
      const result = await respondToPrompt(row, body, api);
      return respond(result.code, result.body);
    }
    return respond(404, { error: '不存在的聊天操作。' });
  } catch (error) {
    return respond(400, { error: error.code ? '操作未完成，请检查会话与原发送回执。' : error.message });
  }
}
