import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { nativeComposer } from './native-controls.mjs';
import { codexApprovalPrompt } from './prompt-adapter.mjs';

const execute = promisify(execFile);
export const deliveryHash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const deliveryIdentity = row => [row.id, row.tool, row.tmux_session || '', row.claude_session_id || '', row.codex_session_id || '', row.transcript_path || ''];
export const cleanPane = value => String(value || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9-]{8,100}$/.test(value);
const pause = () => new Promise(resolve => setTimeout(resolve, 180));

export async function deliveryCLI(api, row, args, timeout = 12000) {
  try {
    const { stdout } = await api.exec(api.deck, [...(row.profile ? ['-p', row.profile] : []), ...args],
      { timeout, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    if (error.stdout) { try { return JSON.parse(error.stdout); } catch {} }
    throw new Error('原投递操作未返回可确认的结果，请继续查询原回执。');
  }
}

// Agent Deck v1.16.35 uses EffectiveDataPath("runtime/send-locks", "runtime")
// and ConfigFileLock's sibling .lock. This is the same cross-process flock,
// not a second lock namespace; runtime source and live location were verified.
export async function officialSendLock(sessionId) {
  if (!identifier(sessionId)) throw new Error('会话标识无效。');
  const configured = process.env.XDG_DATA_HOME?.trim();
  const xdg = path.join(configured && path.isAbsolute(configured) ? configured : path.join(os.homedir(), '.local/share'), 'agent-deck');
  const legacy = path.join(os.homedir(), '.agent-deck');
  const exists = async file => Boolean(await fs.stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; }));
  const base = await exists(path.join(xdg, 'runtime')) ? xdg : await exists(path.join(legacy, 'runtime')) ? legacy : xdg;
  return path.join(base, 'runtime/send-locks', sessionId + '.lock');
}

export function codexQueuedInput(content, message, queued = true) {
  if (typeof message !== 'string' || !message || message.length > 1000 || /[\r\n\x00-\x1f]/.test(message)) return false;
  const raw = String(content || '').split('\n').slice(-80);
  const lines = raw.map(line => cleanPane(line).trim());
  const composer = lines.findLastIndex(line => /^›(?:\s|$)/.test(line));
  if (composer < 0 || (lines[composer + 1] || '') !== '' || codexApprovalPrompt(content)) return false;
  const value = lines[composer].replace(/^›\s*/, '');
  const headers = lines.map((line, i) => /^•?\s*Queued follow-up inputs$/.test(line) ? i : -1).filter(i => i >= 0);
  if (!queued) return headers.length === 0 && value === message;
  if (headers.length !== 1 || headers[0] >= composer) return false;
  const section = lines.slice(headers[0] + 1, composer).filter(Boolean);
  if (section.length !== 2 || section[0] !== `↳ ${message}` || section[1] !== 'shift+← edit last queued message') return false;
  const composerOnly = raw.slice(composer).join('\n').replace(/esc to interrupt/gi, 'interrupt shortcut');
  return nativeComposer('codex', composerOnly);
}

