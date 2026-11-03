import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./account-login.py', import.meta.url));
const flows = new Map();
const terminal = state => ['done','failed','cancelled','expired'].includes(state);
const hosts = {
  claude: ['claude.ai','claude.com','console.anthropic.com','platform.claude.com'],
  codex: ['auth.openai.com','chatgpt.com'],
};

// Only these fields leave the bridge. The raw terminal stream can contain
// authorization data, so it is never logged or forwarded to the page.
export function loginPrompt(tool, output) {
  const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  let url = '';
  for (const match of text.matchAll(/https:\/\/[^\s\x00-\x1f\x7f<>"]{1,8192}(?=[\s\x00-\x1f\x7f])/g)) {
    try {
      const target = new URL(match[0]);
      if (!hosts[tool].includes(target.hostname) || target.port || target.username || target.password) continue;
      if (tool === 'claude' ? !/\/oauth\/authorize\/?$/.test(target.pathname) : !/\/(?:codex\/device|activate)\/?$/.test(target.pathname)) continue;
      url = target.href;
      break;
    } catch {}
  }
  const deviceCode = tool === 'codex' ? text.match(/one-time code[^\n]*\n\s*([A-Z0-9]{3,6}-[A-Z0-9]{3,6})(?=\s)/i)?.[1] || '' : '';
  const needsCode = tool === 'claude' && /paste (?:the )?code here[^\n]*[>:]/i.test(text);
  return {url, deviceCode, needsCode};
}

function finish(flow, state) {
  if (terminal(flow.state)) return;
  flow.state = state;
  clearTimeout(flow.timer);
  flow.url = ''; flow.deviceCode = ''; flow.needsCode = false; flow.output = '';
  // Keep the non-sensitive outcome briefly for the requesting page.
  setTimeout(() => flows.delete(flow.id), 60000).unref();
}
function stop(flow, state) {
  if (terminal(flow.state)) return;
  finish(flow, state);
  flow.child.kill('SIGTERM');
  flow.child.stdin.end();
}
function view(flow) {
  return {id:flow.id, state:flow.state, url:flow.url, deviceCode:flow.deviceCode, needsCode:flow.needsCode};
}
function start(tool, slot) {
  const active = [...flows.values()].filter(f => !terminal(f.state));
  if (active.length >= 4 || active.some(f => f.tool === tool && f.slot === slot)) throw new Error('login-busy');
  const child = spawn('/usr/bin/python3',[helper,'manual',tool,'--slot=' + slot],{stdio:['pipe','pipe','ignore']});
  const flow = {id:randomUUID(), tool, slot, child, state:'waiting', output:'',url:'',deviceCode:'',needsCode:false};
  flows.set(flow.id, flow);
  flow.timer = setTimeout(() => stop(flow,'expired'), 15 * 60 * 1000);
  flow.timer.unref();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    if (terminal(flow.state) || flow.state === 'submitted') return;
    flow.output = (flow.output + chunk).slice(-32000);
    const prompt = loginPrompt(tool, flow.output);
    if (prompt.url) flow.url = prompt.url;
    if (prompt.deviceCode) flow.deviceCode = prompt.deviceCode;
    flow.needsCode = !!flow.url && prompt.needsCode;
  });
  child.once('error', () => finish(flow,'failed'));
  child.once('close', code => finish(flow,code === 0 ? 'done' : 'failed'));
  child.stdin.on('error', () => stop(flow,'failed'));
  return flow;
}

export function manualLogin(action, body) {
  if (action === 'start') {
    if (!Object.hasOwn(hosts,body.tool) || typeof body.slot !== 'string' || body.slot.length > 128 || /[\x00-\x1f\x7f]/.test(body.slot)) throw new Error('invalid-account');
    return view(start(body.tool,body.slot));
  }
  const flow = flows.get(body.id);
  if (!flow) throw new Error('login-expired');
  if (action === 'cancel') stop(flow,'cancelled');
  else if (action === 'submit') {
    if (flow.state !== 'waiting' || !flow.needsCode || flow.tool !== 'claude') throw new Error('not-waiting-for-code');
    if (typeof body.code !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(body.code) || /[\r\n]/.test(body.code)) throw new Error('invalid-code');
    flow.state = 'submitted'; flow.output = ''; flow.url = ''; flow.needsCode = false;
    flow.child.stdin.write(body.code + '\n');
  }
  return view(flow);
}
