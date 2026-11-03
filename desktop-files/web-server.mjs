import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { handleChat } from './chat-backend.mjs';
import { handleProject } from './project-backend.mjs';
import { handleCommand } from './command-backend.mjs';
import { handleModel } from './model-controls.mjs';
import { handleTerminal } from './terminal-backend.mjs';
import { handleAccountSessions } from './account-sessions.mjs';
import { resolveMessagePath } from './message-paths.mjs';
import { handleCompletion } from './completion-status.mjs';
import { handleQuota } from './chat-quota.mjs';
import { handleDiagnostics, interfaceVersion } from './desktop-diagnostics.mjs';
import { handleOutputFiles } from './output-files.mjs';

const exec = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));
const overrides = path.join(root, 'web-ui/overrides');
const uploads = path.join(os.homedir(), '.local/share/agent-deck/attachments/web');
const deck = process.env.AGENT_DECK_BIN || path.join(os.homedir(), '.local/bin/agent-deck');
const helper = path.join(os.homedir(), '.local/bin/agent-deck-files');
const port = 8421;
const upstream = { hostname: '127.0.0.1', port: 8420 };
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const limit = 100 * 1024 * 1024;

// The optional sender is built from the installed CLI release. An official
// upgrade or a changed helper falls back to that official CLI automatically.
async function queuedSender() {
  const binary = path.join(root, 'agent-deck-idle-send');
  try {
    const manifest = JSON.parse(await fsp.readFile(binary + '.json', 'utf8'));
    const [base, helperStat] = await Promise.all([fsp.stat(deck), fsp.stat(binary)]);
    const matches = (stat, expected) => expected && stat.isFile() &&
      stat.size === expected.size && Math.trunc(stat.mtimeMs) === expected.mtimeMs;
    if (matches(base, manifest.base) && matches(helperStat, manifest.helper)) return binary;
  } catch { /* Optional local build is absent or no longer matches this CLI. */ }
  return deck;
}

function reply(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function allowed(req) {
  if (!allowedHosts.has(req.headers.host)) return false;
  if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return false;
  if (!['GET', 'HEAD'].includes(req.method) && !req.headers.origin) return false;
  return true;
}

async function bodyJSON(req) {
  req.setEncoding('utf8');
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > 65536) throw new Error('请求内容过长。');
  }
  return JSON.parse(data);
}

async function session(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('请选择有效会话。');
  const { stdout } = await exec(deck, ['session', 'show', id, '--json'], { timeout: 20000, maxBuffer: 1024 * 1024 });
  const row = JSON.parse(stdout);
  if (row.id !== id || !row.path) throw new Error('会话不存在。');
  if (/\b(ssh|mosh|docker|podman)\b/.test(`${row.command} ${row.wrapper}`)) throw new Error('此功能用于本机项目。');
  return row;
}

async function bridge(args) {
  try {
    return await exec(helper, args, { timeout: 40000 });
  } catch (error) {
    throw new Error(error.stdout?.trim() || '本地文件操作未完成，请检查会话状态。');
  }
}

