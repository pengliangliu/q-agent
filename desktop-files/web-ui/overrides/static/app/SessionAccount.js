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
    if (!response.ok || data.error) {
      const error = new Error(data.error || '账号操作未完成。')
      error.status = response.status; error.data = data
      throw error
    }
    return data
  } finally { release?.() }
}

export function SessionAccount({sessionId, tool, observedAccount, running, disabled, onBusyChange, onSwitch}) {
  const [open,setOpen] = useState(false), [data,setData] = useState(null)
  const [target,setTarget] = useState(''), [busy,setBusy] = useState(false), [error,setError] = useState('')
  const [notice,setNotice] = useState('')
  const [confirmation,setConfirmation] = useState(null)
  const controller = useRef(null), submitting = useRef(false), alive = useRef(true)
  const en = languageSignal.value === 'en'
  const t = (zh, english) => en ? english : zh
  async function read(preserveTarget = false) {
    setConfirmation(null)
    controller.current?.abort()
    const ctrl = new AbortController()
    controller.current = ctrl
    try {
      const info = await accountRequest('current?' + new URLSearchParams({sessionId,tool}), undefined, ctrl.signal)
      if (!ctrl.signal.aborted) {
        setData(info)
        setTarget(previous => preserveTarget && info.slots.includes(previous) ? previous : info.account)
      }
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
    const preparing = running && tool === 'codex' && !confirmation
    let succeeded = false
    try {
      if (preparing) {
        const turn = await accountRequest('switch-turn?' + new URLSearchParams({sessionId,tool}))
        if (alive.current) setConfirmation(turn)
        return
      }
      const result = await accountRequest('switch',{sessionId,tool,slot:target,from:data.account,...(confirmation ? {interruptTurn:confirmation} : {})})
      succeeded = result.success === true
      if (result.success && alive.current) {
        setNotice(result.destinationPending ? t('账号已绑定，原生会话启动结果待核对，请刷新。','Account assigned. Refresh to check the native session startup.') :
          result.continuationUnconfirmed ? t('账号已切换，接续投递尚未确认，请查看对话和原回执。','Account switched. Check the chat for continuation status.') :
          result.continuation ? t('账号已切换，已提交接续消息。','Account switched. Continuation submitted.') :
          result.onStart ? t('已绑定，下次启动时使用。','Account assigned for the next start.') : t('已切换账号。','Account switched.'))
        onSwitch(result)
      }
    } catch (err) { if (alive.current) setError(err.message) }
    finally {
      if (alive.current) { if (!preparing) await read(!succeeded); setBusy(false); onBusyChange(false) }
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
      <label>${t('切换到','Switch to')}<select value=${target} disabled=${!data || busy || disabled} onChange=${e => {setTarget(e.currentTarget.value); setConfirmation(null)}}>
        <option disabled value="">${t('选择已保存的账号','Choose a saved account')}</option>
        ${data?.slots.map(slot => html`<option key=${slot} value=${slot}>${slot}</option>`)}
      </select></label>
      <p>${!data?.slots.length ? t('在设置的账号管理中添加账号后即可选择。','Add an account in Settings first.') : disabled ? t('请等待当前操作完成。','Wait for the current operation to finish.') :
        t('切换会将此对话复制到目标账号。运行中的会话会重启并恢复对话。','Switching copies this conversation to the selected account. A running session restarts and resumes.')}</p>
      ${(error || notice) && html`<p role=${error ? 'alert' : 'status'}>${error || notice}</p>`}
      ${confirmation && html`<p role="alert">${t('将中断当前回答，在目标账号恢复这条对话，并自动发送一次“继续”。目标账号：','Interrupt this answer, resume the chat and send one continuation with account ')}${target}</p>`}
      <footer><button type="button" disabled=${busy} onClick=${() => { setError(''); read() }}>${t('刷新','Refresh')}</button>
      <button type="submit" disabled=${busy || disabled || !target || !data || target === data.account}>${busy ? t('处理中…','Working…') : confirmation ? t('确认中断、切换并继续','Interrupt, switch and continue') : running && tool === 'codex' ? t('切换账号…','Switch account…') : t('确认切换','Confirm switch')}</button></footer>
    </form>`}</div>`
}
