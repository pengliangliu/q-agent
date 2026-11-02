import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { acquireNativeControl, nativeComposer, sendVerifiedMenuKey } from './native-controls.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const receipts = path.join(os.homedir(), '.local/share/agent-deck/chat-receipts/commands');
const active = new Map(), catalogs = new Map();
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9-]{8,100}$/.test(value);
const clean = value => String(value || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
const pause = () => new Promise(resolve => setTimeout(resolve, 250));
const filename = (id, requestId) => path.join(receipts, hash([id, requestId]) + '.json');
const activeKey = record => hash([record.sessionId, record.requestId]);
const identity = row => [row.id, row.tool, row.tmux_session, row.claude_session_id, row.codex_session_id, row.transcript_path];
const publicRecord = ({ identity: _, answered = [], ...record }, inputAvailable = false) => {
  const requestActive = active.has(activeKey(record));
  const needsInput = Boolean(record.prompt);
  return { ...record, requestActive, needsInput,
    ...(record.prompt?.id && answered.includes(record.prompt.id) ? { response: { promptId: record.prompt.id, state: requestActive ? 'posting' : 'unknown',
      requestActive, canStopTracking: !requestActive, message: '原选择已经尝试提交，当前菜单仍需查询核对。' } } : {}),
    inputBlocked: requestActive || needsInput || !['done', 'failed'].includes(record.state),
    canStopTracking: !requestActive && !needsInput && record.state === 'unknown' && inputAvailable };
};

async function cli(api, row, args, timeout = 20000) {
  try {
    const { stdout } = await api.exec(api.deck, [...(row.profile ? ['-p', row.profile] : []), ...args],
      { timeout, maxBuffer: 3 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    if (error.stdout) { try { return JSON.parse(error.stdout); } catch {} }
    throw new Error('原生命令未返回可确认的结果，请查询原回执。');
  }
}
async function save(record) {
  const file = filename(record.sessionId, record.requestId);
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, file);
  const directory = await fs.open(receipts, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
async function load(id, requestId) {
  if (!identifier(id) || !identifier(requestId)) throw new Error('命令回执标识无效。');
  const record = JSON.parse(await fs.readFile(filename(id, requestId), 'utf8'));
  if (record.sessionId !== id || record.requestId !== requestId) throw new Error('命令回执不属于当前会话。');
  return record;
}
async function pane(row, api) {
  const result = await cli(api, row, ['session', 'output', row.id, '--pane', '--primary', '--json']);
  if (!result.success || (result.session_id && result.session_id !== row.id)) throw new Error('无法读取当前会话的原生界面。');
  return result.content || '';
}

// Only a complete, numbered single-selection dialog with a native footer is
// mapped to buttons. Other commands still show their original output.
export function commandPrompt(content, requestId) {
  const lines = clean(content).split('\n').slice(-90);
  const footer = lines.findLastIndex(line => /(?:esc|escape).*?(?:cancel|back|close)|(?:cancel|back|close).*?(?:esc|escape)/i.test(line));
  if (footer < 0) return null;
  if (lines.slice(footer + 1).some(line => /^\s*[›❯](?:\s|$)/.test(line) || /esc to interrupt/i.test(line))) return null;
  const marker = /^\s*([›❯]\s*)?([1-9][0-9]?)\.\s+(.+?)\s*$/;
  const rows = lines.slice(0, footer).flatMap((line, index) => {
    const match = line.match(marker);
    return match ? [{ index, focused: !!match[1], value: match[2], label: match[3] }] : [];
  });
  const focused = rows.findLastIndex(row => row.focused);
  if (focused < 0) return null;
  let start = focused;
  while (start > 0 && Number(rows[start - 1].value) === Number(rows[start].value) - 1) start--;
  let end = focused;
  while (end + 1 < rows.length && Number(rows[end + 1].value) === Number(rows[end].value) + 1) end++;
  const menu = rows.slice(start, end + 1);
  if (menu.length < 2 || menu.length > 16 || menu[0].value !== '1' ||
      menu.filter(row => row.focused).length !== 1 || menu.some(row => /^\[[ x✔]\]/i.test(row.label))) return null;
  const text = lines.slice(Math.max(0, menu[0].index - 12), footer + 1).map(line => line.trim().replace(/^[›❯]\s*/, '')).join('\n').trim();
  return { id: hash([requestId, text]), kind: 'question', type: 'question', supported: true, text,
    options: menu.map(row => ({ value: row.value, label: row.label })), multiple: false,
    actions: [{ value: 'submit', label: '提交选择' }, { value: 'cancel', label: '返回' }],
    _cursor: menu.findIndex(row => row.focused) };
}
function visiblePrompt(prompt) {
  if (!prompt) return null;
  const { _cursor, ...value } = prompt;
  return value;
}
function commandDialog(row, output, requestId) {
  const parsed = commandPrompt(output, requestId);
  if (parsed) return visiblePrompt(parsed);
  const tail = clean(output).split('\n').slice(-30).join('\n');
  if (!nativeComposer(row.tool, output) && /esc.*(?:back|cancel|close)|enter.*(?:select|confirm)/i.test(tail)) {
    return { supported: false, text: tail.trim() };
  }
  return null;
}

async function commandCatalog(row, api) {
  const key = JSON.stringify([row.tool, row.path, row.profile]);
  const cached = catalogs.get(key);
  if (cached && Date.now() - cached.time < 300000) return cached.promise;
  const promise = (async () => {
    const data = JSON.parse(await fs.readFile(path.join(root, row.tool + '-slash-commands.json'), 'utf8'));
    let commands = data.commands.filter(item => !item.internal && item.visibleOnLinux !== false);
    let warning = '';
    if (row.tool === 'codex') {
      const version = (await api.exec(path.join(os.homedir(), '.local/bin/codex'), ['--version'], { timeout: 10000 })).stdout.trim();
      if (!version.endsWith(' ' + data.version)) return { tool: row.tool, commands: [], warning: 'Codex 版本已变化，请使用独立终端；命令目录需要重新核对。' };
    }
    if (row.tool === 'claude') {
      try {
        const discovered = await cli(api, row, ['session', 'commands', row.id, '--json'], 90000);
        const byName = new Map(commands.map(command => [command.name, command]));
        for (const item of discovered.commands || []) if (/^\/[A-Za-z0-9][\w.:-]*$/.test(item.name)) byName.set(item.name, { ...byName.get(item.name), ...item });
        commands = [...byName.values()];
      } catch { warning = '项目技能暂未加载，可刷新后重试；内置命令仍可使用。'; }
    }
    return { tool: row.tool, commands: commands.map(command => ({ ...command,
      description: String(command.description || '').slice(0, 500), insertText: command.name + ' ',
      source: command.source || 'builtin' })), warning };
  })();
  catalogs.set(key, { time: Date.now(), promise });
  promise.catch(() => catalogs.delete(key));
  return promise;
}

function checkSession(row) {
  if (row.ssh_host || !['claude', 'codex'].includes(row.tool)) throw new Error('原生命令目前支持本机 Claude 和 Codex 会话。');
  if (['stopped', 'error', 'starting'].includes(row.status)) throw new Error('请先启动当前会话。');
  if ((row.queue || []).some(item => ['queued', 'typing', 'typed', 'submitted'].includes(item.state))) throw new Error('会话还有待发送消息，请等待处理后再运行命令。');
}
async function freshRow(record, api) {
  const row = await api.session(record.sessionId);
  if (hash(identity(row)) !== hash(record.identity)) throw new Error('当前原生会话已变化，请核对后重新操作。');
  return row;
}

async function runCommand(record, row, api) {
  try {
    checkSession(await freshRow(record, api));
    const beforeRow = await freshRow(record, api);
    if (!['waiting', 'idle'].includes(beforeRow.status) || !nativeComposer(row.tool, await pane(beforeRow, api))) throw new Error('会话正在运行、等待确认或原生输入框有草稿，请先处理。');
    record.keySent = null; await save(record);
    const typed = await cli(api, row, ['session', 'send-keys', row.id, '--text', record.command + ' ', '--primary', '--json']);
    if (!typed.success) throw new Error('未能确认命令已输入。');
    record.keySent = true;
    await pause();
    const current = await freshRow(record, api);
    checkSession(current);
    if (!['waiting', 'idle'].includes(current.status) || !nativeComposer(row.tool, await pane(current, api), record.command)) throw new Error('原生输入内容未通过核对，命令尚未提交，请在独立终端检查。');
    record.state = 'unknown'; await save(record);
    const entered = await cli(api, row, ['session', 'send-keys', row.id, '--named-key', 'Enter', '--primary', '--json']);
    if (!entered.success) throw new Error('命令提交结果未知，请核对当前原生界面。');
    await pause();
    record.state = 'done'; record.message = '已提交原生命令，执行进度会继续显示在当前会话。';
    const actual = await api.session(row.id);
    // /clear, /new, /resume and /exit may intentionally change or stop native identity.
    record.identity = identity(actual);
    const output = await pane(actual, api).catch(() => '');
    record.output = clean(output).slice(-24000);
    record.prompt = commandDialog(actual, output, record.requestId);
    if (nativeComposer(row.tool, output, record.command)) { record.state = 'unknown'; record.message = '尚未确认原生命令已提交，请查看原生输入框；不会重复发送。'; }
    if (record.prompt) { record.state = 'awaiting_input'; record.message = '请选择原生命令中的选项。'; }
  } catch (error) {
    record.state = record.keySent !== false ? 'unknown' : 'failed';
    record.message = error.message;
  } finally { await save(record); }
}

async function respondToCommand(record, body, api) {
  if (record.state !== 'awaiting_input' || !record.prompt || record.prompt.id !== body.promptId) {
    return { ...publicRecord(record), success: false, keySent: false, message: '此命令菜单已结束或变化，请刷新后核对。' };
  }
  const release = acquireNativeControl(record.sessionId);
  if (!release) throw new Error('当前会话的上一操作仍在处理。');
  let touched = false;
  try {
    const row = await freshRow(record, api);
    let prompt = commandPrompt(await pane(row, api), record.requestId);
    if (!prompt || prompt.id !== body.promptId || (record.answered || []).includes(prompt.id)) throw new Error('原生选项已变化或已提交，请刷新后核对。');
    const cancel = body.action === 'cancel';
    const target = prompt.options.findIndex(item => item.value === body.choice);
    if (!cancel && target < 0) throw new Error('请选择当前显示的选项。');
    record.answered = [...(record.answered || []), prompt.id];
    record.state = 'unknown'; await save(record);
    const press = async key => {
      const current = await freshRow(record, api);
      const actual = commandPrompt(await pane(current, api), record.requestId);
      if (!actual || actual.id !== prompt.id || actual._cursor !== prompt._cursor) throw new Error('原生菜单已变化，操作已停止。');
      touched = true;
      const result = await sendVerifiedMenuKey(current, key, api);
      if (!result.success) throw new Error('按键送达结果未知，请查看当前界面。');
      await pause();
    };
    if (cancel) await press('Escape');
    else {
      while (prompt._cursor !== target) {
        const previous = prompt;
        const step = target > prompt._cursor ? 1 : -1;
        await press(step > 0 ? 'Down' : 'Up');
        prompt = commandPrompt(await pane(await freshRow(record, api), api), record.requestId);
        if (!prompt || prompt.id !== previous.id || prompt._cursor !== previous._cursor + step) throw new Error('选项位置未通过核对，操作已停止。');
      }
      await press('Enter');
    }
    const output = await pane(await freshRow(record, api), api);
    record.output = clean(output).slice(-24000);
    record.prompt = commandDialog(row, output, record.requestId);
    record.state = record.prompt ? 'awaiting_input' : 'done';
    record.message = record.prompt ? '已更新原生菜单，请继续选择。' : '选择已发送。';
    await save(record);
    return publicRecord(record);
  } catch (error) {
    record.state = touched ? 'unknown' : record.state;
    record.message = error.message;
    await save(record);
    return { ...publicRecord(record), success: false, keySent: touched ? null : false, unknown: touched };
  } finally { release(); }
}

export async function handleCommand(req, res, url, api) {
  if (!['/desktop/chat/commands', '/desktop/chat/command', '/desktop/chat/command-status', '/desktop/chat/command-respond'].includes(url.pathname)) return false;
  const reply = (code, body) => { api.reply(res, code, body); return true; };
  if (req.method !== 'GET' && (req.method !== 'POST' || req.headers['x-agentdeck-desktop'] !== '1')) return reply(403, { error: '请从本地聊天界面操作。' });
  try {
    if (req.method === 'GET' && url.pathname.endsWith('/commands')) {
      const row = await api.session(url.searchParams.get('sessionId'));
      if (!['claude', 'codex'].includes(row.tool)) throw new Error('此工具没有可用命令列表。');
      return reply(200, await commandCatalog(row, api));
    }
    if (req.method === 'GET' && url.pathname.endsWith('/command-status')) {
      const key = hash([url.searchParams.get('sessionId'), url.searchParams.get('requestId')]);
      const wasRunning = active.has(key);
      const record = await load(url.searchParams.get('sessionId'), url.searchParams.get('requestId'));
      if (wasRunning || active.has(key)) return reply(200, { ...publicRecord(record), state: 'running', requestActive: true,
        inputBlocked: true, canStopTracking: false, message: '正在执行原生命令。' });
      if (record.state === 'running') { record.state = 'unknown'; record.message = '服务重启后结果待核对，不会重新执行命令。'; }
      let inputAvailable = false;
      if (['awaiting_input', 'unknown'].includes(record.state)) {
        const row = await freshRow(record, api).catch(() => null);
        if (row) {
          const output = await pane(row, api).catch(() => null);
          if (output !== null) {
            record.output = clean(output).slice(-24000);
            record.prompt = commandDialog(row, output, record.requestId);
            inputAvailable = nativeComposer(row.tool, output);
            if (record.prompt) record.state = 'awaiting_input';
            if (record.state === 'awaiting_input' && !record.prompt) { record.state = 'done'; record.message = '原生命令交互已结束。'; await save(record); }
          }
        }
      }
      return reply(200, publicRecord(record, inputAvailable));
    }
    if (req.method !== 'POST') return reply(405, { error: '此命令操作需要 POST。' });
    const body = await api.bodyJSON(req);
    if (url.pathname.endsWith('/command-respond')) {
      const record = await load(body.sessionId, body.requestId);
      const key = activeKey(record);
      if (active.has(key)) return reply(409, { ...publicRecord(record), error: '原命令仍在处理，请查询当前状态。' });
      const task = respondToCommand(record, body, api);
      active.set(key, task);
      let result;
      try { result = await task; } finally { active.delete(key); }
      return reply(result.success === false ? 409 : 200, publicRecord(result));
    }
    if (!identifier(body.sessionId) || !identifier(body.requestId) || typeof body.command !== 'string' ||
        body.command.length > 4000 || /[\x00-\x1f\x7f]/.test(body.command) || !/^\/[A-Za-z0-9][\w.:-]*(?: +.*)?$/.test(body.command.trim())) throw new Error('请输入单行原生命令，例如 /status。');
    const previous = await load(body.sessionId, body.requestId).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (previous) {
      if (previous.command !== body.command.trim()) throw new Error('同一命令标识不能用于不同内容。');
      return reply(200, publicRecord(previous));
    }
    const row = await api.session(body.sessionId);
    checkSession(row);
    const command = body.command.trim();
    const name = command.split(/ +/, 1)[0];
    if (['/model', '/effort'].includes(name)) throw new Error('请使用聊天中的模型 / 强度面板，这样只修改当前会话。');
    const catalog = await commandCatalog(row, api);
    const entry = catalog.commands.find(item => item.name === name);
    if (!entry) throw new Error('当前命令目录中没有此命令，请在独立终端核对可用命令。');
    if (row.tool === 'codex' && entry.supportsInlineArgs === false && command !== name) throw new Error('此 Codex 命令不支持直接附加参数，请执行命令后选择，或使用模型设置面板。');
    const release = acquireNativeControl(row.id);
    if (!release) return reply(409, { success: false, keySent: false, error: '当前会话的上一操作仍在处理。' });
    const record = { requestId: body.requestId, sessionId: row.id, command,
      identity: identity(row), state: 'running', message: '正在执行原生命令。', keySent: false };
    try {
      await fs.mkdir(receipts, { recursive: true, mode: 0o700 });
      const handle = await fs.open(filename(row.id, body.requestId), 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
      const directory = await fs.open(receipts, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      const task = runCommand(record, row, api).catch(error => { record.state = 'unknown'; record.message = error.message; })
        .finally(() => { active.delete(activeKey(record)); release(); });
      active.set(activeKey(record), task);
    } catch (error) { release(); throw error; }
    return reply(202, publicRecord(record));
  } catch (error) { return reply(400, { keySent: false, unknown: false,
    error: error.code ? '命令操作未完成，请核对原回执。' : error.message }); }
}
