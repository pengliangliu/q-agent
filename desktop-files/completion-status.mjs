import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_TAIL = 4 * 1024 * 1024;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

// Match the chat-history display normalization without returning message text.
export function completionReplyHash(value) {
  const text = String(value || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  const characters = [...text];
  return hash(characters.length > 24000 ? characters.slice(0, 24000).join('') + '\n[内容较长，已截断显示]' : text);
}

// Only native end-of-turn records count. Ordinary assistant prose, tool
// results, idle screens and status transitions are not completion evidence.
export function completionFromRecords(records, tool, conversationId, nativeId = '', includeReplyHash = false) {
  for (let index = records.length - 1; index >= 0; index--) {
    const row = records[index];
    if (tool === 'claude') {
      if (row.isSidechain || row.isCompactSummary) continue;
      if (row.isApiErrorMessage || row.type === 'system' && row.subtype === 'api_error') return null;
      if (row.isMeta) continue;
      if (row.type === 'user') return null;
      if (row.type === 'system' && row.subtype === 'compact_boundary') return null;
      if (row.type !== 'assistant') continue;
      if (nativeId && row.sessionId && row.sessionId !== nativeId) return null;
      const message = row.message || {};
      const content = message.content;
      const text = Array.isArray(content) && content.some(block => block?.type === 'text' && typeof block.text === 'string' && block.text.trim());
      const tools = Array.isArray(content) && content.some(block => block?.type === 'tool_use');
      const id = message.id || row.uuid;
      if (!['end_turn', 'stop_sequence'].includes(message.stop_reason) || !text || tools || !id || !validTime(row.timestamp)) return null;
      return { id: hash([conversationId, id]), timestamp: row.timestamp };
    }
    if (tool === 'codex') {
      const payload = row.payload || {};
      if (row.type === 'event_msg') {
        if (payload.type === 'task_complete') {
          if (!payload.turn_id || typeof payload.last_agent_message !== 'string' || !payload.last_agent_message.trim() || !validTime(row.timestamp)) return null;
          return { id: hash([conversationId, payload.turn_id]), timestamp: row.timestamp,
            ...(includeReplyHash ? { replyHash: completionReplyHash(payload.last_agent_message) } : {}) };
        }
        if (['task_started', 'turn_started', 'turn_aborted', 'user_message', 'error'].includes(payload.type)) return null;
      }
      if (row.type === 'response_item' && ['message', 'function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output'].includes(payload.type)) return null;
      if (row.type === 'turn_context') return null;
    }
  }
  return null;
}

export async function inspectCompletion(row, includeReplyHash = false) {
  const nativeId = row.tool === 'claude' ? row.claude_session_id : row.codex_session_id;
  const source = row.transcript_path;
  const conversationId = hash([row.tool, nativeId || '', source || '']);
  const result = { sessionId: row.id, title: row.title || row.id, tool: row.tool, conversationId, completion: null };
  const completedState = ['waiting', 'idle'].includes(row.status) || (row.tool === 'claude' && row.status === 'running' && row.substate === 'background-work');
  if (!['claude', 'codex'].includes(row.tool) || !completedState || row.ssh_host ||
      /approval|permission|user-input|question|menu|starting|blocked/.test(row.substate || '') ||
      typeof source !== 'string' || !path.isAbsolute(source) || !source.endsWith('.jsonl')) return result;
  const file = await fsp.open(source, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return result;
    const size = Math.min(stat.size, MAX_TAIL), start = stat.size - size;
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await file.read(buffer, 0, size, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start) text = text.slice(text.indexOf('\n') + 1);
    if (!text.endsWith('\n')) return result; // A newer native row may still be in flight.
    const lines = text.split('\n');
    const records = [];
    for (const line of lines) {
      try { const value = JSON.parse(line); if (value && typeof value === 'object') records.push(value); } catch { /* Partial/malformed native rows do not prove completion. */ }
    }
    result.completion = completionFromRecords(records, row.tool, conversationId, nativeId, includeReplyHash);
    return result;
  } finally { await file.close(); }
}

export async function handleCompletion(req, res, url, api) {
  if (url.pathname !== '/desktop/chat/completion') return false;
  if (req.method !== 'GET' || req.headers['x-agentdeck-desktop'] !== '1') {
    api.reply(res, 403, { error: '请从本地 Agent Deck 界面读取完成状态。' });
    return true;
  }
  try {
    const sessionId = url.searchParams.get('sessionId');
    const row = await api.session(sessionId);
    if (row.id !== sessionId) throw new Error('会话标识不一致。');
    api.reply(res, 200, await inspectCompletion(row));
  } catch {
    api.reply(res, 200, { sessionId: url.searchParams.get('sessionId'), completion: null });
  }
  return true;
}
