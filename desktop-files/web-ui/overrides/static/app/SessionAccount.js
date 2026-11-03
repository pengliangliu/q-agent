import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { authHeaders } from './api.js'
import { beginUiMutation } from './uiOperations.js'
import { languageSignal } from './desktopPreferences.js'

export async function accountRequest(route, body, signal) {
  const release = body ? beginUiMutation() : null
  try {
    const response = await fetch('/desktop/accounts/' + route, { method:body ? 'POST' : 'GET', signal,
      headers:authHeaders({'X-AgentDeck-Desktop':'1'}), ...(body ? {body:JSON.stringify(body)} : {}) })
    const data = await response.json()
    if (!response.ok || data.error) throw new Error(data.error || '账号操作未完成。')
    return data
  } finally { release?.() }
}

export function SessionAccount({sessionId, tool, observedAccount, disabled, onBusyChange, onSwitch}) {
  const [open,setOpen] = useState(false), [data,setData] = useState(null)
  const [target,setTarget] = useState(''), [busy,setBusy] = useState(false), [error,setError] = useState('')
  const [notice,setNotice] = useState('')
  const controller = useRef(null), submitting = useRef(false), alive = useRef(true)
  const en = languageSignal.value === 'en'
  const t = (zh, english) => en ? english : zh
  async function read() {
    controller.current?.abort()
    const ctrl = new AbortController()
    controller.current = ctrl
    try {
      const info = await accountRequest('current?' + new URLSearchParams({sessionId,tool}), undefined, ctrl.signal)
      if (!ctrl.signal.aborted) { setData(info); setTarget(info.account) }
    } catch (err) { if (!ctrl.signal.aborted) { setData(null); setError(err.message) } }
  }
  useEffect(() => {
    alive.current = true
    read()
    return () => { alive.current = false; controller.current?.abort() }
  }, [sessionId,tool,observedAccount])
  async function apply(event) {
    event.preventDefault()
    if (!data || submitting.current || disabled || target === data.account) return
    controller.current?.abort(); submitting.current = true; setBusy(true); onBusyChange(true); setError(''); setNotice('')
    try {
      const result = await accountRequest('switch',{sessionId,tool,slot:target,from:data.account})
      if (result.success && alive.current) {
        setNotice(result.onStart ? t('已绑定，下次启动时使用。','Account assigned for the next start.') : t('已切换账号。','Account switched.'))
        onSwitch()
      }
    } catch (err) { if (alive.current) setError(err.message) }
    finally {
      if (alive.current) { await read(); setBusy(false); onBusyChange(false) }
      submitting.current = false
    }
  }
  const current = data ? data.label || t('默认账号','Default account') : observedAccount || t('待核对','Checking')
  return html`<div class="chat-model-controls" onKeyDown=${e => { e.stopPropagation(); if (e.key === 'Escape') setOpen(false) }}>
    <button type="button" class="chat-model-toggle" aria-expanded=${open} title=${current} onClick=${() => {
      if (!open && !busy) { setError(''); read() } setOpen(!open)
    }}>${t('账号','Account')} · ${current} ⌄</button>
    ${open && html`<form class="chat-model-popover" onSubmit=${apply}>
      <header><strong>${t('会话账号','Session account')}</strong><button type="button" onClick=${() => setOpen(false)}>×</button></header>
      <p>${t('当前账号','Current account')} · ${current}</p>
      <label>${t('切换到','Switch to')}<select value=${target} disabled=${!data || busy || disabled} onChange=${e => setTarget(e.currentTarget.value)}>
        <option disabled value="">${t('选择已保存的账号','Choose a saved account')}</option>
        ${data?.slots.map(slot => html`<option key=${slot} value=${slot}>${slot}</option>`)}
      </select></label>
      <p>${!data?.slots.length ? t('在设置的账号管理中添加账号后即可选择。','Add an account in Settings first.') : disabled ? t('请等待当前操作完成。','Wait for the current operation to finish.') :
        t('切换会将此对话复制到目标账号。运行中的会话会重启并恢复对话。','Switching copies this conversation to the selected account. A running session restarts and resumes.')}</p>
      ${(error || notice) && html`<p role=${error ? 'alert' : 'status'}>${error || notice}</p>`}
      <footer><button type="button" disabled=${busy} onClick=${() => { setError(''); read() }}>${t('刷新','Refresh')}</button>
      <button type="submit" disabled=${busy || disabled || !target || !data || target === data.account}>${busy ? t('切换中…','Switching…') : t('确认切换','Confirm switch')}</button></footer>
    </form>`}</div>`
}
