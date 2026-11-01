import os from 'node:os';
import path from 'node:path';

export async function handleTerminal(req, res, url, api) {
  if (url.pathname !== '/desktop/terminal/open') return false;
  if (req.method !== 'POST' || req.headers['x-agentdeck-desktop'] !== '1') {
    api.reply(res, 403, { error: '请从本地 Agent Deck 界面打开终端。' });
    return true;
  }
  const body = await api.bodyJSON(req);
  const row = await api.session(body.sessionId);
  if (!['running', 'waiting', 'idle'].includes(row.status) || !row.tmux_session) {
    api.reply(res, 409, { error: '当前会话未运行，请先启动会话。' });
    return true;
  }
  const { stdout } = await api.exec(path.join(os.homedir(), '.local/bin/agent-deck-files'),
    ['terminal', '--session', row.id, '--profile', row.profile || 'default'], { timeout: 30000 });
  const result = JSON.parse(stdout);
  if (result.success !== true || result.sessionId !== row.id) throw new Error('未能确认终端已打开，请检查窗口后重试。');
  api.reply(res, 200, { success: true, sessionId: row.id, opened: true,
    message: '已打开独立终端，正在连接当前会话。' });
  return true;
}
