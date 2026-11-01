import fs from 'node:fs/promises';
import path from 'node:path';

const cache = new Map();
const windows = [{ key: 'five_hour', label: '5 小时', minutes: 300 }, { key: 'seven_day', label: '每周', minutes: 10080 }];
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function quotaSnapshot(tool, payload, now = Date.now()) {
  const observedAt = tool === 'claude' ? payload?.captured_at : payload?.timestamp;
  const observed = validDate(observedAt) && Date.parse(observedAt) <= now + 5000 ? observedAt : null;
  const limits = payload?.rate_limits;
  return { tool, observedAt: observed, source: tool === 'claude' ? 'native-statusline' : 'native-transcript',
    windows: windows.map(window => {
      const native = tool === 'claude' ? limits?.[window.key] : [limits?.primary, limits?.secondary]
        .find(item => item?.window_minutes === window.minutes);
      const used = tool === 'claude' ? native?.used_percentage : native?.used_percent;
      const reset = native?.resets_at;
      const valid = observed && typeof used === 'number' && Number.isFinite(used) && used >= 0 && used <= 100 &&
        typeof reset === 'number' && Number.isFinite(reset) && reset > 0 && reset < 8640000000000;
      const status = !valid ? 'unavailable' : reset * 1000 <= now ? 'expired' : now - Date.parse(observed) > 15 * 60 * 1000 ? 'historical' : 'current';
      return { key: window.key, label: window.label, status,
        remainingPercent: valid && status !== 'expired' ? Math.round((100 - used) * 10) / 10 : null,
        resetsAt: valid ? new Date(reset * 1000).toISOString() : null };
    }) };
}

export async function codexQuotaRecord(source) {
  if (typeof source !== 'string' || !path.isAbsolute(source) || !source.endsWith('.jsonl')) return null;
  const handle = await fs.open(source, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const size = Math.min(stat.size, 4 * 1024 * 1024), start = stat.size - size;
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start) text = text.slice(text.indexOf('\n') + 1);
    if (!text.endsWith('\n')) return null;
    const lines = text.split('\n');
    for (let index = lines.length - 1; index >= 0; index--) {
      let record;
      try { record = JSON.parse(lines[index]); } catch { continue; }
      const payload = record.payload;
      if (record.type !== 'event_msg' || payload?.type !== 'token_count' || !Object.hasOwn(payload, 'rate_limits')) continue;
      // A newer missing snapshot must not resurrect a different/older quota.
      return { timestamp: record.timestamp, rate_limits: payload.rate_limits };
    }
    return null;
  } finally { await handle.close(); }
}

async function readQuota(row, api) {
  const key = JSON.stringify([row.id, row.profile, row.tool, row.claude_session_id, row.codex_session_id, row.transcript_path]);
  const existing = cache.get(key);
  if (existing && Date.now() - existing.time < 30000) return existing.promise;
  const promise = (async () => {
    if (row.tool === 'codex') return codexQuotaRecord(row.transcript_path);
    const { stdout } = await api.exec(api.deck, [...(row.profile ? ['-p', row.profile] : []), 'usage', 'statusline', '--session', row.id, '--json'],
      { timeout: 20000, maxBuffer: 256 * 1024 });
    const payload = JSON.parse(stdout);
    return payload?.claude_session_id === row.claude_session_id ? payload : null;
  })().catch(error => { cache.delete(key); throw error; });
  cache.set(key, { time: Date.now(), promise });
  if (cache.size > 80) cache.delete(cache.keys().next().value);
  return promise;
}

export async function handleQuota(req, res, url, api) {
  if (url.pathname !== '/desktop/chat/quota') return false;
  if (req.method !== 'GET' || req.headers['x-agentdeck-desktop'] !== '1') {
    api.reply(res, 403, { error: '请从本地聊天界面读取额度。' }); return true;
  }
  const sessionId = url.searchParams.get('sessionId');
  try {
    const row = await api.session(sessionId);
    if (row.id !== sessionId || row.ssh_host || !['claude', 'codex'].includes(row.tool)) throw new Error('此会话没有本地额度数据。');
    const payload = await readQuota(row, api);
    api.reply(res, 200, { sessionId, ...quotaSnapshot(row.tool, payload) });
  } catch {
    api.reply(res, 200, { sessionId, error: '暂时无法读取原生额度。' });
  }
  return true;
}
