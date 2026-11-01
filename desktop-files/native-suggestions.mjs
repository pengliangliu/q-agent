import crypto from 'node:crypto';

const clean = value => String(value || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const placeholders = /^(?:Ask Codex to do anything|Ask anything|What would you like to do\?|Type (?:something\.?|your message while the session is set up)|Press up to .+|Try ".*"|Implement \{.*\}|Explain (?:this codebase|@filename)|Find and fix a bug in @filename|Write tests for @filename|Improve documentation in @filename)$/i;

// Read only ghost text: any normal-intensity character is an operator's draft.
// Claude may paint the first ghost character as its inverse cursor, followed
// immediately by dim text. The rest still has to remain dim after every reset.
function ghostText(raw) {
  let dim = false, inverse = false, cursor = '', text = '', visible = false;
  for (const part of raw.matchAll(/\x1b\[([\d;]*)m|([^\x1b]+)/g)) {
    if (part[1] !== undefined) {
      const codes = (part[1] || '0').split(';').map(Number);
      for (let index = 0; index < codes.length; index++) {
        const code = codes[index];
        if ([38, 48, 58].includes(code)) { index += codes[index + 1] === 2 ? 4 : codes[index + 1] === 5 ? 2 : 0; continue; }
        if (code === 0) { dim = false; inverse = false; }
        if (code === 22) dim = false;
        if (code === 2) dim = true;
        if (code === 7) inverse = true;
        if (code === 27) inverse = false;
      }
    } else {
      const value = part[2];
      if (value.trim()) {
        if (!dim) {
          if (visible || cursor || !inverse || [...value.trim()].length !== 1) return null;
          cursor = value.trim();
        } else visible = true;
      }
      text += value;
    }
  }
  return visible ? text.trim() : null;
}

export function nativeSuggestionText(tool, pane) {
  if (!['claude', 'codex'].includes(tool)) return null;
  const raw = String(pane || '').split('\n'), lines = raw.map(clean);
  const glyph = tool === 'claude' ? '❯' : '›';
  const index = lines.findLastIndex(line => new RegExp('^\\s*' + glyph + '(?:\\s|$)').test(line));
  if (index < 0 || lines.slice(-70).some(line => /esc to interrupt|Queued follow-up inputs|ctrl\+x ctrl\+s to send now|Enter to select|Esc to cancel|enter (?:select|default).*esc back/i.test(line))) return null;
  let end = index + 1;
  if (tool === 'claude') {
    if (!/^\s*─{5,}/.test(lines[index - 1] || '')) return null;
    while (end < lines.length && end <= index + 8 && !/^\s*─{5,}/.test(lines[end])) end++;
    if (!/^\s*─{5,}/.test(lines[end] || '')) return null;
  } else if ((lines[end] || '').trim()) return null;
  const input = [raw[index].slice(raw[index].indexOf(glyph) + 1), ...raw.slice(index + 1, end)].join('\n');
  const text = ghostText(input);
  if (!text || text.length > 4000 || /[\x00-\x08\x0b-\x1f]/.test(text) || placeholders.test(text) || /^[/!]/.test(text)) return null;
  return text;
}

export function nativeSuggestion(row, pane, conversationId, turnId = '') {
  if (row.ssh_host || row.status !== 'waiting' || /approval|permission|menu|question/.test(row.substate || '') ||
      row.hook_status_fresh && row.hook_status === 'running' ||
      (row.queue || []).some(item => ['queued', 'typing', 'typed', 'submitted'].includes(item.state))) return null;
  const text = nativeSuggestionText(row.tool, pane);
  return text ? { text, conversationId, revision: hash([row.id, row.tmux_session, conversationId, turnId, text]) } : null;
}
