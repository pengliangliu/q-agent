import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'
import { authHeaders } from './api.js'

// Cached document shells may predate the quota stylesheet.
const quotaStylesheet = new URL('./chat-quota.css', import.meta.url).href
if (![...document.querySelectorAll('link[rel="stylesheet"]')].some(link => link.href === quotaStylesheet)) {
  const link = document.createElement('link')
  link.rel = 'stylesheet'; link.href = quotaStylesheet
  document.head.append(link)
}

const time = value => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : ''
const emptyWindows = [{ key: 'five_hour', label: '5 小时' }, { key: 'seven_day', label: '每周' }]

export function ChatQuota({ sessionId, tool }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!['claude', 'codex'].includes(tool)) return
    const controller = new AbortController()
    let alive = true, inFlight = false
    setData(null); setError('')
    async function refresh() {
      if (inFlight || document.visibilityState !== 'visible') return
      inFlight = true
      try {
        const response = await fetch('/desktop/chat/quota?' + new URLSearchParams({ sessionId }),
          { headers: authHeaders({ 'X-AgentDeck-Desktop': '1' }), signal: controller.signal })
        const next = await response.json()
        if (!response.ok || next.error || next.sessionId !== sessionId || next.tool !== tool) throw new Error('暂时无法读取额度')
        if (alive) { setData(next); setError('') }
      } catch (err) {
        if (alive && err.name !== 'AbortError') { setData(null); setError('暂时无法读取额度') }
      } finally { inFlight = false }
    }
    refresh()
    const timer = setInterval(refresh, 30000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { alive = false; controller.abort(); clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [sessionId, tool])
  if (!['claude', 'codex'].includes(tool)) return null
  return html`<section class="chat-quota" aria-label="会话额度">
    ${(data?.windows || emptyWindows).map(window => {
      const expired = window.status === 'expired' || window.resetsAt && Date.parse(window.resetsAt) <= Date.now()
      const known = !expired && Number.isFinite(window.remainingPercent)
      const label = known ? (window.status === 'historical' ? '上次剩余 ' : '剩余 ') + window.remainingPercent + '%' :
        error ? '读取失败' : !data ? '读取中…' : expired ? '重置后待更新' : '原生未提供'
      return html`<div class="chat-quota-window" key=${window.key} title=${window.label + ' · ' + label + (window.resetsAt && !expired ? ' · ' + time(window.resetsAt) + ' 重置（北京时间）' : '')}>
        <span class="chat-quota-period">${window.label}</span><strong>${label}</strong>
        ${known && html`<span class="chat-quota-track" role="progressbar" aria-label=${window.label + '剩余额度'} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${window.remainingPercent}><span style=${{ width: window.remainingPercent + '%' }} /></span>`}
        ${window.resetsAt && !expired && html`<small>${time(window.resetsAt)} 重置</small>`}
      </div>`
    })}
  </section>`
}
