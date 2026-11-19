import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { native } from './account-sessions.mjs';
import { acquireNativeControl } from './native-controls.mjs';

const state = path.join(os.homedir(), '.local/share/agent-deck/runtime/claude-conversation-sync');
const claude = path.join(os.homedir(), '.local/bin/claude');
const helper = fileURLToPath(new URL('./claude-conversation-sync.py', import.meta.url));
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const jobId = /^[a-f0-9]{8}$/i;
const resumeWrapper = '/usr/bin/env Q_AGENT_RESUME_CLAUDE=1 ';
const registrations = new Map();
const prefix = row => row.profile ? ['-p', row.profile] : [];
const configFor = file => file && path.basename(path.dirname(path.dirname(file))) === 'projects'
  ? path.dirname(path.dirname(path.dirname(file))) : '';
const readJSON = file => fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
const entries = directory => fs.readdir(directory, { withFileTypes: true }).catch(error => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";

export const resumeClaudeOnOpen = row => row.tool === 'claude' && row.wrapper?.startsWith(resumeWrapper);

async function agents(api, configDir, cwd) {
  const { stdout } = await api.exec(claude, ['agents', '--json', '--all', '--cwd', cwd], {
    timeout: 10000, maxBuffer: 2 * 1024 * 1024, cwd,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
  });
  return JSON.parse(stdout);
}

async function register(api, parent, conversation) {
  const { nativeId, cwd, configDir, job, title } = conversation;
  if (!uuid.test(nativeId) || !path.isAbsolute(cwd) || (job && !jobId.test(job))) throw new Error('无效的 Claude 原生对话。');
  const key = configDir + ':' + nativeId;
  if (registrations.has(key)) return registrations.get(key);
  const attempt = (async () => {
    const existing = (await native(api, ['list', '--all'])).find(row =>
      row.claude_session_id === nativeId && row.tool === 'claude' && row.profile === parent.profile &&
      (row.account || '') === (parent.account || '') && row.path === cwd &&
      (!row.transcript_path || configFor(row.transcript_path) === configDir));
    if (existing) return existing.id;
    const wrapper = resumeWrapper + (job
      ? ['/usr/bin/python3', helper, 'attach', job].map(shellQuote).join(' ') + ' {command}'
      : '{command}');
    const receipt = await native(api, [...prefix(parent), 'add', '-c', 'claude',
      '--resume-session=' + nativeId, '--no-parent', '--no-transition-notify', '--wrapper=' + wrapper,
      '--title=' + String(title || 'Claude 对话').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 140),
      ...(parent.group ? ['--group=' + parent.group] : []),
      ...(parent.account ? ['--account=' + parent.account] : []), cwd]);
    if (!receipt.success || !receipt.id) throw new Error('Claude 对话登记尚未确认。');
    return receipt.id;
  })();
  registrations.set(key, attempt);
  try { return await attempt; } finally { registrations.delete(key); }
}

export async function resumeSavedClaude(api, parent, selected) {
  const configDir = configFor(selected.file);
  if (!configDir) throw new Error('找不到这段对话的 Claude 配置。');
  const rows = await native(api, ['list', '--all']);
  const known = rows.find(row => row.claude_session_id === selected.id && row.profile === parent.profile &&
    row.tool === 'claude' && row.path === parent.path && (row.account || '') === (parent.account || '') &&
    (!row.transcript_path || configFor(row.transcript_path) === configDir));
  if (known) return known.id;
  const live = await agents(api, configDir, parent.path).catch(() => {
    throw new Error('暂时无法核对 Claude 是否仍在另一个终端中运行。');
  });
  const current = live.find(row => row.sessionId === selected.id && row.cwd === parent.path);
  if (current && current.kind !== 'background') throw new Error('这段对话正在另一个终端中运行。');
  return register(api, parent, { nativeId: selected.id, cwd: parent.path, configDir,
    job: current?.id, title: parent.title + ' · 历史对话' });
}

