import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { acquireNativeControl, nativeComposer, sendVerifiedMenuKey } from './native-controls.mjs';

const receipts = path.join(os.homedir(), '.local/share/agent-deck/chat-receipts/models');
const active = new Map();
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9-]{8,100}$/.test(value);
const clean = value => String(value || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
const normalized = value => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pause = () => new Promise(resolve => setTimeout(resolve, 180));
const identity = row => [row.id, row.tool, row.tmux_session, row.claude_session_id, row.codex_session_id, row.transcript_path];
const filename = (id, requestId) => path.join(receipts, hash([id, requestId]) + '.json');

// Observed in the tool-disabled Claude 2.1.316 native /model menu, including
// every effort boundary. The live menu is checked again before any selection.
// Evidence: work/inline-confirmation/smoke/claude-native-catalog.json.
export const claudeModels = [
  ['Opus 5.5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['Sonnet 5.5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['Fable 5.1', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['Haiku 5.5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['Haiku 4.5', []],
  ['Sonnet 5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['Opus 5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['Fable 5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['Opus 4.8', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['Opus 4.7', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['Opus 4.6', ['low', 'medium', 'high', 'max']],
  ['Sonnet 4.6', ['low', 'medium', 'high', 'max']],
].map(([label, reasoningEfforts]) => ({ value: 'claude-' + label.toLowerCase().replace(/[ .]/g, '-'), label, reasoningEfforts }));

async function cli(api, row, args) {
  try {
    const { stdout } = await api.exec(api.deck, [...(row.profile ? ['-p', row.profile] : []), ...args],
      { timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    if (error.stdout) { try { return JSON.parse(error.stdout); } catch {} }
    throw new Error('原生会话未返回可确认的结果，请查询原请求。');
  }
}
async function pane(row, api) {
  const result = await cli(api, row, ['session', 'output', row.id, '--pane', '--primary', '--json']);
  if (!result.success || (result.session_id && result.session_id !== row.id)) throw new Error('无法读取原会话主终端。');
  return result.content || '';
}
async function catalog(row) {
  if (row.tool === 'claude') return claudeModels;
  const cache = JSON.parse(await fs.readFile(path.join(row.resolved_codex_home || path.join(os.homedir(), '.codex'), 'models_cache.json'), 'utf8'));
  return (cache.models || []).filter(model => /^gpt-[a-z0-9.-]+$/.test(model.slug) && model.visibility === 'list')
    .map(model => ({ value: model.slug, label: model.display_name || model.slug,
      reasoningEfforts: (model.supported_reasoning_levels || []).map(level => level.effort)
        .filter(level => ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(level)) }));
}

export function modelCurrent(tool, content, models) {
  const lines = clean(content).split('\n');
  let model, effort;
  if (tool === 'codex') {
    for (const line of lines) {
      for (const candidate of models) {
        const match = line.match(new RegExp('^\\s*' + escape(candidate.label) + '\\s+(minimal|low|medium|high|xhigh|max|ultra)\\s*·', 'i'));
        if (match) { model = candidate; effort = match[1].toLowerCase(); }
      }
    }
  } else {
    for (const line of lines) {
      const header = line.match(/^[▝▜▐▀█].*?\b((?:Opus|Sonnet|Haiku|Fable) \d+(?:\.\d+)?)(?: with (low|medium|high|xhigh|max) effort)?\s*·/i);
      const changed = line.match(/Set model to ((?:Opus|Sonnet|Haiku|Fable) \d+(?:\.\d+)?) for this session only(?: with (low|medium|high|xhigh|max) effort)?/i);
      const match = changed || header;
      if (match) {
        const candidate = models.find(item => normalized(item.label) === normalized(match[1]));
        if (candidate) { model = candidate; effort = match[2]?.toLowerCase() || (candidate.reasoningEfforts.length ? undefined : ''); }
      }
    }
    // A live footer overrides any older local-command output still in scrollback.
    const footer = lines.findLast(line => /^\s*(?:Opus|Sonnet|Haiku|Fable) \d+(?:\.\d+)?\s*\|/.test(line));
    if (footer) {
      const candidate = models.find(item => footer.trim().startsWith(item.label + ' |'));
      if (candidate) { model = candidate; effort = candidate.reasoningEfforts.length ? undefined : ''; }
    }
    const composer = lines.findLastIndex(line => /^\s*❯(?:\s|$)/.test(line) && !/^\s*❯\s*\d+\./.test(line));
    const badge = (composer < 0 ? [] : lines.slice(Math.max(0, composer - 4), composer + 1))
      .map(line => line.match(/(?:◐|●|◉|○)\s*(low|medium|high|xhigh|max)\s*·\s*\/effort/i)).filter(Boolean).at(-1);
    if (badge && model) effort = badge[1].toLowerCase();
  }
  const verified = Boolean(model && (model.reasoningEfforts.length ? model.reasoningEfforts.includes(effort) : effort === ''));
  return { modelId: model?.value || '', reasoningEffort: effort || '', verified };
}

// A request's recorded effort proves what that request used, not a future
// session default. Keep this evidence separate from live-screen verification.
export async function claudeEffortEvidence(row, modelId) {
  if (row.tool !== 'claude' || !modelId || !row.claude_session_id || !row.transcript_path?.endsWith('.jsonl') || !path.isAbsolute(row.transcript_path)) return null;
  const file = await fs.open(row.transcript_path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return null;
    const size = Math.min(stat.size, 2 * 1024 * 1024), start = stat.size - size;
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await file.read(buffer, 0, size, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start) text = text.slice(text.indexOf('\n') + 1);
    if (!text.endsWith('\n')) return null;
    let turnEnded = false;
    for (const line of text.split('\n').reverse()) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { return null; }
      if (record.isSidechain || record.isMeta || record.isCompactSummary) continue;
      if (record.type === 'system' && ['compact_boundary', 'api_error'].includes(record.subtype)) return null;
      if (record.type === 'user') {
        const content = record.message?.content;
        if (Array.isArray(content) && content.length && content.every(block => block.type === 'tool_result')) continue;
        return null; // A new user turn or local model/effort command supersedes older evidence.
      }
      if (!['assistant', 'api-request'].includes(record.type)) continue;
      if ((record.sessionId || record.session_id) !== row.claude_session_id ||
          (record.sessionId && record.session_id && record.sessionId !== record.session_id)) return null;
      const model = record.type === 'assistant' ? record.message?.model : record.params?.model;
      if (model !== modelId) return null;
      if (['end_turn', 'stop_sequence'].includes(record.message?.stop_reason)) turnEnded = true;
      const value = record.type === 'assistant' ? record.perTurnEffort || record.effort : record.params?.output_config?.effort;
      if (['low', 'medium', 'high', 'xhigh', 'max'].includes(value) && Number.isFinite(Date.parse(record.timestamp))) {
        return { modelId, reasoningEffort: value, timestamp: record.timestamp,
          scope: !turnEnded && row.status === 'running' && row.substate !== 'background-work' ? 'current-turn' : 'last-request' };
      }
      if (record.type === 'api-request') return null;
    }
    return null;
  } finally { await file.close(); }
}

// statusLine's effort.level is Claude's current session setting. It is separate
// from per-turn skill/ultrathink overrides recorded in the transcript.
export async function claudeSessionCurrent(row, models, directory = path.join(os.homedir(), '.local/share/agent-deck/runtime/claude-status'), primaryPane) {
  if (row.tool !== 'claude' || !identifier(row.claude_session_id) || !row.transcript_path ||
      ['stopped', 'error', 'starting'].includes(row.status) || !/^%\d+$/.test(primaryPane?.id || '') ||
      !Number.isSafeInteger(primaryPane.pid) || !path.isAbsolute(primaryPane.socket || '')) return null;
  const record = JSON.parse(await fs.readFile(path.join(directory, row.claude_session_id + '-pane-' + primaryPane.id.slice(1) + '.json'), 'utf8'));
  if (record.sessionId !== row.claude_session_id || record.transcriptPath !== row.transcript_path ||
      record.tmuxPane !== primaryPane.id || record.tmuxSocket !== primaryPane.socket ||
      !Number.isFinite(record.capturedAt) || record.capturedAt > Date.now() + 5000) return null;
  const native = record.process;
  if (!Number.isSafeInteger(native?.pid) || native.pid < 2 || !/^\d+$/.test(native.startTicks || '')) return null;
  const [stat, boot, executable] = await Promise.all([
    fs.readFile(`/proc/${native.pid}/stat`, 'utf8'),
    fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    fs.readlink(`/proc/${native.pid}/exe`),
  ]);
  const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  if (fields[0] === 'Z' || fields[19] !== native.startTicks || boot.trim() !== native.bootId ||
      !(path.basename(executable) === 'claude' || /\/claude\/versions\/[^/]+$/.test(executable))) return null;
  let owner = native.pid, parent = Number(fields[1]);
  for (let count = 0; owner !== primaryPane.pid && parent > 1 && count < 12; count++) {
    owner = parent;
    const ancestor = await fs.readFile(`/proc/${owner}/stat`, 'utf8');
    parent = Number(ancestor.slice(ancestor.lastIndexOf(')') + 1).trim().split(/\s+/)[1]);
  }
  if (owner !== primaryPane.pid) return null;
  const model = models.find(item => item.value === record.modelId);
  if (!model) return null;
  if (model.reasoningEfforts.length && !model.reasoningEfforts.includes(record.reasoningEffort)) return null;
  return { modelId: model.value, reasoningEffort: model.reasoningEfforts.length ? record.reasoningEffort : '',
    verified: true, source: 'native-statusline', capturedAt: record.capturedAt };
}

async function nativeSessionCurrent(row, models, api) {
  if (row.tool !== 'claude' || !row.tmux_session || ['stopped', 'error', 'starting'].includes(row.status)) return null;
  // Same managed first-window pane used by the existing desktop file bridge.
  const { stdout } = await api.exec('tmux', ['-L', 'agent-deck', 'list-panes', '-t', row.tmux_session + ':0',
    '-F', '#{pane_id}\t#{pane_pid}\t#{socket_path}'], { timeout: 3000, maxBuffer: 16384 });
  const [id, pid, socket] = stdout.trim().split('\n')[0].split('\t');
  return claudeSessionCurrent(row, models, undefined, { id, pid: Number(pid), socket });
}

export function modelComposer(tool, content, expected = null) {
  if (tool === 'claude' && expected === '/model') {
    // Claude 2.1.316 also renders the known argument hint in palette gray,
    // without SGR dim. Normalize only that exact hint, never an operator draft.
    const lines = String(content || '').split('\n');
    const index = lines.findLastIndex(line => /^\s*❯\s*\/model\s+\[model\]\s*$/.test(clean(line)));
    if (index >= 0) lines[index] = lines[index].replace(/\x1b\[38;5;246m(?:\x1b\[49m)*\[model\](?=\x1b\[(?:39|0)m)/, '\x1b[2m[model]\x1b[22m');
    content = lines.join('\n');
  }
  return !modelMenu(tool, content) && nativeComposer(tool, content, expected);
}

export function modelMenu(tool, content) {
  const lines = clean(content).split('\n');
  const title = lines.findLastIndex(line => tool === 'claude' ? line.trim() === 'Select model'
    : /^\s*(?:Select Model and Effort|Select Reasoning Level for .+|Advanced Reasoning)\s*$/.test(line));
  if (title < 0) return null;
  const section = lines.slice(title);
  const footer = section.findIndex(line => tool === 'claude' ? /s to use this session only.*Esc to cancel/.test(line)
    : /(?:enter (?:default|select).*esc back)/.test(line));
  if (footer < 0 || section.slice(footer + 1).some(line => /^\s*[›❯](?:\s|$)/.test(line))) return null;
  const rows = section.slice(1, footer).flatMap(line => {
    const match = line.match(/^\s*([❯›↑↓]\s*)?(\d+)\.\s+(.+?)\s{2,}(.+?)\s*$/);
    if (!match) return [];
    let label = match[3].replace(/\s*✔/g, '').replace(/\s*\((?:current|default)\)/g, '').trim();
    // Some native catalogs abbreviate the row to "Opus" and put its exact
    // version first in the description. Require that same family and version.
    const version = tool === 'claude' && /^(?:Opus|Sonnet|Haiku|Fable)$/.test(label)
      ? match[4].match(new RegExp('^' + label + ' \\d+(?:\\.\\d+)?(?=\\s|$)'))?.[0] : null;
    if (version) label = version;
    return [{ number: Number(match[2]), label, selected: /^[❯›]/.test(match[1] || '') }];
  });
  if (!rows.length || rows.filter(row => row.selected).length !== 1) return null;
  const effort = section.join('\n').match(/\b(Low|Medium|High|xHigh|Max) effort(?: \(default\))? ←\/→ to adjust/i)?.[1]?.toLowerCase() || '';
  const kind = tool === 'claude' || section[0].trim() === 'Select Model and Effort' ? 'model'
    : section[0].trim() === 'Advanced Reasoning' ? 'advanced' : 'effort';
  return { kind, title: section[0].trim(), rows, selected: rows.find(row => row.selected), effort,
    sessionOnly: tool === 'claude' || /s session/.test(section[footer]) };
}

function ready(row, raw) {
  return !row.ssh_host && ['claude', 'codex'].includes(row.tool) &&
    !['stopped', 'error', 'starting'].includes(row.status) &&
    (row.status === 'waiting' || row.substate === 'background-work') &&
    !(row.hook_status_fresh && row.hook_status === 'running') &&
    !(row.queue || []).some(item => ['queued', 'typing', 'typed', 'submitted'].includes(item.state)) && modelComposer(row.tool, raw);
}
async function snapshot(id, api) {
  if (!identifier(id)) throw new Error('会话标识无效。');
  const row = await api.session(id);
  if (row.id !== id || row.ssh_host || !['claude', 'codex'].includes(row.tool)) throw new Error('模型切换支持本机 Claude 和 Codex 会话。');
  const models = await catalog(row).catch(() => []);
  const raw = ['stopped', 'error', 'starting'].includes(row.status) ? '' : await pane(row, api);
  const screenCurrent = modelCurrent(row.tool, raw, models);
  const sessionCurrent = await nativeSessionCurrent(row, models, api).catch(() => null);
  const current = sessionCurrent && (!screenCurrent.modelId || screenCurrent.modelId === sessionCurrent.modelId) ? sessionCurrent : screenCurrent;
  const effortEvidence = await claudeEffortEvidence(row, current.modelId).catch(() => null);
  const canChange = models.length > 0 && ready(row, raw);
  return { row, raw, sessionId: id, tool: row.tool, models, current, effortEvidence, canChange,
    reason: canChange ? '' : models.length ? '会话空闲且原生输入框为空时可以切换模型。' : '当前可用模型目录尚未读取，请刷新后再试。',
    revision: hash([identity(row), current.modelId, current.reasoningEffort, current.verified, canChange]) };
}
function visibleSnapshot({ row, raw, ...visible }) { return visible; }
async function save(record) {
  const file = filename(record.sessionId, record.requestId), temporary = file + '.' + crypto.randomUUID() + '.tmp';
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, file);
}
async function load(id, requestId) {
  if (!identifier(id) || !identifier(requestId)) throw new Error('模型请求标识无效。');
  const record = JSON.parse(await fs.readFile(filename(id, requestId), 'utf8'));
  if (record.sessionId !== id || record.requestId !== requestId) throw new Error('模型请求不属于当前会话。');
  return record;
}
const isActive = record => active.get(record.sessionId)?.requestId === record.requestId;
const beforeModelEnter = record => record.stage === 'commandDraft' && record.commitAttempted === false ||
  !record.stage && record.message === '原生模型命令尚未通过核对，未发送 Enter。';
function canClearDraft(record, state) {
  return beforeModelEnter(record) && !record.clearDraft && !isActive(record) && record.status !== 'succeeded' &&
    hash(identity(state.row)) === hash(record.identity) && state.row.status === 'waiting' &&
    !(state.row.hook_status_fresh && state.row.hook_status === 'running') &&
    !(state.row.queue || []).some(item => ['queued', 'typing', 'typed', 'submitted'].includes(item.state)) &&
    modelComposer(state.tool, state.raw, '/model');
}
function requestView(record, state) {
  const sameNative = hash(identity(state.row)) === hash(record.identity);
  const matched = sameNative && state.current.verified && state.current.modelId === record.modelId && state.current.reasoningEffort === record.reasoningEffort;
  const requestActive = isActive(record);
  let requestStatus = record.status;
  let message = record.clearDraft?.message || record.message || '';
  if (matched && record.keySent !== false && record.commitAttempted !== false && !beforeModelEnter(record) && !record.clearDraft && !requestActive) requestStatus = 'succeeded';
  else if (requestStatus === 'pending' && !requestActive) requestStatus = 'unknown';
  else if (requestStatus === 'succeeded' && !matched) {
    requestStatus = 'unknown';
    message = !sameNative ? '原生会话已变化，请核对当前会话的模型设置。' : state.current.verified
      ? '当前模型或强度与这次请求不同，请核对当前设置。' : '原请求有完成记录，当前模型状态尚未重新核实，请刷新核对。';
  }
  if (record.clearDraft?.state === 'succeeded') requestStatus = 'failed';
  if (record.clearDraft && record.clearDraft.state !== 'succeeded') requestStatus = requestActive ? 'pending' : 'unknown';
  return { requestId: record.requestId, requestStatus, keySent: record.keySent,
    requestActive, stage: record.stage, commitAttempted: record.commitAttempted,
    canClearDraft: requestStatus !== 'succeeded' && canClearDraft(record, state),
    draftCleared: record.clearDraft?.state === 'succeeded',
    verified: requestStatus === 'succeeded' && matched, message };
}

// Drive only menus observed after our exact /model command. "s" is used at
// the final selection in both CLIs; Enter there would change shared defaults.
export async function applyNativeModel(tool, target, io) {
  let raw = await io.read();
  if (!modelComposer(tool, raw)) throw new Error('原生输入框不为空或正在等待交互。');
  await io.stage?.('commandDraft');
  await io.send(['--text', '/model ']);
  await io.pause(); raw = await io.read();
  if (!modelComposer(tool, raw, '/model')) throw new Error('原生模型命令尚未通过核对，未发送 Enter。');
  await io.stage?.('menu');
  await io.send(['--named-key', 'Enter']);
  let menu;
  for (let attempt = 0; attempt < 5; attempt++) {
    await io.pause(); raw = await io.read(); menu = modelMenu(tool, raw);
    if (menu?.kind === 'model') break;
  }
  if (!menu || menu.kind !== 'model') throw new Error('没有检测到原生模型菜单，操作已停止。');
  const menuState = value => JSON.stringify([value.kind, value.title, value.rows, value.effort, value.sessionOnly]);
  async function press(args, changingStage = false) {
    const before = modelMenu(tool, await io.read());
    if (!before || menuState(before) !== menuState(menu)) throw new Error('原生菜单已被其他操作改变，操作已停止。');
    await io.send(args, { verifiedMenu: true }); await io.pause(); raw = await io.read();
    let after = modelMenu(tool, raw);
    for (let attempt = 0; !after && !modelComposer(tool, raw) && attempt < 3; attempt++) {
      await io.pause(); raw = await io.read(); after = modelMenu(tool, raw);
    }
    if (!changingStage && (!after || after.kind !== menu.kind || after.title !== menu.title)) throw new Error('原生菜单状态未通过核对。');
    menu = after;
  }
  async function move(number) {
    for (let steps = 0; menu.selected.number !== number && steps < 32; steps++) {
      const previous = menu.selected.number, delta = number > previous ? 1 : -1;
      await press(['--named-key', delta > 0 ? 'Down' : 'Up']);
      if (menu.selected.number !== previous + delta) throw new Error('未能确认模型选项位置。');
    }
    if (menu.selected.number !== number) throw new Error('原生菜单中没有目标选项。');
  }
  const visible = menu.rows.find(row => normalized(row.label) === normalized(target.label));
  if (visible) await move(visible.number);
  else {
    // Start at the first model only when the target is outside the visible rows.
    await move(1);
    for (let steps = 0; normalized(menu.selected.label) !== normalized(target.label) && steps < 30; steps++) {
      const previous = menu.selected.number;
      await press(['--named-key', 'Down']);
      if (menu.selected.number <= previous) throw new Error('原生菜单未提供所选模型。');
    }
  }
  if (normalized(menu.selected.label) !== normalized(target.label)) throw new Error('原生菜单未提供所选模型。');
  if (tool === 'claude') {
    if (!target.reasoningEfforts.length && menu.effort) throw new Error('此模型的强度选项已变化，请重新核对。');
    for (let steps = 0; menu.effort !== target.reasoningEffort && steps < 8; steps++) {
      const from = target.reasoningEfforts.indexOf(menu.effort), to = target.reasoningEfforts.indexOf(target.reasoningEffort);
      if (from < 0 || to < 0) throw new Error('原生模型不支持所选强度。');
      await press(['--named-key', to > from ? 'Right' : 'Left']);
      if (menu.effort !== target.reasoningEfforts[from + (to > from ? 1 : -1)]) throw new Error('原生强度范围已变化，操作已停止。');
    }
    if (menu.effort !== target.reasoningEffort || !menu.sessionOnly) throw new Error('未能确认仅当前会话的模型设置。');
    await io.stage?.('commit');
    await press(['--text', 's'], true);
  } else {
    await press(['--named-key', 'Enter'], true);
    if (!menu || menu.kind !== 'effort' || !menu.title.endsWith(target.label)) throw new Error('未能确认目标模型的推理强度菜单。');
    const names = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };
    let option = menu.rows.find(row => row.label === names[target.reasoningEffort]);
    if (!option && ['max', 'ultra'].includes(target.reasoningEffort)) {
      const more = menu.rows.find(row => row.label === 'More reasoning…');
      if (!more) throw new Error('原生模型没有提供所选高级强度。');
      await move(more.number); await press(['--named-key', 'Enter'], true);
      if (!menu || menu.kind !== 'advanced') throw new Error('高级强度菜单未通过核对。');
      option = menu.rows.find(row => row.label === names[target.reasoningEffort]);
    }
    if (!option) throw new Error('原生模型没有提供所选推理强度。');
    await move(option.number);
    if (!menu.sessionOnly) throw new Error('原生菜单没有当前会话专用的选择方式。');
    await io.stage?.('commit');
    await press(['--text', 's'], true);
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    const current = await io.current?.() || modelCurrent(tool, raw, [target]);
    if (modelComposer(tool, raw) && current.verified && current.modelId === target.value && current.reasoningEffort === target.reasoningEffort) return current;
    await io.pause(); raw = await io.read();
  }
  throw new Error('原生模型设置结果尚未确认，请查询原请求。');
}

async function run(record, state, api) {
  try {
    const target = state.models.find(model => model.value === record.modelId);
    const read = async () => {
      const row = await api.session(record.sessionId);
      if (hash(identity(row)) !== hash(record.identity) || row.ssh_host ||
          (row.status !== 'waiting' && row.substate !== 'background-work') ||
          (row.hook_status_fresh && row.hook_status === 'running')) throw new Error('原生会话身份或运行状态已变化，设置已停止。');
      return pane(row, api);
    };
    const current = await applyNativeModel(state.tool, { ...target, reasoningEffort: record.reasoningEffort }, {
      read, pause,
      stage: async stage => { record.stage = stage; if (stage === 'commit') record.commitAttempted = true; await save(record); },
      current: async () => {
        const actual = await api.session(record.sessionId);
        if (hash(identity(actual)) !== hash(record.identity)) throw new Error('原生会话身份已变化，设置核对已停止。');
        return nativeSessionCurrent(actual, state.models, api).catch(() => null);
      },
      send: async (args, context) => {
        record.keySent = null; await save(record);
        const result = context?.verifiedMenu && args[0] === '--named-key'
          ? await sendVerifiedMenuKey(state.row, args[1], api)
          : await cli(api, state.row, ['session', 'send-keys', record.sessionId, ...args, '--primary', '--json']);
        if (!result.success || (result.session_id && result.session_id !== record.sessionId)) throw new Error('按键送达结果未确认。');
        record.keySent = true;
      },
    });
    record.status = 'succeeded'; record.current = current; record.message = '已切换当前会话的模型与强度。';
  } catch (error) {
    record.status = record.keySent === false || record.commitAttempted === false ? 'failed' : 'unknown'; record.message = error.message;
  } finally { await save(record); }
}

async function clearModelDraft(body, api) {
  if (!identifier(body.sessionId) || !identifier(body.requestId)) throw new Error('模型请求标识无效。');
  const record = await load(body.sessionId, body.requestId);
  let state = await snapshot(body.sessionId, api);
  let view = requestView(record, state);
  if (view.requestStatus === 'succeeded' || record.clearDraft) return { code: 200,
    body: { success: true, ...visibleSnapshot(state), ...view } };
  if (!view.canClearDraft) return { code: 409, body: { ...visibleSnapshot(state), ...view,
    error: '当前输入不再是这次设置留下的未提交命令，请在独立终端核对。' } };
  const release = acquireNativeControl(record.sessionId);
  if (!release) return { code: 409, body: { ...visibleSnapshot(state), ...view,
    error: '当前会话还有其他输入操作，请等待完成。' } };
  try {
    state = await snapshot(record.sessionId, api);
    if (!canClearDraft(record, state)) throw new Error('原会话或未提交命令已变化，清理已停止。');
    record.clearDraft = { state: 'pending', keySent: null, message: '正在清除已核对的未提交模型命令。' };
    await save(record);
    const operation = (async () => {
      try {
        const result = await cli(api, state.row, ['session', 'send-keys', record.sessionId, '--named-key', 'C-u', '--primary', '--json']);
        if (!result.success || result.session_id !== record.sessionId) throw new Error('清除按键结果尚未确认，不会重复发送。');
        record.clearDraft.keySent = true;
        await pause();
        const actual = await snapshot(record.sessionId, api);
        if (hash(identity(actual.row)) !== hash(record.identity) || !modelComposer(actual.tool, actual.raw)) throw new Error('清理后的原生输入状态尚未确认，请在独立终端核对。');
        record.clearDraft.state = 'succeeded';
        record.clearDraft.message = '已清除未提交的模型命令，可重新选择模型与强度。';
        record.status = 'failed';
      } catch (error) {
        record.clearDraft.state = 'unknown'; record.clearDraft.message = error.message;
      } finally { await save(record); }
    })().finally(() => { active.delete(record.sessionId); release(); });
    active.set(record.sessionId, { requestId: record.requestId, promise: operation });
    return { code: 202, body: { success: true, ...visibleSnapshot(state), ...requestView(record, state) } };
  } catch (error) { release(); return { code: 409, body: { ...visibleSnapshot(state), ...requestView(record, state), error: error.message } }; }
}

export async function handleModel(req, res, url, api) {
  if (!['/desktop/chat/models', '/desktop/chat/model', '/desktop/chat/model/clear-draft'].includes(url.pathname)) return false;
  const reply = (code, body) => { api.reply(res, code, body); return true; };
  try {
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      const id = url.searchParams.get('sessionId'), operation = active.get(id);
      let state = await snapshot(id, api);
      const requestId = url.searchParams.get('requestId');
      if (!requestId) return reply(200, visibleSnapshot(state));
      let record = await load(id, requestId);
      // A worker can finish while this read is awaiting the pane or receipt.
      // Re-read once so an old pending record cannot become an inactive unknown.
      if (operation && active.get(id) !== operation) { state = await snapshot(id, api); record = await load(id, requestId); }
      return reply(200, { ...visibleSnapshot(state), ...requestView(record, state) });
    }
    if (req.method !== 'POST' || url.pathname.endsWith('/models') || req.headers['x-agentdeck-desktop'] !== '1') {
      return reply(403, { error: '请从本地模型设置界面操作。', keySent: false });
    }
    const body = await api.bodyJSON(req);
    if (url.pathname.endsWith('/clear-draft')) {
      const result = await clearModelDraft(body, api);
      return reply(result.code, result.body);
    }
    if (!identifier(body.sessionId) || !identifier(body.requestId)) throw new Error('模型请求标识无效。');
    const previous = await load(body.sessionId, body.requestId).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (previous) {
      if (previous.modelId !== body.modelId || previous.reasoningEffort !== body.reasoningEffort) throw new Error('同一请求标识不能用于不同模型设置。');
      const state = await snapshot(body.sessionId, api);
      return reply(200, { success: true, ...visibleSnapshot(state), ...requestView(previous, state) });
    }
    const release = acquireNativeControl(body.sessionId);
    if (!release) return reply(409, { error: '当前会话还有原生操作正在处理，请等待完成。', keySent: false });
    let started = false;
    try {
      const state = await snapshot(body.sessionId, api);
      const target = state.models.find(model => model.value === body.modelId);
      if (!target || !(/^claude-/.test(body.modelId) && state.tool === 'claude' || /^gpt-/.test(body.modelId) && state.tool === 'codex') ||
          typeof body.reasoningEffort !== 'string' || (target.reasoningEfforts.length ? !target.reasoningEfforts.includes(body.reasoningEffort) : body.reasoningEffort !== '')) {
        return reply(400, { error: '请选择当前助手支持的模型与强度。', keySent: false });
      }
      if (!state.canChange || (body.revision && body.revision !== state.revision)) return reply(409, {
        error: state.canChange ? '会话模型状态已变化，请刷新后重新选择。' : state.reason, keySent: false, ...visibleSnapshot(state) });
      const record = { sessionId: body.sessionId, requestId: body.requestId, modelId: body.modelId,
        reasoningEffort: body.reasoningEffort, identity: identity(state.row), status: 'pending', keySent: false,
        stage: 'reserved', commitAttempted: false };
      await fs.mkdir(receipts, { recursive: true, mode: 0o700 });
      const handle = await fs.open(filename(record.sessionId, record.requestId), 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
      const operation = run(record, state, api).catch(() => {}).finally(() => { active.delete(record.sessionId); release(); });
      active.set(record.sessionId, { requestId: record.requestId, promise: operation }); started = true;
      return reply(202, { success: true, verified: false, requestId: record.requestId, requestStatus: 'pending', keySent: false,
        requestActive: true, canClearDraft: false, draftCleared: false,
        current: state.current, message: '正在核对并应用当前会话的模型设置。' });
    } finally { if (!started) release(); }
  } catch (error) {
    const requestId = req.method === 'GET' && url.searchParams.get('requestId');
    return reply(400, { error: error.code ? '模型设置未完成，请刷新后核对原请求。' : error.message,
      keySent: requestId ? null : false,
      ...(requestId ? { requestId, requestStatus: 'unknown', requestActive: active.get(url.searchParams.get('sessionId'))?.requestId === requestId } : {}) });
  }
}