async function desktop(req, res, url) {
  const context = { session, reply, bodyJSON, exec, deck, uploads, queuedSender };
  if (await handleAccountSessions(req, res, url, context)) return;
  if (url.pathname === '/desktop/accounts' || url.pathname === '/desktop/accounts/login') {
    if (req.headers['x-agentdeck-desktop'] !== '1') return reply(res, 403, { error: 'local-ui-required' });
    const providers = ['claude', 'codex'];
    if (url.pathname === '/desktop/accounts' && req.method === 'GET') {
      const accounts = await Promise.all(providers.map(async tool => {
        try {
          const { stdout } = await exec('/usr/bin/python3', [path.join(root, 'account-login.py'), 'status', tool], { timeout: 30000 });
          return JSON.parse(stdout);
        } catch { return { tool, unavailable: true, slots: [] }; }
      }));
      return reply(res, 200, { accounts });
    }
    if (url.pathname !== '/desktop/accounts/login' || req.method !== 'POST') return reply(res, 405, { error: 'method-not-allowed' });
    const body = await bodyJSON(req);
    if (!providers.includes(body?.tool) || typeof body.slot !== 'string' || body.slot.length > 128 || /[\x00-\x1f]/.test(body.slot)) {
      return reply(res, 400, { error: 'invalid-account' });
    }
    try {
      await exec('/usr/bin/python3', [path.join(root, 'account-login.py'), 'open', body.tool, '--slot=' + body.slot], { timeout: 60000 });
      return reply(res, 200, { opened: true });
    } catch { return reply(res, 409, { error: 'native-login-unavailable' }); }
  }
  if (await handleDiagnostics(req, res, url, context)) return;
  if (await handleOutputFiles(req, res, url, context)) return;
  if (await handleCompletion(req, res, url, context)) return;
  if (await handleQuota(req, res, url, context)) return;
  if (await handleCommand(req, res, url, context)) return;
  if (await handleModel(req, res, url, context)) return;
  if (await handleTerminal(req, res, url, context)) return;
  if (await handleChat(req, res, url, context)) return;
  if (await handleProject(req, res, url, context)) return;
  if (req.method !== 'POST' || req.headers['x-agentdeck-desktop'] !== '1') return reply(res, 403, { error: '请从本地 Q-agent 界面操作。' });
  if (url.pathname === '/desktop/upload') {
    const row = await session(url.searchParams.get('sessionId'));
    const name = path.basename((url.searchParams.get('name') || '附件').replaceAll('\\', '/'));
    if (!name || name === '.' || name === '..' || /[\x00-\x1f]/.test(name)) throw new Error('文件名无效。');
    if (Number(req.headers['content-length']) > limit) return reply(res, 413, { error: '单个附件最大 100 MB。' });
    const folder = path.join(uploads, row.id, crypto.randomUUID());
    await fsp.mkdir(folder, { recursive: true, mode: 0o700 });
    const destination = path.join(folder, name);
    const handle = await fsp.open(destination, 'wx', 0o600);
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw new Error('单个附件最大 100 MB。');
        await handle.writeFile(chunk);
      }
    } catch (error) {
      await handle.close();
      await fsp.unlink(destination).catch(() => {});
      throw error;
    }
    await handle.close();
    return reply(res, 200, { path: destination, name, size });
  }
  const body = await bodyJSON(req);
  const row = await session(body.sessionId);
  if (url.pathname === '/desktop/reveal') {
    let target = body.path || row.path;
    if (typeof target !== 'string' || target.length > 4096 || /[\x00-\x1f]/.test(target)) throw new Error('文件路径无效。');
    target = target.trim();
    if (target.length >= 2 && ['"', "'"].includes(target[0]) && target.at(-1) === target[0]) target = target.slice(1, -1);
    const resolved = await resolveMessagePath(target, { projectPath: row.path, messageCwd: body.messageCwd, directoryHints: body.directoryHints });
    if (!resolved.path) {
      if (resolved.candidates.length > 1) return reply(res, 200, { success: true, opened: false, candidates: resolved.candidates });
      return reply(res, 404, { error: '在此消息的工作目录和引用目录中没有找到该文件，请核对完整路径。' });
    }
    target = resolved.path;
    await bridge(['open', target]);
    return reply(res, 200, { success: true });
  }
  if (url.pathname === '/desktop/draft') {
    if (!Array.isArray(body.paths) || !body.paths.length || body.paths.length > 50) throw new Error('请添加 1–50 个附件。');
    const owned = path.join(uploads, row.id) + path.sep;
    for (const item of body.paths) {
      if (typeof item !== 'string' || !path.resolve(item).startsWith(owned)) throw new Error('附件不属于当前会话。');
      const real = await fsp.realpath(item);
      if (!real.startsWith(owned) || !(await fsp.stat(real)).isFile()) throw new Error('附件文件不可用。');
    }
    const { stdout } = await bridge(['attach', '--session', row.id, '--paths-json', JSON.stringify(body.paths)]);
    return reply(res, 200, { success: true, message: stdout.trim() });
  }
  return reply(res, 404, { error: '不存在的文件操作。' });
}

function proxyHeaders(req) {
  const headers = { ...req.headers, host: '127.0.0.1:8420' };
  if (headers.origin) headers.origin = 'http://127.0.0.1:8420';
  delete headers['accept-encoding'];
  return headers;
}

