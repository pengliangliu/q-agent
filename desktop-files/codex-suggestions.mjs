import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { nativeComposer } from './native-controls.mjs';
import { completionReplyHash, inspectCompletion } from './completion-status.mjs';

const completions = new Map();
const fallback = '请根据刚才的结果，说明下一步最值得处理的一项及原因。';

export function codexFollowupText(reply) {
  const lines = String(reply || '').replace(/(```|~~~)[^\n]*\n[\s\S]*?(?:\1|$)/g, '')
    .replace(/<oai-mem-citation>[\s\S]*?(?:<\/oai-mem-citation>|$)/g, '')
    .split('\n').map(line => line.trim().replace(/^#{1,6}\s+/, '').replace(/^(?:[-*+]\s+|\d+[.)、]\s*)/, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').trim())
    .filter(line => line && !/^={3}|^<[^>]+>|^\|/.test(line));
  let heading = false;
  for (const line of lines) {
    const match = line.match(/^(?:下一步(?:建议|计划)?|接下来|后续(?:建议|计划)?|待办(?:事项)?|Next steps?)\s*[:：]?\s*(.*)$/i);
    if (match && !match[1]) { heading = true; continue; }
    const candidate = (match ? match[1] : heading ? line : '').replace(/[。；;.!！?？]+$/, '').trim();
    heading = false;
    if (candidate.length >= 4 && candidate.length <= 90 &&
        !/[<>\[\]{}=]|https?:\/\/|(?:^|\s)(?:\/|[A-Za-z]:[\\/])|\d{1,2}:\d{2}|\d{4}[-年/]\d{1,2}|如果|若|建议你|请你|\b(?:if|you)\b/i.test(candidate)) {
      return `关于“${candidate}”，具体该怎样推进？`;
    }
  }
  if (lines.some(line => /尚未|仍未|未完成|待解决|未解决|受阻|阻塞|失败|超时|\b(?:unresolved|blocked|failed|timed out)\b/i.test(line))) {
    return '请说明刚才的结果是否还有未解决的问题，以及下一步需要满足哪些条件。';
  }
  return fallback;
}

// Reuse native completion evidence once per transcript change. Suggestions are
// local editable questions; this never starts a model turn or a background agent.
export async function codexContextSuggestion(row, pane, conversationId, messages) {
  if (row.tool !== 'codex' || row.ssh_host || row.status !== 'waiting' ||
      /approval|permission|menu|question|user-input|blocked/.test(row.substate || '') ||
      row.hook_status_fresh && row.hook_status === 'running' ||
      (row.queue || []).some(item => ['queued', 'typing', 'typed', 'submitted'].includes(item.state)) ||
      !nativeComposer('codex', pane) || /Enter to select|Esc to cancel|enter (?:select|default).*esc back/i.test(pane)) return null;
  const reply = (messages || []).findLast(message => ['user', 'assistant'].includes(message.role));
  if (reply?.role !== 'assistant' || !reply.text?.trim()) return null;
  const stat = await fs.stat(row.transcript_path).catch(() => null);
  if (!stat?.isFile()) return null;
  const key = JSON.stringify([conversationId, row.transcript_path, stat.size, stat.mtimeMs]);
  let cached = completions.get(row.id);
  if (cached?.key !== key) {
    cached = { key, promise: inspectCompletion(row, true).then(result => result.completion).catch(() => null) };
    completions.set(row.id, cached);
    if (completions.size > 80) completions.delete(completions.keys().next().value);
  }
  const completion = await cached.promise;
  if (!completion || completion.replyHash !== completionReplyHash(reply.text) ||
      !Number.isFinite(Date.parse(reply.timestamp)) || Date.parse(reply.timestamp) > Date.parse(completion.timestamp)) return null;
  const text = codexFollowupText(reply.text);
  return { text, conversationId, source: 'local-context',
    revision: crypto.createHash('sha256').update(JSON.stringify([row.id, conversationId, completion.id, reply.id, text])).digest('hex') };
}
