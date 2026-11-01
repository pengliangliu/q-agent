import { html } from 'htm/preact'
import { useEffect, useState } from 'preact/hooks'
import { effect, signal } from '@preact/signals'
import { selectedIdSignal, selectedGroupSignal, selectSession } from './state.js'
import { activeTabSignal } from './uiState.js'
import { menuModelSignal } from './dataModel.js'
import { authHeaders } from './api.js'
import { addToast } from './toasts.js'
import { completionEnabledSignal, languageSignal } from './desktopPreferences.js'

const STORAGE_KEY = 'agentdeck.replyCompletions.v1'
const SYSTEM_KEY = 'agentdeck.replySystemNotifications'
const clientId = crypto.randomUUID()
const peers = new Map()
const candidates = new Set()
const inFlight = new Set()
const armedAt = Date.now()
let snapshotReady = false
let previousSessions = new Map()
let channel = null
const nativeHost = () => window.__agentDeckDesktop?.host === 'agentdeck-winforms' && window.__agentDeckDesktop.protocol === 1 &&
  window.__agentDeckDesktop.notifications === true && typeof window.chrome?.webview?.postMessage === 'function'

function readLedger() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    return { seen: Array.isArray(saved.seen) ? saved.seen.filter(id => typeof id === 'string').slice(-500) : [],
      unread: Array.isArray(saved.unread) ? saved.unread.filter(item => item?.id && item.sessionId).slice(-50) : [] }
  } catch (_) { return { seen: [], unread: [] } }
}

export const completionStateSignal = signal(readLedger())
const permissionSignal = signal(nativeHost() ? 'native' : typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
const systemEnabledSignal = signal((() => { try { return localStorage.getItem(SYSTEM_KEY) !== 'false' } catch (_) { return false } })())
const notificationErrorSignal = signal('')
const nativeStatusMessages = {
  Enabled: 'Windows 系统通知可用。',
  DisabledForUser: 'Windows 全局通知已关闭。',
  DisabledForApplication: 'Windows 已关闭 Q-agent 的系统通知。',
  DisabledByGroupPolicy: 'Windows 组策略已禁用系统通知。',
  DisabledByManifest: '当前应用未获得 Windows 系统通知能力。',
  Unavailable: 'Windows 系统通知服务暂不可用。',
}
const nativeStatusSignal = signal(nativeHost() ? { setting: window.__agentDeckDesktop.notificationStatus || '', message: '' } : null)

function presence() {
  const focused = document.visibilityState === 'visible' && document.hasFocus()
  return { clientId, focused, sessionId: focused && activeTabSignal.value === 'terminal' && !selectedGroupSignal.value ? selectedIdSignal.value : null, at: Date.now() }
}

function publishPresence() {
  const current = presence()
  peers.set(clientId, current)
  channel?.postMessage({ type: 'presence', ...current })
}

function writeLedger(value) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  completionStateSignal.value = value
}

async function withLedger(action) {
  if (navigator.locks?.request) return navigator.locks.request('agentdeck.replyCompletions', () => action(readLedger()))
  // Without cross-window locks, only the focused window emits alerts.
  return action(readLedger())
}

async function markRead(sessionId) {
  try {
    await withLedger(ledger => {
      const unread = sessionId ? ledger.unread.filter(item => item.sessionId !== sessionId) : []
      if (unread.length !== ledger.unread.length) writeLedger({ ...ledger, unread })
    })
  } catch (_) { notificationErrorSignal.value = '浏览器无法保存通知状态。' }
}

function openReply(sessionId) {
  selectSession(sessionId)
  activeTabSignal.value = 'terminal'
  markRead(sessionId)
}

function showToast(item) {
  if (completionEnabledSignal.value) addToast(languageSignal.value === 'en' ? `${item.title} finished replying` : `${item.title} 回复已完成`, 'success')
}

async function notifyCompletion(item) {
  let delivery
  try {
    delivery = await withLedger(ledger => {
      if (ledger.seen.includes(item.id)) return null
      if (!completionEnabledSignal.value) {
        writeLedger({ ...ledger, seen: [...ledger.seen, item.id].slice(-500) })
        return null
      }
      if (!navigator.locks?.request && !presence().focused) return null
      peers.set(clientId, presence())
      const active = [...peers.values()].filter(peer => Date.now() - peer.at < 30000 && peer.focused)
      const viewing = active.find(peer => peer.sessionId === item.sessionId)
      const target = viewing || active[0] || { clientId }
      writeLedger({ seen: [...ledger.seen, item.id].slice(-500),
        unread: viewing ? ledger.unread : [...ledger.unread, item].slice(-50) })
      return { target: target.clientId, background: active.length === 0 }
    })
  } catch (_) { notificationErrorSignal.value = '浏览器无法保存通知状态。'; return }
  if (!delivery || !completionEnabledSignal.value) return
  if (delivery.target === clientId) showToast(item)
  else channel?.postMessage({ type: 'toast', target: delivery.target, item })
  if (delivery.background && systemEnabledSignal.value && nativeHost()) {
    try { window.chrome.webview.postMessage({ type: 'agentdeck:notify', title: languageSignal.value === 'en' ? 'Reply complete' : '回复已完成', body: item.title, sessionId: item.sessionId, notificationId: item.id }) }
    catch (_) { notificationErrorSignal.value = '系统通知未能显示，完成提醒已保留在通知列表中。' }
  } else if (delivery.background && systemEnabledSignal.value && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const notification = new Notification(languageSignal.value === 'en' ? 'Reply complete' : '回复已完成', { body: item.title, icon: '/static/icons/agent-deck-192.png', tag: 'agentdeck-reply-' + item.id })
      notification.onclick = () => { window.focus(); openReply(item.sessionId); notification.close() }
    } catch (_) { notificationErrorSignal.value = '系统通知未能显示，完成提醒已保留在通知列表中。' }
  }
}

