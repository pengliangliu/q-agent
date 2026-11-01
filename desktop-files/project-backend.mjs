import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { isLocalWslUNC } from './message-paths.mjs';

async function normalize(value, exec) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f]/.test(value)) throw new Error('请输入有效的项目目录。');
  let text = value.trim();
  if (text.length > 1 && ['"', "'"].includes(text[0]) && text.at(-1) === text[0]) text = text.slice(1, -1);
  if (text.startsWith('\\\\') && !isLocalWslUNC(text)) throw new Error('请选择本机目录。');
  if (/^[a-z]:[\\/]/i.test(text) || text.startsWith('\\\\')) text = (await exec('wslpath', ['-u', text])).stdout.trim();
  if (text === '~' || text.startsWith('~/')) text = os.homedir() + text.slice(1);
  if (!path.isAbsolute(text)) throw new Error('请使用完整目录路径，例如 /home/user/projects/example。');
  return path.resolve(text);
}

let creating = false;
export async function handleProject(req, res, url, context) {
  const { reply, bodyJSON, exec, deck } = context;
  if (url.pathname === '/desktop/conductors' && req.method === 'GET') {
    const result = JSON.parse((await exec(deck, ['conductor', 'list', '--json'], { timeout: 15000 })).stdout);
    const rows = Array.isArray(result) ? result : result.conductors || [];
    // Never return channel credentials or the full conductor configuration.
    reply(res, 200, { conductors: rows.map(r => ({ name: r.name || r.id || '协调器', profile: r.profile || '', sessionId: r.session_id || r.sessionId || '', status: r.status || '' })) });
    return true;
  }
  if (!url.pathname.startsWith('/desktop/projects/')) return false;
  if (req.method !== 'POST' || req.headers['x-agentdeck-desktop'] !== '1') { reply(res, 403, { error: '请从本地项目界面操作。' }); return true; }
  const body = await bodyJSON(req);
  if (url.pathname === '/desktop/projects/pick-directory') {
    const { stdout } = await exec(path.join(os.homedir(), '.local/bin/agent-deck-files'), ['pick-directory'], { timeout: 300000 });
    reply(res, 200, JSON.parse(stdout));
    return true;
  }
  if (url.pathname !== '/desktop/projects/create') { reply(res, 404, { error: '未知项目操作。' }); return true; }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 120 || /[\x00-\x1f/\\]/.test(name)) throw new Error('项目名称不能为空，且不能包含斜线或控制字符。');
  const parentPath = body.parentPath ?? '';
  if (typeof parentPath !== 'string' || parentPath.length > 2048 || /[\x00-\x1f\\]/.test(parentPath)) throw new Error('请选择有效的父项目。');
  const folder = await normalize(body.path, exec);
  if (creating) throw new Error('另一个项目正在创建，请稍后再试。');
  creating = true;
  try {
    const listed = JSON.parse((await exec(deck, ['group', 'list', '--json'], { timeout: 20000 })).stdout);
    const flatten = rows => rows.flatMap(row => [row, ...flatten(row.children || [])]);
    const groups = flatten(listed.groups || []);
    if (parentPath && !groups.some(g => g.path === parentPath)) throw new Error('父项目已不存在，请刷新后重新选择。');
    const childPath = (parentPath ? parentPath + '/' : '') + name;
    const parentOf = value => value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : '';
    if (groups.some(g => parentOf(g.path) === parentPath && (g.name === name || g.path === childPath ||
        g.path === (parentPath ? parentPath + '/' : '') + name.replaceAll(' ', '-')))) throw new Error('该父级下已存在同名项目，请选择其他名称。');
    const missing = [];
    let cursor = folder;
    while (true) {
      const info = await fs.stat(cursor).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (info) { if (!info.isDirectory()) throw new Error('项目路径中包含普通文件。'); break; }
      missing.unshift(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error('项目目录无法访问。');
      cursor = parent;
    }
    if (missing.length && body.createDirectory !== true) throw new Error('目录尚不存在，请勾选创建目录。');
    if (missing.length && Array.isArray(body.createDirectoryPaths)) {
      const approved = new Set(await Promise.all(body.createDirectoryPaths.map(p => normalize(p, exec))));
      if (missing.some(p => !approved.has(p))) throw new Error('待创建目录发生变化，请重新确认目录列表。');
    }
    if (missing.length) await fs.mkdir(folder, { recursive: true });
    const receipt = JSON.parse((await exec(deck, ['group', 'create', name, ...(parentPath ? ['--parent', parentPath] : []), '--default-path', folder, '--json'], { timeout: 20000 })).stdout);
    if (receipt.success === false || receipt.error) throw new Error('项目分组创建未成功，请刷新列表核对。');
    const groupPath = receipt.path || receipt.group_path || receipt.group?.path || childPath;
    reply(res, 200, { success: true, groupPath, path: folder });
  } finally { creating = false; }
  return true;
}
