// All native menu/approval/model actions share one short-lived session lock.
const active = new Set();

export function acquireNativeControl(sessionId) {
  if (active.has(sessionId)) return null;
  active.add(sessionId);
  return () => active.delete(sessionId);
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
