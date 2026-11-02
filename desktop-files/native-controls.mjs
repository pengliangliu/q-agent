import { execFile } from 'node:child_process';

// All native menu/approval/model actions share one short-lived session lock.
const active = new Set();

export function acquireNativeControl(sessionId) {
  if (active.has(sessionId)) return null;
  active.add(sessionId);
  return () => active.delete(sessionId);
}

// Call only after rereading and matching the active native menu. The CLI's
// ordinary bare-key guard mistakes dim menu numbers for composer suggestions
// in 16-color terminals and presses Escape. Its TUI stream path sends the exact
// named key to the same authoritative primary window, without that extra key.
export async function sendVerifiedMenuKey(row, key, api) {
  if (!['Up', 'Down', 'Left', 'Right', 'Enter', 'Escape', 'Space'].includes(key)) throw new Error('原生菜单按键无效。');
  const args = [...(row.profile ? ['-p', row.profile] : []), 'session', 'send-keys', row.id, '--stream', '--primary', '--json'];
  const input = 'N ' + key + '\n';
  const options = { timeout: 20000, maxBuffer: 2 * 1024 * 1024 };
  const execute = api.execInput || ((file, arguments_, text, settings) => new Promise((resolve, reject) => {
    const child = execFile(file, arguments_, settings, (error, stdout) => {
      if (error && !stdout) reject(error);
      else resolve({ stdout });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(text);
  }));
  try {
    const { stdout } = await execute(api.deck, args, input, options);
    return JSON.parse(stdout);
  } catch { throw new Error('原生菜单按键结果未确认，请刷新核对；不会自动重发。'); }
}

const clean = value => String(value || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
function dimStyle(current, sequence) {
  const codes = (sequence || '0').split(';').map(Number);
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index];
    // Extended RGB/palette color arguments are values, not SGR attributes.
    if ([38, 48, 58].includes(code)) { index += codes[index + 1] === 2 ? 4 : codes[index + 1] === 5 ? 2 : 0; continue; }
    if (code === 0 || code === 22) current = false;
    if (code === 2) current = true;
  }
  return current;
}
function dimOnly(raw) {
  let dim = false;
  for (const part of raw.matchAll(/\x1b\[([\d;]*)m|([^\x1b]+)/g)) {
    if (part[1] !== undefined) dim = dimStyle(dim, part[1]);
    else if (part[2].trim() && !dim) return false;
  }
  return true;
}

function withoutDimHint(raw) {
  let dim = false, hinted = false, result = '';
  for (const part of raw.matchAll(/\x1b\[([\d;]*)m|([^\x1b]+)/g)) {
    if (part[1] !== undefined) dim = dimStyle(dim, part[1]);
    else if (dim && part[2].trim()) hinted = true;
    else if (!dim) {
      if (hinted && part[2].trim()) return null;
      result += part[2];
    }
  }
  return result.trim();
}

export function nativeComposer(tool, content, expected = null) {
  const raw = String(content || '').split('\n'), lines = raw.map(clean);
  const glyph = tool === 'claude' ? '❯' : '›';
  const index = lines.findLastIndex(line => new RegExp('^\\s*' + glyph + '(?:\\s|$)').test(line));
  if (index < 0 || lines.slice(-70).some(line => /esc to interrupt|Queued follow-up inputs/i.test(line))) return false;
  const next = (lines[index + 1] || '').trim();
  if (tool === 'claude' ? !/^─{5,}/.test(next) : next !== '') return false;
  const value = lines[index].slice(lines[index].indexOf(glyph) + 1).trim();
  const input = raw[index].slice(raw[index].indexOf(glyph) + 1);
  if (expected !== null) {
    if (value !== expected.trim() && withoutDimHint(input) !== expected.trim()) return false;
    return !lines.slice(Math.max(0, index - 12), index).some(line => /^\s*[❯›]?\s*\/\w+\s{2,}\S/.test(line));
  }
  return !value || dimOnly(input);
}