async function rotation(api, { old, current }) {
  if (!old || !current || !uuid.test(old.nativeId) || !uuid.test(current.nativeId)) return true;
  const row = await api.session(current.instance, current.profile).catch(() => null);
  if (!row || row.tool !== 'claude' || row.path !== old.cwd || row.ssh_host) return false;
  if (row.transcript_path && configFor(row.transcript_path) !== old.configDir) return false;
  if (row.claude_session_id === old.nativeId) {
    const pid = current.process?.pid;
    if (!Number.isInteger(pid) || !/^%\d+$/.test(current.pane)) return false;
    const [session, proc, boot, pane] = await Promise.all([
      readJSON(path.join(current.configDir, 'sessions', pid + '.json')),
      fs.readFile('/proc/' + pid + '/stat', 'utf8').catch(() => ''),
      fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      api.exec('tmux', ['-L', row.tmux_socket_name || 'agent-deck', 'display-message', '-p', '-t',
        current.pane, '#{session_name}'], { timeout: 2500 }).catch(() => null),
    ]);
    if (!uuid.test(session?.sessionId || '') || session.sessionId === old.nativeId ||
        proc.slice(proc.lastIndexOf(')') + 1).trim().split(/\s+/)[19] !== current.process.startTicks ||
        boot.trim() !== current.process.bootId || pane?.stdout.trim() !== row.tmux_session) return false;
    const release = acquireNativeControl(row.id);
    if (!release) return false;
    try {
      await native(api, [...prefix(row), 'session', 'set', row.id, 'claude-session-id', session.sessionId]);
    } finally { release(); }
  }
  const saved = await fs.lstat(old.transcript).catch(() => null);
  if (saved?.isFile() && saved.size > 0) {
    await register(api, row, { nativeId: old.nativeId, cwd: old.cwd, configDir: old.configDir, title: row.title + ' · 历史对话' });
  }
  return true;
}

export function startClaudeConversationSync(api) {
  let running = false;
  const seen = new Set();
  const checked = new Map();
  async function synchronize() {
    if (running) return;
    running = true;
    try {
      const queue = path.join(state, 'pending');
      for (const entry of await entries(queue)) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const file = path.join(queue, entry.name);
        const event = await readJSON(file);
        if (event?.current && Date.now() - event.current.time * 1000 < 300000) {
          if (!await rotation(api, event).catch(() => false)) continue;
        }
        await fs.unlink(file).catch(() => {});
      }
      let rows;
      for (const home of await entries(path.join(state, 'homes'))) {
        if (!home.isFile()) continue;
        const configDir = await readJSON(path.join(state, 'homes', home.name));
        if (typeof configDir !== 'string' || !path.isAbsolute(configDir)) continue;
        const jobs = path.join(configDir, 'jobs');
        for (const entry of await entries(jobs)) {
          if (!entry.isDirectory() || !jobId.test(entry.name)) continue;
          const key = createHash('sha256').update(configDir + ':' + entry.name).digest('hex');
          if (seen.has(key) || Date.now() - (checked.get(key) || 0) < 10000) continue;
          checked.set(key, Date.now());
          const handled = path.join(state, 'handled', key);
          if (await fs.stat(handled).then(() => true).catch(() => false)) { seen.add(key); continue; }
          const job = await readJSON(path.join(jobs, entry.name, 'state.json'));
          if (!uuid.test(job?.forkSessionId || '') || !uuid.test(job.forkParentSessionId || '') ||
              job.forkSessionId === job.forkParentSessionId || !path.isAbsolute(job.cwd || '')) continue;
          rows ||= await native(api, ['list', '--all']);
          const parent = rows.find(row => row.tool === 'claude' && row.claude_session_id === job.forkParentSessionId &&
            configFor(row.transcript_path) === configDir);
          if (!parent) continue;
          const live = (await agents(api, configDir, job.cwd).catch(() => [])).find(item =>
            item.kind === 'background' && item.id === entry.name && item.sessionId === job.forkSessionId && item.cwd === job.cwd);
          if (!live) continue;
          await register(api, parent, { nativeId: live.sessionId, cwd: live.cwd, configDir,
            job: live.id, title: live.name || parent.title + ' · 分支' });
          await fs.mkdir(path.dirname(handled), { recursive: true, mode: 0o700 });
          await fs.writeFile(handled, '', { mode: 0o600 });
          seen.add(key);
        }
      }
    } catch { /* Durable local receipts are retried on the next pass. */ }
    finally { running = false; }
  }
  setInterval(synchronize, 2000).unref();
  void synchronize();
}
