import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { authHeaders } from './api.js'
import { readOnlySignal } from './state.js'

const ended = state => ['done','failed','cancelled','expired'].includes(state)
async function request(action, body) {
  const res = await fetch('/desktop/accounts/manual/' + action, {method:'POST', cache:'no-store',
    headers:authHeaders({'X-AgentDeck-Desktop':'1'}), body:JSON.stringify(body)})
  const data = await res.json()
  if (!res.ok) throw new Error(data.error)
  return data
}
export function ManualLogin({tool,slot,en,onClose,onDone}) {
  const [flow,setFlow] = useState(null), [error,setError] = useState(''), [copied,setCopied] = useState(false)
  const [sending,setSending] = useState(false)
  const code = useRef(null), latch = useRef(false), alive = useRef(true)
  const revision = useRef(0)
  const t = (zh,english) => en ? english : zh
  useEffect(() => {
    alive.current = true
    let timer, id, disposed = false
    const cancel = () => { if (id) request('cancel',{id}).catch(() => {}) }
    const leave = () => cancel()
    window.addEventListener('pagehide', leave)
    async function poll() {
      const before = revision.current
      try {
        const data = await request('status',{id})
        if (disposed) return
        if (before === revision.current) { setFlow(data); setError('') }
        if (ended(data.state)) { if (data.state === 'done') onDone(); return }
      } catch (err) {
        if (disposed) return
        if (err.message === 'login-expired') { setFlow({state:'expired'}); setError(''); return }
        setError('sync')
      }
      if (!disposed) timer = setTimeout(poll, 1200)
    }
    request('start',{tool,slot}).then(data => {
      id = data.id
      if (disposed) { cancel(); return }
      setFlow(data); poll()
    }).catch(err => { if (!disposed) setError(err.message === 'login-busy' ? 'busy' : 'start') })
    return () => { disposed = true; alive.current = false; clearTimeout(timer); window.removeEventListener('pagehide',leave); cancel() }
  }, [tool,slot])

  async function submit(e) {
    e.preventDefault()
    if (readOnlySignal.value || latch.current || !flow?.needsCode) return
    const value = code.current?.value.trim()
    if (!value) return
    latch.current = true; revision.current++; setSending(true); setError(''); code.current.value = ''
    try {
      const data = await request('submit',{id:flow.id,code:value})
      if (alive.current && !ended(data.state)) setFlow(old => ended(old?.state) ? old : data)
    } catch { if (alive.current) setError('submit') }
    finally { latch.current = false; if (alive.current) setSending(false) }
  }
  return html`<section class="desktop-diagnostics" aria-label=${t('手动网页登录','Manual web sign-in')}>
    <h3>${tool === 'claude' ? 'Claude Code' : 'Codex'} · ${slot || t('默认账号','Default account')} · ${t('手动网页登录','Manual web sign-in')}</h3>
    ${!error && !ended(flow?.state) && !flow?.url && html`<p role="status">${flow?.state === 'submitted' ? t('原生程序正在验证授权码…','Verifying the code…') : t('正在等待原生程序生成授权网址…','Waiting for the native sign-in URL…')}</p>`}
    ${flow?.url && html`<div class="desktop-diagnostics-actions">
      <a href=${flow.url} target="_blank" rel="noopener noreferrer">${t('打开授权网页','Open authorization page')}</a>
      <button type="button" onClick=${async () => {
        try { await navigator.clipboard.writeText(flow.url); setCopied(true) }
        catch { setError('copy') }
      }}>${copied ? t('已复制网址','URL copied') : t('复制网址','Copy URL')}</button></div>`}
    ${flow?.deviceCode && html`<p>${t('在授权网页输入设备码','Enter this device code on the authorization page')} <strong translate="no">${flow.deviceCode}</strong></p>`}
    ${tool === 'claude' && flow?.url && html`<p>${t('在浏览器完成登录。如果网页给出一次性授权码，请粘贴到下方。','Sign in in your browser. If it gives you a one-time code, paste it below.')}</p>`}
    ${flow?.needsCode && html`<form class="desktop-diagnostics-actions" onSubmit=${submit}>
      <input type="password" ref=${code} autocomplete="off" spellcheck="false" maxlength="2048"
        placeholder=${t('一次性授权码','One-time authorization code')} aria-label=${t('一次性授权码','One-time authorization code')} required/>
      <button type="submit" disabled=${sending || readOnlySignal.value}>${t('提交给 Claude','Submit to Claude')}</button></form>`}
    ${error && html`<p role="alert">${({start:t('无法启动原生登录，请使用原生终端。','Could not start the login. Use the native terminal.'),busy:t('此账号已有登录流程。请完成或取消后再试。','A login is already in progress for this account.'),
      sync:t('暂时无法读取登录状态，正在重连。','Reconnecting to the login process.'),submit:t('提交结果待核对，请查看原生登录状态。','Check the current sign-in status.'),copy:t('请右键授权链接复制网址。','Right-click the link to copy the URL.')})[error]}</p>`}
    ${ended(flow?.state) && html`<p role="status">${flow.state === 'done' ? t('原生登录已完成。','Native sign-in completed.') :
      flow.state === 'expired' ? t('授权已过期，请重新开始。','Sign-in expired. Start again.') : t('原生登录未完成，可重新登录或使用原生终端查看提示。','Sign-in did not complete. Try again or open the native terminal for details.')}</p>`}
    <div class="desktop-diagnostics-actions"><button type="button" onClick=${onClose}>${ended(flow?.state) || !flow ? t('关闭','Close') : t('取消本次登录','Cancel this login')}</button></div>
  </section>`
}