const server = http.createServer(async (req, res) => {
  if (!allowed(req)) return reply(res, 403, { error: '只允许本机界面访问。' });
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/desktop/')) return await desktop(req, res, url);
    if (['GET', 'HEAD'].includes(req.method) && ['/static/', '/static/index.html'].includes(url.pathname)) {
      res.writeHead(302, { Location: '/' + url.search, 'Cache-Control': 'no-store' });
      return res.end();
    }
    const candidate = path.resolve(overrides, '.' + decodeURIComponent(url.pathname));
    if (candidate.startsWith(overrides + path.sep) && ['GET', 'HEAD'].includes(req.method)) {
      const stat = await fsp.stat(candidate).catch(() => null);
      if (stat?.isFile()) {
        const ext = path.extname(candidate);
        const types = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png',
          '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
        res.writeHead(200, { 'Content-Type': types[ext] || 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(candidate).pipe(res);
      }
    }
    const outbound = http.request({ ...upstream, path: req.url, method: req.method, headers: proxyHeaders(req) }, response => {
      if (req.method === 'GET' && (url.pathname === '/' || /^\/[sg]\//.test(url.pathname)) && String(response.headers['content-type']).includes('text/html')) {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', async () => {
          let html = Buffer.concat(chunks).toString('utf8').replace('<html lang="en"', '<html lang="zh-CN"');
          html = html.replace('<title>Agent Deck</title>', '<title>Q-agent</title>')
            .replace('name="apple-mobile-web-app-title" content="Agent Deck"', 'name="apple-mobile-web-app-title" content="Q-agent"');
          const version = await interfaceVersion().catch(() => null);
          if (version) html = html.replace('</head>', '<script>window.__agentDeckInterfaceVersion=' + JSON.stringify(version) + '</script></head>');
          html = html.replace(/<link\s+rel="icon"[^>]*>/, '<link rel="icon" href="/static/icons/agent-deck-32.png" type="image/png" />')
            .replace(/<link\s+rel="apple-touch-icon"[^>]*>/, '<link rel="apple-touch-icon" href="/static/icons/agent-deck-180.png" />');
          html = html.replace('</head>', '<link rel="stylesheet" href="/static/app/icon.css"><link rel="stylesheet" href="/static/app/chat-quota.css"></head>');
          html = html.replace('</head>', '<link rel="stylesheet" href="/desktop-ui.css"><link rel="stylesheet" href="/static/app/chat.css"><link rel="stylesheet" href="/static/app/project.css"><link rel="stylesheet" href="/static/app/activity.css"><script>if("serviceWorker" in navigator){let reloaded=false;navigator.serviceWorker.addEventListener("controllerchange",()=>{if(!reloaded){reloaded=true;location.reload()}});navigator.serviceWorker.getRegistrations().then(rs=>rs.forEach(r=>r.update().catch(()=>{}))).catch(()=>{})}</script><script type="module" src="/desktop-ui.js"></script></head>');
          const headers = { ...response.headers, 'cache-control': 'no-store' };
          delete headers['content-length']; delete headers['content-encoding'];
          res.writeHead(response.statusCode, headers); res.end(html);
        });
      } else {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      }
    });
    outbound.on('error', () => { if (!res.headersSent) reply(res, 502, { error: '本地后端服务正在启动，请稍后刷新。' }); else res.destroy(); });
    req.pipe(outbound);
    res.on('close', () => outbound.destroy());
  } catch (error) {
    const message = error.code ? '操作未完成，请确认会话处于输入状态、文件存在且 Windows 可以访问。' : error.message;
    if (!res.headersSent) reply(res, 400, { error: message });
  }
});

server.on('upgrade', (req, socket, head) => {
  if (!allowed(req) || !req.url.startsWith('/ws/')) return socket.destroy();
  const upgrade = http.request({ ...upstream, path: req.url, headers: proxyHeaders(req) });
  upgrade.on('upgrade', (res, peer, peerHead) => {
    socket.write(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n` + Object.entries(res.headers).map(([k,v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
    if (peerHead.length) socket.write(peerHead);
    if (head.length) peer.write(head);
    peer.pipe(socket); socket.pipe(peer);
    socket.on('error', () => peer.destroy()); peer.on('error', () => socket.destroy());
    socket.on('close', () => peer.destroy()); peer.on('close', () => socket.destroy());
  });
  upgrade.on('response', () => socket.destroy());
  upgrade.on('error', () => socket.destroy());
  upgrade.end();
});
server.listen(port, '127.0.0.1', () => console.log(`Q-agent：http://127.0.0.1:${port}`));
