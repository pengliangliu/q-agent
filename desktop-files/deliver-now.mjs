import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { acquireNativeControl } from './native-controls.mjs';
import { deliveryCLI, deliveryHash, deliveryIdentity, deliveryCapability, deliveredInTranscript,
  officialSendLock, claudeDefaultKeys, claudeQueuedInput, claudeQueueProof } from './deliver-now-control.mjs';

const receipts = path.join(os.homedir(), '.local/share/agent-deck/chat-receipts');
const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'deliver-now-control.mjs');
const active = new Map(), versions = new Map();
const marker = id => path.join(receipts, `deliver-now-${id}.json`);
const pause = () => new Promise(resolve => setTimeout(resolve, 200));

async function save(record) {
  const temporary = marker(record.sendId) + '.' + crypto.randomUUID() + '.tmp';
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, marker(record.sendId));
}
async function previous(id) {
  try { return JSON.parse(await fs.readFile(marker(id), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function supportedVersion(api) {
  const cached = versions.get(api.deck);
  if (cached && Date.now() - cached.time < 60000) return cached.value;
  const { stdout } = await api.exec(api.deck, ['version'], { timeout: 6000, maxBuffer: 16384 });
  const value = /^Agent Deck v1\.16\.(?:35|38)(?:\s|$)/.test(stdout.trim());
  versions.set(api.deck, { time: Date.now(), value });
  return value;
}
async function snapshot(data, meta, api) {
  const row = await api.session(meta.sessionId);
  if (row.id !== meta.sessionId || data.session_id !== meta.sessionId || data.send_id !== meta.sendId) throw new Error('原消息不属于当前会话。');
  if (!Array.isArray(meta.conversationIdentity)) return { row, data, gate: { canDeliverNow: false,
    deliverNowWillInterrupt: false, deliverNowReason: '原消息缺少原生会话身份记录，请在独立终端核对。' } };
  const output = await deliveryCLI(api, row, ['session', 'output', row.id, '--pane', '--primary', '--json']);
  if (!output.success || output.session_id !== row.id) throw new Error('无法确认原会话主终端。');
  const defaultKeys = await claudeDefaultKeys(row);
  const pane = output.content || '';
  const queueProof = row.tool === 'claude' && defaultKeys && ['typed', 'submitted'].includes(data.state) &&
    claudeQueuedInput(pane, data.message) && await claudeQueueProof(row, data.message, data.created_at);
  const gate = deliveryCapability(data, row, pane, { sendId: meta.sendId,
    identity: meta.conversationIdentity, defaultKeys, queueProof });
  if (gate.canDeliverNow && !await supportedVersion(api)) return { row, data, gate: { canDeliverNow: false,
    deliverNowWillInterrupt: false, deliverNowReason: 'Agent Deck 版本已变化，立即投递路径需要重新核对。' } };
  return { row, data, gate };
}
function attemptView(record) {
  const state = record.state === 'pending' && !active.has(record.sendId) ? 'unknown' : record.state;
  const retryAllowed = state === 'refused' && record.keySent === false;
  return { canDeliverNow: false, deliverNowState: state, deliverNowAttempted: !retryAllowed,
    deliverNowWillInterrupt: Boolean(record.willInterrupt), deliverNowReason: record.reason || '',
    keySent: record.keySent, interrupted: Boolean(record.interrupted), retryAllowed,
    unknown: state === 'unknown', message: record.reason || '' };
}

export async function deliverNowInfo(data, meta, api) {
  const record = await previous(meta.sendId);
  if (record && record.sessionId !== meta.sessionId) throw new Error('投递请求与原会话不一致。');
  const row = await api.session(meta.sessionId);
  if (row.id !== meta.sessionId || data.session_id !== meta.sessionId || data.send_id !== meta.sendId) throw new Error('原消息不属于当前会话。');
  if (meta.conversationIdentity && deliveryHash(deliveryIdentity(row)) !== deliveryHash(meta.conversationIdentity)) return {
    ...(record ? attemptView({ ...record, state: 'unknown', reason: '原生会话身份已变化，请核对原消息。' }) : {}),
    canDeliverNow: false, deliverNowState: record ? 'unknown' : 'unavailable',
    deliverNowWillInterrupt: false, deliverNowReason: '原生会话身份已变化，请核对原消息。' };
  const observed = data.state === 'landed' || await deliveredInTranscript(row, data);
  if (observed) {
    if (record && record.state !== 'delivered') { record.state = 'delivered'; record.reason = '已在原会话记录中确认这条消息。'; await save(record); }
    return { ...(record ? attemptView(record) : {}), canDeliverNow: false, deliverNowState: 'delivered',
      deliverNowReason: '已在原会话记录中确认这条消息。', observedInHistory: data.state !== 'landed' };
  }
  if (record && (record.state !== 'refused' || record.keySent !== false)) return attemptView(record);
  if (!['queued', 'typing', 'typed', 'submitted'].includes(data.state)) return {
    canDeliverNow: false, deliverNowState: record?.state || 'unavailable', deliverNowAttempted: false,
    deliverNowWillInterrupt: false, deliverNowReason: '原消息当前没有可立即投递的队列项。' };
  const state = await snapshot(data, meta, api);
  return { ...(record ? attemptView(record) : {}), ...state.gate,
    deliverNowState: record?.state || (state.gate.canDeliverNow ? 'available' : 'unavailable'), deliverNowAttempted: false };
}

async function guardedAction(record, api) {
  const lock = await officialSendLock(record.sessionId);
  await fs.mkdir(path.dirname(lock), { recursive: true, mode: 0o755 });
  const handle = await fs.open(lock, 'a', 0o600); await handle.close();
  record.keySent = record.keySent === true ? true : null; record.stage = 'native-guard'; await save(record);
  try {
    const request = { sessionId: record.sessionId, sendId: record.sendId, identity: record.identity,
      messageHash: record.messageHash, profile: record.profile, deck: api.deck, claudeNativeOnly: record.claudeNativeOnly };
    // --no-fork makes timeout terminate the lock-owning helper itself. A held
    // official send lock is refused immediately; it is never stolen or waited out.
    const { stdout } = await api.exec('/usr/bin/flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '--no-fork',
      lock, process.execPath, helper, JSON.stringify(request)], { timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    if (error.code === 73 || error.code === 'ENOENT') return { outcome: 'refused', keySent: false,
      reason: error.code === 73 ? '原队列正在操作输入框，请等待原回执更新后再试。' : '当前系统缺少已核验的投递锁工具。' };
    return { outcome: 'unknown', keySent: null, reason: '投递保护操作结果尚未确认，不会再次发送按键或消息。' };
  }
}

async function run(record, meta, api) {
  try {
    let result = await guardedAction(record, api);
    record.keySent = result.keySent; record.interrupted = Boolean(result.interrupted); record.reason = result.reason || '';
    if (result.outcome === 'refused') { record.state = record.keySent === false ? 'refused' : 'unknown'; return; }
    if (result.outcome === 'unknown') { record.state = 'unknown'; return; }
    if (result.outcome === 'delivered') { record.state = 'delivered'; record.reason = '已在原会话记录中确认这条消息。'; return; }
    let row = await api.session(record.sessionId);
    if (deliveryHash(deliveryIdentity(row)) !== deliveryHash(record.identity)) throw new Error('原生会话身份已变化，投递已停止。');
    if (result.outcome === 'release') {
      const beforeRelease = record.keySent;
      record.stage = 'queue-release'; record.releaseRequested = true; record.keySent = record.keySent === true ? true : null; await save(record);
      // Only this original worker may type the original bytes. Do not call send,
      // cancel/re-enqueue, edit its record, or remove its control files.
      result = await deliveryCLI(api, row, ['session', 'queue', 'release', record.sendId, '--json'], 190000);
      record.releaseOutcome = result.outcome;
      if (result.send_id && result.send_id !== record.sendId || result.session_id && result.session_id !== record.sessionId) throw new Error('原队列回执标识不一致。');
      if (result.outcome === 'unknown' || !result.outcome) { record.state = 'unknown'; record.reason = result.reason || '原队列尚未确认结果，继续查询原回执。'; return; }
      if (result.outcome === 'refused') {
        record.keySent = beforeRelease;
        record.state = record.keySent === false ? 'refused' : 'unknown'; record.reason = result.reason || '原队列暂时拒绝投递，消息保持原状。'; return;
      }
      if (['cancelled', 'not_found'].includes(result.outcome)) { record.state = 'unknown'; record.reason = '原队列消息已经结束或不可用，请核对原回执。'; return; }
      const data = await deliveryCLI(api, row, ['session', 'send-status', record.sendId, '--json']);
      if (['submitted', 'landed'].includes(data.state) && data.delivery_evidence?.submitted === true) record.keySent = true;
      row = await api.session(record.sessionId);
      if (data.send_id !== record.sendId || data.session_id !== record.sessionId || deliveryHash(deliveryIdentity(row)) !== deliveryHash(record.identity)) throw new Error('原回执或原生会话身份已变化。');
      if (data.state === 'landed' || await deliveredInTranscript(row, data)) { record.state = 'delivered'; record.reason = '原消息已进入当前会话。'; return; }
      if (row.tool === 'codex' && result.outcome === 'delivered' && data.state === 'submitted') {
        record.state = 'delivered'; record.reason = '原生会话已确认提交这条消息。'; return;
      }
      // A busy Claude may accept release into its native queue before the idle
      // transition settles. Complete that same item only if its unique queue is proven.
      if (['typed', 'submitted'].includes(data.state)) {
        const state = await snapshot(data, meta, api);
        if (state.gate.canDeliverNow && ['claude-native', 'codex-native'].includes(state.gate.mode)) {
          record.stage = 'native-submit'; await save(record);
          const following = await guardedAction(record, api);
          record.keySent = record.keySent === true || following.keySent === true ? true : following.keySent;
          record.interrupted = record.interrupted || Boolean(following.interrupted);
          if (following.outcome === 'delivered') { record.state = 'delivered'; record.reason = '原消息已进入当前会话。'; return; }
          if (following.outcome === 'unknown' || following.outcome === 'refused') { record.state = 'unknown'; record.reason = following.reason || '原生队列提交结果待确认。'; return; }
        }
      }
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      await pause();
      const data = await deliveryCLI(api, meta, ['session', 'send-status', record.sendId, '--json']);
      row = await api.session(record.sessionId);
      if (data.send_id !== record.sendId || data.session_id !== record.sessionId || deliveryHash(deliveryIdentity(row)) !== deliveryHash(record.identity)) throw new Error('原回执或原生会话身份已变化。');
      if (data.state === 'landed' || await deliveredInTranscript(row, data)) { record.state = 'delivered'; record.reason = '已在原会话记录中确认这条消息。'; return; }
    }
    record.state = 'unknown'; record.reason = '已尝试投递原消息，尚未确认进入会话；继续查询原发送回执，不会重复发送。';
  } catch (error) { record.state = 'unknown'; record.reason = error.message; }
  finally { await save(record); }
}

export async function deliverNow(body, meta, api, { claudeNativeOnly = false } = {}) {
  if (body.sessionId !== meta.sessionId || body.sendId !== meta.sendId) return { code: 409,
    body: { success: false, sendId: meta.sendId, keySent: false, retryAllowed: true, error: '消息与当前会话不一致。' } };
  const old = await previous(meta.sendId);
  if (old && (old.state !== 'refused' || old.keySent !== false)) return { code: 200,
    body: { success: true, sendId: meta.sendId, ...attemptView(old) } };
  const release = acquireNativeControl(meta.sessionId);
  if (!release) return { code: 409, body: { success: false, sendId: meta.sendId, keySent: false, retryAllowed: true,
    deliverNowState: 'refused', deliverNowAttempted: false, error: '当前会话还有其他输入操作，请等待完成。' } };
  let started = false;
  try {
    const data = await deliveryCLI(api, meta, ['session', 'send-status', meta.sendId, '--json']);
    const info = await deliverNowInfo(data, meta, api);
    if (!info.canDeliverNow) return { code: info.deliverNowState === 'delivered' ? 200 : 409, body: {
      success: info.deliverNowState === 'delivered', sendId: meta.sendId, status: data.state, ...info,
      keySent: false, retryAllowed: info.deliverNowState !== 'delivered', error: info.deliverNowState === 'delivered' ? undefined : info.deliverNowReason } };
    if (claudeNativeOnly && info.mode !== 'claude-native') return { code: 409,
      body: { sendId: meta.sendId, status: data.state, keySent: false, retryAllowed: true } };
    const row = await api.session(meta.sessionId);
    if (!Array.isArray(meta.conversationIdentity) || deliveryHash(deliveryIdentity(row)) !== deliveryHash(meta.conversationIdentity)) return {
      code: 409, body: { success: false, sendId: meta.sendId, keySent: false, retryAllowed: true,
        deliverNowState: 'refused', deliverNowAttempted: false, error: '原生会话身份已变化，已停止投递。' } };
    const record = { sendId: meta.sendId, sessionId: meta.sessionId, profile: meta.profile, identity: [...meta.conversationIdentity],
      messageHash: deliveryHash(data.message), willInterrupt: info.deliverNowWillInterrupt, state: 'pending', stage: 'reserved',
      keySent: false, interrupted: false, releaseRequested: false, claudeNativeOnly,
      createdAt: new Date().toISOString(), reason: '正在核对并投递原消息。' };
    await fs.mkdir(receipts, { recursive: true, mode: 0o700 });
    if (old) await save(record);
    else {
      const handle = await fs.open(marker(meta.sendId), 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
    }
    const operation = run(record, meta, api).catch(() => {}).finally(() => { active.delete(meta.sendId); release(); });
    active.set(meta.sendId, operation); started = true;
    return { code: 202, body: { success: true, sendId: meta.sendId, status: data.state, ...attemptView(record), retryAllowed: false } };
  } finally { if (!started) release(); }
}

// A new chat send can briefly be in the original worker's typing phase.
// Retry only the preflight when it explicitly proves no action was attempted.
export async function deliverNewMessageNow(meta, api, tool) {
  const claude = tool === 'claude';
  const deadline = Date.now() + 6000;
  const retryStates = claude ? ['queued', 'typing', 'typed', 'submitted'] : ['queued', 'typing'];
  for (let attempt = 0; attempt < (claude ? 12 : 3); attempt++) {
    const { code, body } = await deliverNow({ sessionId: meta.sessionId, sendId: meta.sendId }, meta, api, { claudeNativeOnly: claude });
    if (claude && code === 202) {
      await active.get(meta.sendId);
      const record = await previous(meta.sendId);
      if (record?.state !== 'refused' || record.keySent !== false) return;
    } else if (code !== 409 || !retryStates.includes(body.status) || body.keySent !== false ||
        body.retryAllowed !== true || body.deliverNowAttempted) return;
    if (Date.now() >= deadline) return;
    await pause();
  }
}
