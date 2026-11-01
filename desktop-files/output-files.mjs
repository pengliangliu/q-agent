import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveMessagePath, isLocalWslUNC } from './message-paths.mjs';
import { canOpenDocument } from './web-ui/overrides/static/app/outputFileReferences.js';

const endpoints = new Map(['resolve', 'open', 'reveal'].map(action => ['/desktop/output-files/' + action, action]));
const windowsPath = value => /^[A-Za-z]:[\\/]|^\\\\/.test(value);

async function localPath(value, api) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('文件路径无效。');
  if (value.startsWith('\\\\') && !isLocalWslUNC(value)) throw new Error('仅支持本机文件，远端文件请先下载到本地。');
  if (windowsPath(value)) {
    const { stdout } = await api.exec('wslpath', ['-u', value], { timeout: 5000, maxBuffer: 16384 });
    value = stdout.trim();
  }
  if (value.startsWith('~/')) value = path.join(os.homedir(), value.slice(2));
  if (!path.isAbsolute(value)) throw new Error('文件位置尚未解析为完整路径。');
  return path.resolve(value);
}

export async function inspectOutputReference(row, body, api) {
  let raw = body.path;
  if (typeof raw === 'string' && raw.startsWith('~/')) raw = path.join(os.homedir(), raw.slice(2));
  const resolved = await resolveMessagePath(raw, { projectPath: row.path, messageCwd: body.messageCwd, directoryHints: body.directoryHints });
  const items = [], seen = new Set();
  for (const candidate of resolved.candidates) {
    const location = await localPath(candidate, api);
    const stat = await fs.stat(location).catch(() => null);
    if (!stat || !stat.isDirectory() && !stat.isFile()) continue;
    const real = await fs.realpath(location);
    if (seen.has(real)) continue;
    seen.add(real);
    const directory = stat.isDirectory();
    items.push({ path: location, name: path.basename(location) || location, type: directory ? 'directory' : 'file',
      canOpen: directory || canOpenDocument(location) && canOpenDocument(real) });
  }
  return items;
}

export async function handleOutputFiles(req, res, url, api) {
  const action = endpoints.get(url.pathname);
  if (!action) return false;
  const reply = (status, body) => { api.reply(res, status, body); return true; };
  if (req.method !== 'POST' || req.headers['x-agentdeck-desktop'] !== '1') return reply(403, { error: '请从聊天中的文件卡片操作。' });
  try {
    const body = await api.bodyJSON(req), row = await api.session(body.sessionId);
    if (row.id !== body.sessionId || row.ssh_host) throw new Error('此文件不属于可操作的本机会话。');
    const items = await inspectOutputReference(row, body, api);
    if (!items.length) return reply(404, { code: 'not_found', error: '在这条消息的工作目录和引用目录中没有找到该文件。' });
    if (items.length > 1) return reply(200, { success: true, status: 'ambiguous', candidates: items, opened: false });
    const item = items[0];
    if (action === 'open' && !item.canOpen) return reply(400, { code: 'unsupported_type', error: '此类型请使用“显示位置”查看，不会直接运行文件。', item });
    if (action !== 'resolve') {
      const helperAction = action === 'open' && item.type === 'file' ? 'open-file' : 'open';
      try {
        await api.exec(path.join(os.homedir(), '.local/bin/agent-deck-files'), [helperAction, item.path], { timeout: 40000, maxBuffer: 65536 });
      } catch (error) { throw new Error(error.stdout?.trim() || '文件操作结果未确认，请先检查应用窗口。'); }
    }
    return reply(200, { success: true, status: 'resolved', item, opened: action !== 'resolve' });
  } catch (error) { return reply(400, { error: error.code ? '文件操作未完成，请核对本地路径。' : error.message }); }
}
