import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
// A bounded deployment fingerprint, not a recursive scan on each settings read.
const versionFiles = ['web-server.mjs', 'desktop-diagnostics.mjs', 'chat-backend.mjs', 'command-backend.mjs',
  'model-controls.mjs', 'account-batches.mjs', 'chat-history.py', 'message-paths.mjs', 'output-files.mjs', 'web-ui/overrides/desktop-ui.js', 'web-ui/overrides/sw.js',
  ...['main.js', 'AppShell.js', 'Topbar.js', 'Sidebar.js', 'ChatPanel.js', 'SessionModelControls.js', 'CommandResult.js',
    'InlinePrompt.js', 'CompletionNotifications.js', 'DesktopSettings.js', 'AccountSettings.js', 'AccountBatch.js', 'SessionAccount.js', 'DiagnosticsSettings.js', 'desktopPreferences.js',
    'uiOperations.js', 'OutputFiles.js', 'outputFileReferences.js', 'outputFiles.css', 'chat.css', 'project.css', 'codex-theme.css', 'desktopSettings.css']
    .map(name => 'web-ui/overrides/static/app/' + name)];
const versionCache = new Map();
let applicationCache;

export async function interfaceVersion(directory = root, force = false) {
  const cached = versionCache.get(directory);
  if (!force && cached && Date.now() - cached.checkedAt < 2000) return cached.version;
  const files = await Promise.all(versionFiles.map(async name => {
    const stat = await fs.stat(path.join(directory, name)).catch(() => null);
    return { name, stat };
  }));
  const signature = JSON.stringify(files.map(({ name, stat }) => [name, stat?.size, stat?.mtimeMs]));
  if (cached?.signature === signature) { cached.checkedAt = Date.now(); return cached.version; }
  const digest = crypto.createHash('sha256');
  for (const { name, stat } of files) {
    digest.update(name + '\0');
    if (stat?.isFile()) digest.update(await fs.readFile(path.join(directory, name)));
  }
  const version = 'ui-' + digest.digest('hex').slice(0, 12);
  versionCache.set(directory, { signature, version, checkedAt: Date.now() });
  return version;
}

function upstreamHealth() {
  return new Promise(resolve => {
    let finished = false;
    const finish = value => { if (!finished) { finished = true; resolve(value); } };
    const request = http.request({ hostname: '127.0.0.1', port: 8420, path: '/', method: 'HEAD' }, response => {
      response.resume();
      finish({ status: response.statusCode >= 200 && response.statusCode < 400 ? 'connected' : 'unavailable',
        errorCode: response.statusCode >= 400 ? 'http-' + response.statusCode : null });
    });
    request.setTimeout(2000, () => { finish({ status: 'unavailable', errorCode: 'timeout' }); request.destroy(); });
    request.on('error', () => finish({ status: 'unavailable', errorCode: 'connection-failed' }));
    request.end();
  });
}

async function appVersion(api) {
  if (applicationCache?.deck === api.deck && Date.now() - applicationCache.time < 60000) return applicationCache.value;
  let value = null;
  try {
    const { stdout } = await api.exec(api.deck, ['version'], { timeout: 3000, maxBuffer: 4096 });
    value = stdout.trim().match(/^Agent Deck v([0-9]+(?:\.[0-9]+)+(?:[-+][A-Za-z0-9.-]+)?)$/)?.[1] || null;
  } catch { /* Missing version is shown as unknown, never copied as an error string. */ }
  applicationCache = { deck: api.deck, time: Date.now(), value };
  return value;
}

export async function readDiagnostics(api, options = {}) {
  const [version, applicationVersion, backend, kernel] = await Promise.all([
    interfaceVersion(options.directory || root, options.force === true), appVersion(api),
    (options.health || upstreamHealth)(), fs.readFile('/proc/sys/kernel/osrelease', 'utf8').catch(() => ''),
  ]);
  return { interfaceVersion: version, applicationVersion,
    bridge: { status: 'connected', environment: /microsoft/i.test(kernel) ? 'wsl' : process.platform },
    backend: { status: backend.status === 'connected' ? 'connected' : 'unavailable',
      errorCode: /^(?:timeout|connection-failed|http-[0-9]{3})$/.test(backend.errorCode || '') ? backend.errorCode : null } };
}

export async function handleDiagnostics(req, res, url, api) {
  if (url.pathname !== '/desktop/diagnostics') return false;
  if (req.method !== 'GET' || req.headers['x-agentdeck-desktop'] !== '1') {
    api.reply(res, 403, { error: '请从本地设置界面读取诊断。' }); return true;
  }
  try { api.reply(res, 200, await readDiagnostics(api, { force: url.searchParams.get('refresh') === '1' })); }
  catch { api.reply(res, 503, { error: 'diagnostics-unavailable' }); }
  return true;
}