async function verifyCandidate(candidate) {
  const key = candidate.id + ':' + candidate.at
  if (inFlight.has(key)) return
  inFlight.add(key)
  try {
    for (const delay of [0, 600, 1400]) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      try {
        const response = await fetch('/desktop/chat/completion?' + new URLSearchParams({ sessionId: candidate.id }),
          { headers: authHeaders({ 'X-AgentDeck-Desktop': '1' }) })
        if (!response.ok) continue
        const data = await response.json(), completion = data.completion
        if (!completion?.id || data.sessionId !== candidate.id) continue
        const completedAt = Date.parse(completion.timestamp)
        if (!Number.isFinite(completedAt) || completedAt < armedAt || completedAt > Date.parse(candidate.at) + 15000) return
        await notifyCompletion({ id: completion.id, sessionId: candidate.id, title: data.title || candidate.title || '会话',
          tool: data.tool || '', conversationId: data.conversationId || '', timestamp: completion.timestamp })
        return
      } catch (_) { /* A status candidate without native evidence stays silent. */ }
    }
  } finally { inFlight.delete(key) }
}

// Reuse the official command-center SSE as a candidate feed. Its initial
// snapshot and running-to-waiting transitions alone never trigger an alert.
export function handleCompletionSnapshot(snapshot) {
  if (!snapshotReady) { snapshotReady = true; return }
  for (const candidate of snapshot?.recentlyCompleted || []) {
    if (!candidate?.id || !Number.isFinite(Date.parse(candidate.at)) || Date.parse(candidate.at) < armedAt) continue
    const key = candidate.id + ':' + candidate.at
    if (candidates.has(key)) continue
    candidates.add(key)
    if (candidates.size > 500) candidates.delete(candidates.values().next().value)
    verifyCandidate(candidate)
  }
}

function handleBackgroundTransitions(sessions) {
  const next = new Map()
  for (const session of sessions) {
    const substate = session.raw?.substate || ''
    const previous = previousSessions.get(session.id)
    next.set(session.id, { status: session.status, substate })
    if (session.tool === 'claude' && previous?.status === 'running' && previous.substate !== 'background-work' &&
        session.status === 'running' && substate === 'background-work') {
      verifyCandidate({ id: session.id, title: session.title, at: new Date().toISOString() })
    }
  }
  previousSessions = next
}