export function claudeQueuedInput(content, message) {
  if (typeof message !== 'string' || !message || message.length > 1000 || /[\r\n\x00-\x1f]/.test(message)) return false;
  const raw = String(content || '').split('\n'), lines = raw.map(line => cleanPane(line).trim());
  const hints = lines.map((line, index) => line === 'ctrl+x ctrl+s to send now' ? index : -1).filter(index => index >= 0);
  const composer = lines.findLastIndex(line => /^❯(?:\s|$)/.test(line));
  if (hints.length !== 1 || composer <= hints[0] || !/^─{5,}$/.test(lines[composer - 1] || '') ||
      !/^─{5,}$/.test(lines[composer + 1] || '') ||
      lines.slice(hints[0] + 1, composer).some(line => /^❯(?:\s|$)/.test(line))) return false;
  let queued = hints[0] - 1;
  while (queued >= 0 && !lines[queued]) queued--;
  if (lines[queued] !== `❯ ${message}`) return false;
  let previous = queued - 1;
  while (previous >= 0 && !lines[previous]) previous--;
  if (previous < 0 || /^❯(?:\s|$)/.test(lines[previous])) return false;
  const value = lines[composer].replace(/^❯\s*/, '');
  if (!value) return true;
  if (value !== 'Press up to edit queued messages') return false;
  // Current Claude draws the ghost's first character as an inverse cursor and
  // its remainder dim; a literal operator draft with the same words is rejected.
  const composerOnly = raw.slice(composer).join('\n').replace(/esc to interrupt/gi, 'interrupt shortcut')
    .replace(/\x1b\[7m(?:\x1b\[39m)?P\x1b\[0;2m/, '\x1b[2mP\x1b[0;2m');
  return nativeComposer('claude', composerOnly);
}

export async function claudeQueueProof(row, message) {
  if (!row.claude_session_id || !row.transcript_path?.endsWith('.jsonl')) return false;
  const pending = [];
  try {
    const input = createReadStream(row.transcript_path);
    const reader = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of reader) {
        if (!/"type"\s*:\s*"queue-operation"/.test(line)) continue;
        let event; try { event = JSON.parse(line); } catch { return false; }
        if (event.sessionId !== row.claude_session_id) continue;
        if (event.operation === 'enqueue' && typeof event.content === 'string') pending.push(event.content);
        else if (event.operation === 'dequeue') pending.shift();
        else return false;
      }
    } finally { reader.close(); input.destroy(); }
    return pending.length === 1 && pending[0] === message;
  } catch { return false; }
}

export async function claudeDefaultKeys(row) {
  if (row.tool !== 'claude') return true;
  if (row.account || /CLAUDE_CONFIG_DIR|--settings|--setting-sources/.test(`${row.command || ''} ${row.wrapper || ''}`)) return false;
  const config = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return !(await fs.stat(path.join(config, 'keybindings.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error; }));
}

function noInteractiveMenu(row, pane) {
  return !/approval|permission|menu|question/.test(row.substate || '') &&
    !/Enter to select|Esc to cancel|enter (?:select|default).*esc back|Review your answers|Do you want to proceed\?/.test(cleanPane(pane).split('\n').slice(-60).join('\n'));
}
function emptyComposer(row, pane) {
  const raw = String(pane || '').replace(/esc to interrupt/gi, 'interrupt shortcut');
  return nativeComposer(row.tool, raw) && !/queued|to send now|ctrl\+x.*ctrl\+s/i.test(cleanPane(pane).split('\n').slice(-20).join('\n'));
}

export function interruptibleCodex(row, pane) {
  return row.tool === 'codex' && (row.status === 'running' || row.hook_status_fresh && row.hook_status === 'running') &&
    noInteractiveMenu(row,pane) && /esc to interrupt/i.test(cleanPane(pane).split('\n').slice(-60).join('\n')) && emptyComposer(row,pane);
}

export function deliveryCapability(data, row, pane, options = {}) {
  const denied = reason => ({ canDeliverNow: false, deliverNowReason: reason, deliverNowWillInterrupt: false });
  if (data.send_id !== options.sendId || data.session_id !== row.id || (data.tool && data.tool !== row.tool)) return denied('原消息与当前会话不一致。');
  if (row.ssh_host || !['claude', 'codex'].includes(row.tool) || !['running', 'waiting'].includes(row.status)) return denied('请先确认原会话正在本机运行。');
  if (typeof data.message !== 'string' || !data.message || data.images?.length) return denied('无法完整核对原消息内容。');
  if (options.identity && deliveryHash(options.identity) !== deliveryHash(deliveryIdentity(row))) return denied('原生会话身份已变化，请核对原消息。');
  if (data.claude_session_id && data.claude_session_id !== row.claude_session_id) return denied('原消息属于另一个 Claude 对话。');
  if (!noInteractiveMenu(row, pane)) return denied('原生会话正在等待确认，请先处理当前确认。');
  if (data.state === 'landed') return denied('原消息已经进入对话。');
  if (data.settled === true) return denied('原回执已结束，送达结果未确认。');
  if (data.state === 'typing') return denied('原队列正在投递这条消息，请等待原回执更新。');
  if (['failed', 'cancelled'].includes(data.state)) return denied('原消息已结束，不能重新释放该回执。');
  const busy = row.status === 'running' && /esc to interrupt/i.test(cleanPane(pane).split('\n').slice(-70).join('\n'));
  if (row.status === 'running' && !busy && row.substate !== 'background-work') return denied('当前运行阶段尚未确认，暂不发送中断按键。');
  if (data.state === 'queued') {
    if (!emptyComposer(row, pane)) return denied('原生输入框有草稿或队列，请先核对输入。');
    const pending = (row.queue || []).filter(item => ['queued', 'typing'].includes(item.state));
    if (!pending.some(item => item.id === data.send_id) || pending[0].id !== data.send_id) return denied('请先处理原队列中更早的消息。');
    return { canDeliverNow: true, deliverNowWillInterrupt: busy, mode: busy ? 'interrupt-release' : 'release',
      deliverNowReason: busy ? '将中断当前回合，并通过原队列投递这条消息。' : '立即释放原队列中的这条消息。' };
  }
  if (!['typed', 'submitted'].includes(data.state)) return denied('原消息投递状态尚未确定。');
  if (row.tool === 'codex' && codexQueuedInput(pane, data.message)) {
    return { canDeliverNow: true, deliverNowWillInterrupt: busy, mode: 'codex-native',
      deliverNowReason: busy ? '将中断当前回合，再提交已核对的唯一原生排队消息。' : '提交已核对的唯一原生排队消息。' };
  }
  if (row.tool === 'claude' && options.defaultKeys && (!options.strictQueue || options.queueProof) && claudeQueuedInput(pane, data.message)) {
    return { canDeliverNow: true, deliverNowWillInterrupt: busy, mode: 'claude-native',
      deliverNowReason: '立即提交已核对的唯一原生排队消息，可能中断当前回合。' };
  }
  return denied('无法确认唯一原生队列与原消息一致，请在独立终端核对。');
}

export async function deliveredInTranscript(row, data) {
  if (data.session_id !== row.id) return false;
  if (!['typed', 'submitted'].includes(data.state) || typeof data.message !== 'string' || !row.transcript_path?.endsWith('.jsonl')) return false;
  if (data.transcript_path && data.transcript_path !== row.transcript_path) return false;
  const since = Date.parse(data.sent_at || data.created_at);
  if (!Number.isFinite(since)) return false;
  const handle = await fs.open(row.transcript_path, 'r').catch(() => null);
  if (!handle) return false;
  try {
    const stat = await handle.stat(), size = Math.min(stat.size, 4 * 1024 * 1024);
    const bytes = Buffer.alloc(size), start = stat.size - size;
    await handle.read(bytes, 0, size, start);
    const lines = bytes.toString('utf8').split('\n');
    let offset = start;
    for (const [index, line] of lines.entries()) {
      const current = offset; offset += Buffer.byteLength(line) + 1;
      if ((start && index === 0) || (Number.isFinite(data.transcript_from) && current < data.transcript_from)) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const timestamp = Date.parse(record.timestamp);
      if (!Number.isFinite(timestamp) || timestamp < since) continue;
      const message = row.tool === 'codex' && record.type === 'response_item' ? record.payload
        : row.tool === 'claude' && record.type === 'user' && !record.isSidechain && !record.isMeta ? record.message : null;
      if (message?.role !== 'user') continue;
      const content = message.content;
      const text = typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter(part => ['text', 'input_text'].includes(part.type)).map(part => part.text || '').join('\n') : '';
      if (text === data.message) return true;
    }
    return false;
  } finally { await handle.close(); }
}

export async function lockedDelivery(request, api) {
  let keySent = false, interrupted = false, actionStarted = false;
  let current;
  const read = async () => {
    const row = await api.session(request.sessionId);
    if (deliveryHash(deliveryIdentity(row)) !== deliveryHash(request.identity)) throw new Error('原生会话身份已变化，已停止投递。');
    const data = await deliveryCLI(api, row, ['session', 'send-status', request.sendId, '--json']);
    if (data.send_id !== request.sendId || data.session_id !== row.id || deliveryHash(data.message) !== request.messageHash) throw new Error('原消息回执或内容已变化。');
    const output = await deliveryCLI(api, row, ['session', 'output', row.id, '--pane', '--primary', '--json']);
    if (!output.success || output.session_id !== row.id) throw new Error('无法确认原会话主终端。');
    return { row, data, pane: output.content || '', defaultKeys: await claudeDefaultKeys(row),
      queueProof: row.tool === 'claude' && ['typed', 'submitted'].includes(data.state) ? await claudeQueueProof(row, data.message) : false };
  };
  const capability = item => deliveryCapability(item.data, item.row, item.pane,
    { sendId: request.sendId, identity: request.identity, defaultKeys: item.defaultKeys, strictQueue: true, queueProof: item.queueProof });
  const sendKey = async key => {
    actionStarted = true;
    const result = await deliveryCLI(api, current.row, ['session', 'send-keys', request.sessionId,
      ...(key === 'Enter' ? ['--enter'] : ['--named-key', key]), '--primary', '--json']);
    if (!result.success || result.session_id !== request.sessionId) throw new Error('按键送达结果尚未确认。');
    keySent = true;
  };
  try {
    current = await read();
    if (current.data.state === 'landed' || await deliveredInTranscript(current.row, current.data)) return { outcome: 'delivered', keySent: false, interrupted: false };
    let gate = capability(current);
    if (!gate.canDeliverNow) return { outcome: 'refused', keySent: false, interrupted: false, reason: gate.deliverNowReason };
    if (gate.mode === 'interrupt-release' || (gate.mode === 'codex-native' && gate.deliverNowWillInterrupt)) {
      current = await read(); gate = capability(current);
      if (!gate.canDeliverNow || !gate.deliverNowWillInterrupt) return { outcome: 'refused', keySent: false, interrupted: false, reason: '当前回合或队列已经变化，请刷新后核对。' };
      await sendKey('Escape'); interrupted = true;
      for (let attempt = 0; attempt < 8; attempt++) {
        await pause(); current = await read();
        if (current.data.state === 'landed' || await deliveredInTranscript(current.row, current.data)) return { outcome: 'delivered', keySent, interrupted };
        if (current.row.status === 'waiting' && !/esc to interrupt/i.test(cleanPane(current.pane))) break;
      }
      if (current.row.status !== 'waiting' || /esc to interrupt/i.test(cleanPane(current.pane))) throw new Error('中断后尚未确认会话空闲；不会再次发送中断或消息。');
    }
    if (['release', 'interrupt-release'].includes(gate.mode)) {
      if (!['queued', 'typing'].includes(current.data.state)) return { outcome: 'observe', keySent, interrupted };
      if (!emptyComposer(current.row, current.pane) || !noInteractiveMenu(current.row, current.pane)) throw new Error('当前输入状态已变化，原消息仍由原队列管理。');
      return { outcome: 'release', keySent, interrupted };
    }
    if (gate.mode === 'codex-native') {
      current = await read();
      if (!capability(current).canDeliverNow || current.row.status !== 'waiting' || !codexQueuedInput(current.pane, current.data.message)) throw new Error('原生排队消息已变化，未重新提交。');
      await sendKey('S-Left'); await pause(); current = await read();
      if (current.row.status !== 'waiting' || !noInteractiveMenu(current.row, current.pane) || !codexQueuedInput(current.pane, current.data.message, false)) throw new Error('原消息恢复后未通过完整核对，未发送 Enter。');
      await sendKey('Enter');
      return { outcome: 'observe', keySent, interrupted };
    }
    if (gate.mode === 'claude-native') {
      current = await read();
      if (!capability(current).canDeliverNow || !current.defaultKeys || !claudeQueuedInput(current.pane, current.data.message)) throw new Error('Claude 原生队列或默认按键已变化。');
      await sendKey('C-x');
      // Both halves remain under the official send flock and the app control lock.
      await sendKey('C-s');
      return { outcome: 'observe', keySent, interrupted: gate.deliverNowWillInterrupt };
    }
    throw new Error('没有可核验的立即投递路径。');
  } catch (error) {
    return { outcome: actionStarted ? 'unknown' : 'refused', keySent: actionStarted && !keySent ? null : keySent,
      interrupted, reason: error.message };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const request = JSON.parse(process.argv[2]);
    if (!identifier(request.sessionId) || !identifier(request.sendId) || typeof request.deck !== 'string' || !path.isAbsolute(request.deck)) throw new Error('无效的投递请求。');
    const api = { deck: request.deck, exec: execute, session: id => deliveryCLI(api, request, ['session', 'show', id, '--json']) };
    process.stdout.write(JSON.stringify(await lockedDelivery(request, api)) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ outcome: 'refused', keySent: false, reason: error.message }) + '\n'); }
}
