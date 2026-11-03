import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { accountRequest } from './SessionAccount.js'
import { readOnlySignal } from './state.js'

const storage = 'qagent.codex.account-batch'

export function AccountBatch({ target, en, disabled }) {
  const [open,setOpen] = useState(false), [plan,setPlan] = useState(null), [selected,setSelected] = useState([])
  const [job,setJob] = useState(null), [working,setWorking] = useState(false), [error,setError] = useState('')
  const posting = useRef(false), requestId = useRef(null)
  const previewVersion = useRef(0)
  useEffect(() => () => { previewVersion.current++ }, [])
  const t = (zh,english) => en ? english : zh
  const labels = {
    queued:t('等待处理','Queued'),switching:t('正在切换','Switching'),succeeded:t('完成','Done'),
    partial:t('接续待核对','Check continuation'),failed:t('未完成','Failed'),skipped:t('已使用目标账号','Already selected'),
    cancelled:t('未执行','Not run'),unknown:t('结果待核对','Check result'),
  }
  async function preview() {
    const version = ++previewVersion.current
    setWorking(true); setError('')
    try {
      const data = await accountRequest('batch/preview?' + new URLSearchParams({slot:target}))
      if (version !== previewVersion.current) return
      setPlan(data); setSelected(data.items.filter(item => item.eligible).map(item => item.id))
      setJob(null); requestId.current = null
    } catch (err) { if (version === previewVersion.current) setError(err.message) }
    finally { if (version === previewVersion.current) setWorking(false) }
  }
  useEffect(() => {
    if (open && !job) preview()
  }, [target])
  async function show() {
    setOpen(true); setError('')
    let id
    try { id = localStorage.getItem(storage) } catch (_) {}
    if (id) {
      setWorking(true)
      try { const data = await accountRequest('batch/status?' + new URLSearchParams({id})); setJob(data); return }
      catch (err) {
        if (err.status !== 404) { setError(err.message); return }
        try { localStorage.removeItem(storage) } catch (_) {}
      }
      finally { setWorking(false) }
    }
    await preview()
  }
  async function start(event) {
    event.preventDefault()
    if (posting.current || !plan || !selected.length || readOnlySignal.value) return
    posting.current = true; setWorking(true); setError('')
    const id = requestId.current || crypto.randomUUID()
    requestId.current = id
    try {
      localStorage.setItem(storage,id)
      const data = await accountRequest('batch/start',{id,slot:plan.target,revision:plan.revision,sessionIds:selected})
      setJob(data)
    } catch (err) {
      setError(err.message)
      const original = err.data?.id || id
      try {
        const data = await accountRequest('batch/status?' + new URLSearchParams({id:original}))
        setJob(data); localStorage.setItem(storage,original)
      } catch (_) {}
    } finally { posting.current = false; setWorking(false) }
  }
  useEffect(() => {
    if (!open || job?.state !== 'running') return
    const ctrl = new AbortController()
    let timer, reading = false
    async function refresh() {
      if (document.hidden || ctrl.signal.aborted || reading) return
      reading = true
      try { setJob(await accountRequest('batch/status?' + new URLSearchParams({id:job.id}),undefined,ctrl.signal)); setError('') }
      catch (err) { if (!ctrl.signal.aborted) setError(err.message) }
      finally {
        reading = false
        if (!ctrl.signal.aborted) timer = setTimeout(refresh,2000)
      }
    }
    refresh()
    const visible = () => { if (!document.hidden) { clearTimeout(timer); refresh() } }
    document.addEventListener('visibilitychange',visible)
    return () => { ctrl.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange',visible) }
  }, [open,job?.id,job?.state])
  async function stop() {
    if (posting.current || !job) return
    setWorking(true)
    try { await accountRequest('batch/stop',{id:job.id}); setError(t('当前会话处理结束后停止后续切换。','Stopping after the current chat.')) }
    catch (err) { setError(err.message) }
    finally { setWorking(false) }
  }
  const rows = job?.items || plan?.items || []
  const count = selected.length
  const running = plan?.items.filter(item => selected.includes(item.id) && item.status === 'running').length || 0
  return html`<div class="account-batch">
    <button type="button" disabled=${disabled || readOnlySignal.value || !target} onClick=${show}>${t('批量切换 Codex 会话','Switch Codex chats in bulk')}</button>
    ${open && html`<section class="account-batch-panel" aria-label=${t('批量切换 Codex 会话','Switch Codex chats in bulk')}>
      <header><strong>${t('批量切换 Codex 会话','Switch Codex chats in bulk')}</strong><button type="button" aria-label=${t('收起批量切换','Close bulk switching')} onClick=${() => setOpen(false)}>×</button></header>
      <p>${t('目标账号','Target account')} · ${job?.target || plan?.target || target}</p>
      ${job ? html`<p role="status">${job.state === 'running' ? t('正在逐条切换，关闭设置后仍会继续。','Switching one chat at a time. Processing continues after closing Settings.') :
        job.state === 'interrupted' ? t('批量操作已中断，请核对标记为待确认的会话。','Batch interrupted. Check chats marked as unknown.') : t('批量处理已结束。','Batch finished.')}</p>` :
        html`<p>${t('范围为当前配置中的现有 Codex 会话。执行到正在回答的会话时，将中断、切换账号，并自动继续。','This includes existing Codex chats in the current profile. Running answers will be interrupted, switched and continued.')}</p>`}
      ${working && html`<p role="status">${t('正在核对…','Checking…')}</p>`}
      <div class="account-batch-list">
        ${rows.map(item => html`<label key=${item.id} class="account-batch-item">
          ${!job && html`<input type="checkbox" disabled=${!item.eligible || working} checked=${selected.includes(item.id)} onChange=${event => {
            const checked = event.currentTarget.checked
            requestId.current = null; setSelected(old => checked ? [...old,item.id] : old.filter(id => id !== item.id))
          }}/>`}
          <span><strong>${item.title}</strong><small>${item.from || t('默认账号','Default account')} → ${job?.target || plan?.target}</small>
          <small>${job ? labels[item.state] : item.reason || (!item.eligible ? t('已使用目标账号','Already selected') : item.status === 'running' ? t('正在回答，将中断后继续','Running, will interrupt and continue') : t('等待切换','Ready to switch'))}</small>
          ${item.message && html`<small>${item.message}</small>`}</span>
        </label>`)}
      </div>
      ${error && html`<p role="alert">${error}</p>`}
      ${!job && plan && html`<form onSubmit=${start}><p>${t('已选择','Selected')} ${count} ${t('个会话，其中','chats, including')} ${running} ${t('个正在运行。','running.')}</p>
        <div class="desktop-diagnostics-actions"><button type="button" disabled=${working} onClick=${() => { requestId.current = null; preview() }}>${t('刷新列表','Refresh list')}</button>
        <button type="submit" disabled=${working || !count || readOnlySignal.value}>${t('确认批量切换并继续','Confirm switch and continue')}</button></div></form>`}
      ${job && html`<div class="desktop-diagnostics-actions">${job.state === 'running'
        ? html`<button type="button" disabled=${working || readOnlySignal.value} onClick=${stop}>${t('停止后续切换','Stop remaining switches')}</button>`
        : html`<button type="button" disabled=${working || !target || readOnlySignal.value} onClick=${async () => {
          await preview(); try { localStorage.removeItem(storage) } catch (_) {}
        }}>${t('查看新的切换列表','Prepare another batch')}</button>`}</div>`}
    </section>`}
  </div>`
}
