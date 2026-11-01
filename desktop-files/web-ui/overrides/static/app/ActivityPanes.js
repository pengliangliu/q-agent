import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { menuModelSignal } from './dataModel.js'
import { selectSession, connectionSignal } from './state.js'
import { activeTabSignal } from './uiState.js'

const labels = { running: '进行中', waiting: '待输入', idle: '空闲', stopped: '已停止', error: '需检查', starting: '正在启动' }
function openSession(id) { selectSession(id); activeTabSignal.value = 'terminal' }
function SessionRow({ session, child = false }) {
  return html`<button class=${'activity-session ' + (child ? 'activity-child' : '')} onClick=${() => openSession(session.id)}>
    <span aria-hidden="true">${child ? '└' : '◉'}</span><span class="activity-title" data-desktop-preserve>${session.title}</span>
    <span>${session.tool}</span><span class=${'status-chip ' + session.status}>${labels[session.status] || session.status}</span><span>查看会话 →</span>
  </button>`
}

export function CoordinationPane() {
  const sessions = menuModelSignal.value.sessions
  const [configured, setConfigured] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    fetch('/desktop/conductors', { signal: controller.signal }).then(async response => {
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '协调器列表加载失败')
      setConfigured(data.conductors || [])
    }).catch(e => { if (e.name !== 'AbortError') setError(e.message) })
    return () => controller.abort()
  }, [])
  const parentOf = s => s.parent || s.raw?.parentSessionId || s.raw?.parent_session_id
  const parents = sessions.filter(parent => sessions.some(child => parentOf(child) === parent.id))
  return html`<section class="activity-page" aria-label="协调器">
    <header><h1>协调器与会话协作</h1><p>查看真实的主会话、子会话和执行状态。</p></header>
    <h2>已配置的协调器</h2>
    ${error && html`<p role="alert">${error}</p>`}
    ${configured === null && !error && html`<p>正在读取协调器配置…</p>`}
    ${configured?.length === 0 && html`<p class="activity-note">尚未配置独立协调器。现有 Claude 主控与 Codex 执行会话仍按原规则协作，下方展示已记录的父子关系。</p>`}
    ${configured?.map(c => html`<div class="activity-config" key=${c.name}><strong data-desktop-preserve>${c.name}</strong><span>${c.profile}</span><span>${c.status}</span>
      ${c.sessionId && html`<button class="btn" onClick=${() => openSession(c.sessionId)}>打开会话</button>`}</div>`)}
    <h2>父子会话关系</h2>
    ${!parents.length && html`<p class="activity-note">当前没有已登记的父子会话关系。</p>`}
    ${parents.map(parent => html`<div class="activity-family" key=${parent.id}><${SessionRow} session=${parent}/>
      ${sessions.filter(child => parentOf(child) === parent.id).map(child => html`<${SessionRow} key=${child.id} session=${child} child />`)}</div>`)}
  </section>`
}

export function MonitoringPane() {
  const sessions = menuModelSignal.value.sessions
  const connection = connectionSignal.value
  const [filter, setFilter] = useState('active')
  const [events, setEvents] = useState([])
  const previous = useRef(null)
  useEffect(() => {
    const next = new Map(sessions.map(s => [s.id, s.status]))
    if (previous.current) {
      const before = previous.current
      const changed = sessions.filter(s => before.has(s.id) && before.get(s.id) !== s.status)
      if (changed.length) setEvents(old => [...changed.map(s => ({ id: s.id, title: s.title, from: before.get(s.id), to: s.status, at: Date.now() })), ...old].slice(0, 40))
    }
    previous.current = next
  }, [sessions])
  const visible = sessions.filter(s => filter === 'all' || (filter === 'active' ? ['running', 'waiting', 'starting'].includes(s.status) : s.status === filter))
  return html`<section class="activity-page" aria-label="监视器">
    <header><h1>会话状态监视</h1><p>${connection === 'connected' ? '正在接收 WSL 后端的实时状态。' : '状态连接未就绪，当前列表可能尚未更新。'}</p></header>
    <div class="activity-filters">${[['active', '运行与待输入'], ['error', '需检查'], ['all', '全部会话']].map(([value, title]) => html`
      <button class=${'btn ' + (filter === value ? 'primary' : 'ghost')} aria-pressed=${filter === value} onClick=${() => setFilter(value)}>${title}</button>`)}</div>
    <div class="activity-family">${visible.map(s => html`<${SessionRow} key=${s.id} session=${s}/>`)}${!visible.length && html`<p class="activity-note">此筛选条件下暂无会话。</p>`}</div>
    <h2>本页打开后的状态变化</h2>
    ${!events.length && html`<p class="activity-note">暂未观察到状态变化；有变化时会显示在这里。</p>`}
    ${events.map((e, i) => html`<div class="activity-event" key=${e.at + ':' + i}><time>${new Date(e.at).toLocaleTimeString('zh-CN')}</time>
      <button onClick=${() => openSession(e.id)} data-desktop-preserve>${e.title}</button><span>${labels[e.from] || e.from} → ${labels[e.to] || e.to}</span></div>`)}
  </section>`
}