export function CompletionNotifications() {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const unread = completionStateSignal.value.unread
  const permission = permissionSignal.value
  const enabled = systemEnabledSignal.value && ['granted', 'native'].includes(permission)
  const nativeStatus = nativeStatusSignal.value

  useEffect(() => {
    if (!document.querySelector('link[data-completion-notifications]')) {
      const css = document.createElement('link')
      css.rel = 'stylesheet'; css.href = '/static/app/completionNotifications.css'; css.dataset.completionNotifications = 'true'
      document.head.appendChild(css)
    }
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel('agentdeck.replyCompletions')
      channel.onmessage = ({ data }) => {
        if (data?.type === 'presence' && data.clientId !== clientId) peers.set(data.clientId, data)
        if (data?.type === 'hello') publishPresence()
        if (data?.type === 'bye') peers.delete(data.clientId)
        if (data?.type === 'toast' && data.target === clientId) showToast(data.item)
      }
      channel.postMessage({ type: 'hello' })
    }
    const sync = () => {
      if (nativeHost()) permissionSignal.value = 'native'
      else if (typeof Notification !== 'undefined') permissionSignal.value = Notification.permission
      publishPresence()
      const current = presence()
      if (current.sessionId) markRead(current.sessionId)
    }
    const storage = event => {
      if (event.key === STORAGE_KEY) completionStateSignal.value = readLedger()
      if (event.key === SYSTEM_KEY) systemEnabledSignal.value = event.newValue !== 'false'
    }
    const nativeClick = event => {
      if (event.data?.type === 'agentdeck:notification-click' && typeof event.data.sessionId === 'string' && /^[A-Za-z0-9-]+$/.test(event.data.sessionId)) {
        openReply(event.data.sessionId)
      }
      if (['agentdeck:notification-status', 'agentdeck:notification-result'].includes(event.data?.type)) {
        const status = event.data
        if (Object.prototype.hasOwnProperty.call(nativeStatusMessages, status.setting)) {
          nativeStatusSignal.value = { setting: status.setting, message: status.type === 'agentdeck:notification-status' || status.status === 'blocked' ? status.message || '' : '' }
        }
        if (status.type === 'agentdeck:notification-result' && status.status === 'failed') {
          notificationErrorSignal.value = status.message || 'Windows 未能接收系统通知，站内提示和未读列表仍可使用。'
        }
      }
    }
    if (nativeHost()) {
      window.chrome.webview.addEventListener('message', nativeClick)
      window.chrome.webview.postMessage({ type: 'agentdeck:ready' })
    }
    const dispose = effect(() => { selectedIdSignal.value; selectedGroupSignal.value; activeTabSignal.value; sync() })
    const disposeBackground = effect(() => handleBackgroundTransitions(menuModelSignal.value.sessions || []))
    const timer = setInterval(publishPresence, 10000)
    window.addEventListener('focus', sync); window.addEventListener('blur', sync)
    window.addEventListener('storage', storage); document.addEventListener('visibilitychange', sync)
    return () => {
      dispose(); disposeBackground(); clearInterval(timer); channel?.postMessage({ type: 'bye', clientId }); channel?.close(); channel = null
      window.removeEventListener('focus', sync); window.removeEventListener('blur', sync)
      window.removeEventListener('storage', storage); document.removeEventListener('visibilitychange', sync)
      if (nativeHost()) window.chrome.webview.removeEventListener('message', nativeClick)
    }
  }, [])

  async function toggleSystem() {
    if (busy || permission === 'unsupported') return
    setBusy(true); notificationErrorSignal.value = ''
    try {
      if (enabled) { systemEnabledSignal.value = false; localStorage.setItem(SYSTEM_KEY, 'false'); return }
      if (nativeHost()) { systemEnabledSignal.value = true; localStorage.setItem(SYSTEM_KEY, 'true'); return }
      const result = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
      permissionSignal.value = result
      if (result === 'granted') { systemEnabledSignal.value = true; localStorage.setItem(SYSTEM_KEY, 'true') }
    } catch (_) { notificationErrorSignal.value = '未能开启系统通知，请检查浏览器的通知设置。' }
    finally { setBusy(false) }
  }

  return html`<div class="completion-notifications" onKeyDown=${event => { event.stopPropagation(); if (event.key === 'Escape') setOpen(false) }}>
    <button class="icon-btn completion-toggle" type="button" aria-label=${unread.length ? `完成通知，${unread.length} 条未读` : '完成通知'} title="回复完成通知" aria-expanded=${open} onClick=${() => setOpen(value => !value)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>
      ${unread.length > 0 && html`<span class="completion-count">${unread.length}</span>`}
    </button>
    ${open && html`<section class="completion-popover" aria-label="回复完成通知"><header><strong>回复完成通知</strong>
      <button type="button" aria-label="关闭完成通知" onClick=${() => setOpen(false)}>×</button></header>
      ${!completionEnabledSignal.value && html`<p class="completion-empty">回复完成提示已在设置中关闭。</p>`}
      <div class="completion-settings"><button type="button" disabled=${busy || permission === 'unsupported' || permission === 'denied'} onClick=${toggleSystem}>
        ${busy ? '正在请求权限…' : permission === 'native' ? enabled ? '关闭本应用系统提醒' : '开启本应用系统提醒' : permission === 'unsupported' ? '浏览器不支持系统通知' : permission === 'denied' ? '浏览器已阻止系统通知' : enabled ? '关闭系统通知' : '开启系统通知'}</button>
        <p>${permission === 'native' ? (nativeStatusMessages[nativeStatus?.setting] || nativeStatus?.message || '正在确认 Windows 通知状态。') + ' 站内完成提示和未读列表仍可使用。' : permission === 'denied' ? '可在浏览器的网站设置中允许通知。' : '页面打开期间提醒。当前会话轻提示，后台回复加入未读列表。'}</p>
        ${notificationErrorSignal.value && html`<p role="status">${notificationErrorSignal.value}</p>`}</div>
      ${unread.length ? html`<div class="completion-list">${[...unread].reverse().map(item => html`<button type="button" key=${item.id} class="completion-entry"
          onClick=${() => { openReply(item.sessionId); setOpen(false) }}><strong translate="no">${item.title}</strong><span>回复已完成 · 点击查看</span></button>`)}</div>
        <button class="completion-mark-read" type="button" onClick=${() => markRead()}>全部标为已读</button>`
        : html`<p class="completion-empty">暂无未读的完成回复</p>`}
    </section>`}
  </div>`
}
