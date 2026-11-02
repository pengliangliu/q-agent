import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { authHeaders } from './api.js'
import { beginUiMutation } from './uiOperations.js'

const effortLabels = { minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最大', ultra: '极高' }
const allowedModel = (tool, value) => typeof value === 'string' && (tool === 'claude' ? /^claude-/.test(value) : tool === 'codex' && /^gpt-/.test(value))
const matches = (current, target) => current?.modelId === target.modelId && (!target.reasoningEffort || current.reasoningEffort === target.reasoningEffort)
const confirmedFailure = data => data?.requestStatus === 'failed' && data.requestActive === false

async function modelRequest(path, body, signal) {
  const release = body === undefined ? null : beginUiMutation()
  try {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: authHeaders({ 'X-AgentDeck-Desktop': '1' }),
    ...(body ? { body: JSON.stringify(body) } : {}), signal })
  const data = await response.json()
  if (!response.ok || data.error || data.success === false) {
    const error = new Error(data.error?.message || data.error || data.message || '模型设置未完成。')
    error.data = data
    throw error
  }
  return data
  } finally { release?.() }
}

export function SessionModelControls({ sessionId, tool, disabled = false, openRequest, onBusyChange, onApplied }) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState(null)
  const [modelId, setModelId] = useState('')
  const [effort, setEffort] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState(() => {
    try { return JSON.parse(localStorage.getItem('agentdeck.model.' + sessionId) || 'null') } catch (_) { return null }
  })
  const pendingRef = useRef(pending)
  const touched = useRef(false)
  const prefill = useRef(null)
  const alive = useRef(true)
  const posting = useRef(false)
  const refreshing = useRef(false)
  const refreshAgain = useRef(false)
  const refreshRevision = useRef(0)
  const failedRequest = useRef(false)
  const panel = useRef(null)
  const failedPending = pending?.state === 'failed' && pending.requestActive === false

  function savePending(value) {
    pendingRef.current = value
    if (alive.current) setPending(value)
    try {
      if (value) localStorage.setItem('agentdeck.model.' + sessionId, JSON.stringify(value))
      else localStorage.removeItem('agentdeck.model.' + sessionId)
    } catch (_) {}
  }

  function finishFailure(operation, data, message = data?.message) {
    savePending(data?.canClearDraft ? { ...operation, state: 'failed', requestActive: false,
      canClearDraft: true, message } : null)
    if (alive.current) {
      if (!touched.current) { setModelId(operation.modelId); setEffort(operation.reasoningEffort || '') }
      setNotice(''); setError(message || '设置未完成，可以重新选择模型与强度。')
    }
    failedRequest.current = true; touched.current = true
  }

  function acceptState(data) {
    if (data.tool && data.tool !== tool) throw new Error('当前会话的助手类型已变化，请重新打开会话。')
    setState(data)
    if (!touched.current) {
      let nextModel = allowedModel(tool, data.current?.modelId) ? data.current.modelId : ''
      let nextEffort = data.current?.verified === true ? data.current.reasoningEffort || '' : ''
      const requested = prefill.current
      if (requested?.modelId) {
        const model = data.models?.find(item => allowedModel(tool, item.value) && item.value === requested.modelId)
        if (model) {
          nextModel = model.value
          if (!(model.reasoningEfforts || []).includes(nextEffort)) nextEffort = ''
        } else setNotice('该模型不在当前可用列表中，请从列表选择。')
      }
      if (requested?.reasoningEffort) {
        const efforts = data.models?.find(item => item.value === nextModel)?.reasoningEfforts || []
        if (efforts.includes(requested.reasoningEffort)) nextEffort = requested.reasoningEffort
        else setNotice('该强度不适用于当前模型，请从列表选择。')
      }
      setModelId(nextModel); setEffort(nextEffort)
      if (requested) { touched.current = true; prefill.current = null }
    }
  }

  async function refresh(signal, quiet = false) {
    if (!['claude', 'codex'].includes(tool)) return
    if (refreshing.current) { if (!quiet) refreshAgain.current = true; return }
    refreshing.current = true
    const revision = refreshRevision.current
    const operation = pendingRef.current
    if (!quiet) { setLoading(true); if (!failedRequest.current) setError('') }
    try {
      const data = await modelRequest('/desktop/chat/models?' + new URLSearchParams({ sessionId,
        ...(operation ? { requestId: operation.requestId } : {}) }), undefined, signal)
      if (!alive.current || revision !== refreshRevision.current) return
      acceptState(data)
      if (operation && data.requestStatus === 'succeeded' && data.current?.verified === true && matches(data.current, operation)) {
        savePending(null); touched.current = false; setModelId(data.current.modelId); setEffort(data.current.reasoningEffort || '')
        setNotice('已切换当前会话的模型与强度。'); onApplied?.()
      } else if (operation && data.draftCleared === true) {
        savePending(null); touched.current = false
        setNotice(data.message || '未提交的模型命令已清除，可以重新应用设置。')
      } else if (operation && confirmedFailure(data)) {
        finishFailure(operation, data)
      } else if (operation) {
        savePending({ ...operation, state: data.requestStatus === 'pending' || data.requestActive === true ? 'pending' : 'unknown',
          requestActive: typeof data.requestActive === 'boolean' ? data.requestActive : null, canClearDraft: data.canClearDraft === true,
          message: data.message || (data.requestStatus === 'pending' ? '' : '切换结果尚未确认，请刷新核对当前状态。') })
      }
    } catch (err) {
      if (err.name !== 'AbortError' && alive.current && revision === refreshRevision.current) {
        if (operation && pendingRef.current?.requestId === operation.requestId) {
          const requestActive = err.data?.requestId === operation.requestId ? err.data.requestActive : null
          if (err.data?.requestId === operation.requestId && confirmedFailure(err.data)) finishFailure(operation, err.data, err.message)
          else savePending({ ...operation, state: requestActive === true ? 'pending' : 'unknown',
            requestActive: typeof requestActive === 'boolean' ? requestActive : null, canClearDraft: false,
            message: err.message || '暂时无法读取原切换结果，请刷新核对。' })
        }
        else if (!quiet) setError(err.message || '暂时无法读取当前模型。')
      }
    }
    finally {
      refreshing.current = false
      if (alive.current && !quiet) setLoading(false)
      if (alive.current && refreshAgain.current) { refreshAgain.current = false; refresh() }
    }
  }

  useEffect(() => {
    alive.current = true
    const controller = new AbortController()
    refresh(controller.signal)
    const syncVisible = () => {
      if (document.visibilityState === 'visible' && !posting.current) refresh(undefined, true)
    }
    const flush = event => {
      try {
        if (pendingRef.current) localStorage.setItem('agentdeck.model.' + sessionId, JSON.stringify(pendingRef.current))
        else localStorage.removeItem('agentdeck.model.' + sessionId)
      } catch (_) { event.preventDefault() }
    }
    const timer = setInterval(() => {
      const operation = pendingRef.current
      if (!operation || operation.state === 'failed' && operation.requestActive === false) syncVisible()
    }, 15000)
    window.addEventListener('focus', syncVisible)
    window.addEventListener('agentdeck:before-ui-reload', flush)
    document.addEventListener('visibilitychange', syncVisible)
    return () => {
      alive.current = false; controller.abort(); clearInterval(timer)
      window.removeEventListener('focus', syncVisible); document.removeEventListener('visibilitychange', syncVisible)
      window.removeEventListener('agentdeck:before-ui-reload', flush)
      onBusyChange?.(false)
    }
  }, [sessionId, tool])

  useEffect(() => {
    if (!openRequest) return
    prefill.current = openRequest.modelId || openRequest.reasoningEffort ? openRequest : null
    touched.current = false; if (!openRequest.refreshOnly) setOpen(true); setNotice(''); refresh()
  }, [openRequest])

  useEffect(() => {
    if (!open || loading) return
    panel.current?.querySelector(openRequest?.focus === 'effort' ? '[name="reasoningEffort"]' : '[name="modelId"]')?.focus()
  }, [open, loading, openRequest])

  useEffect(() => {
    if (!pending || pending.state !== 'pending' || pending.requestActive === false || posting.current || loading) return
    const timer = setTimeout(() => { if (!document.hidden) refresh(undefined, true) }, 700)
    return () => clearTimeout(timer)
  }, [pending, loading])

  if (!['claude', 'codex'].includes(tool)) return null
  const models = (state?.models || []).filter(model => allowedModel(tool, model.value))
  const selected = models.find(model => model.value === modelId)
  const efforts = selected?.reasoningEfforts || []
  const validEffort = !efforts.length || efforts.includes(effort)
  const current = state?.current?.verified === true ? state.current : null
  const currentModelId = allowedModel(tool, state?.current?.modelId) ? state.current.modelId : ''
  const evidence = state?.effortEvidence?.modelId === currentModelId && effortLabels[state.effortEvidence.reasoningEffort] ? state.effortEvidence : null
  const effortText = value => (effortLabels[value] ? effortLabels[value] + ' · ' : '') + value
  const strength = current?.reasoningEffort ? '强度：' + effortText(current.reasoningEffort) : current ? '无强度档位' :
    evidence?.scope === 'current-turn' ? '本轮：' + effortText(evidence.reasoningEffort) :
    evidence ? '最近请求：' + effortText(evidence.reasoningEffort) : '强度未确认'
  const canApply = !disabled && !loading && (!pending || failedPending) && !pending?.canClearDraft && state?.canChange === true && selected && validEffort &&
    (current?.modelId !== modelId || current?.reasoningEffort !== effort)

  function stopWaiting() {
    if (!pendingRef.current || posting.current || pendingRef.current.requestActive === true || pendingRef.current.canClearDraft) return
    refreshRevision.current++
    savePending(null); touched.current = false; setError('')
    setNotice('已停止等待。')
    refresh()
  }

  async function clearDraft() {
    const operation = pendingRef.current
    if (!operation?.canClearDraft || operation.requestActive === true || posting.current || disabled) return
    refreshRevision.current++
    posting.current = true; onBusyChange?.(true); setError(''); setNotice('')
    savePending({ ...operation, state: 'pending', requestActive: true, canClearDraft: false, message: '正在清除未提交的模型命令…' })
    try {
      const data = await modelRequest('/desktop/chat/model/clear-draft', { sessionId, requestId: operation.requestId })
      if (!alive.current || pendingRef.current?.requestId !== operation.requestId) return
      if (data.draftCleared === true) {
        savePending(null); touched.current = false
        setNotice(data.message || '未提交的模型命令已清除，可以重新应用设置。')
      } else savePending({ ...operation, state: data.requestStatus === 'pending' || data.requestActive === true ? 'pending' : 'unknown', requestActive: data.requestActive === true,
        canClearDraft: data.canClearDraft === true, message: data.message || '清理结果待确认，请刷新核对原请求。' })
    } catch (err) {
      if (alive.current && pendingRef.current?.requestId === operation.requestId) savePending({ ...operation,
        state: 'unknown', requestActive: null, canClearDraft: false, message: err.message || '清理结果待确认，请刷新核对原请求。' })
    } finally {
      posting.current = false; onBusyChange?.(false)
      if (alive.current) refresh()
    }
  }

  async function apply(event) {
    event.preventDefault()
    if (!canApply || posting.current) return
    const operation = { requestId: crypto.randomUUID(), modelId, reasoningEffort: effort, state: 'pending', requestActive: true }
    refreshRevision.current++
    savePending(operation); posting.current = true; onBusyChange?.(true); failedRequest.current = false; setError(''); setNotice('')
    try {
      const data = await modelRequest('/desktop/chat/model', { sessionId, modelId, reasoningEffort: effort,
        requestId: operation.requestId, revision: state.revision })
      if (!alive.current) return
      if (data.verified === true && data.current?.verified !== false && matches(data.current, operation)) {
        refreshRevision.current++
        setState(previous => ({ ...previous, ...data, current: { ...data.current, verified: true } }))
        savePending(null); touched.current = false; setNotice('已切换当前会话的模型与强度。'); onApplied?.()
      } else if (confirmedFailure(data)) {
        acceptState(data); finishFailure(operation, data)
      } else {
        savePending({ ...operation, state: data.requestStatus === 'pending' || data.requestActive === true ? 'pending' : 'unknown',
          requestActive: typeof data.requestActive === 'boolean' ? data.requestActive : null, message: data.message || '' })
      }
    } catch (err) {
      if ((confirmedFailure(err.data) && err.data.requestId === operation.requestId) ||
          (err.data?.keySent === false && !err.data?.unknown && (!err.data.requestId || err.data.requestId === operation.requestId))) finishFailure(operation, err.data, err.message)
      else savePending({ ...operation, state: 'unknown', requestActive: null, message: err.message || '设置结果待确认。' })
      if (alive.current) setError(err.message || '设置结果待确认。')
    } finally {
      posting.current = false; onBusyChange?.(false)
      if (alive.current) refresh()
    }
  }

  return html`<div class="chat-model-controls" onKeyDown=${event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); setOpen(false) } }} onKeyUp=${event => event.stopPropagation()}>
    <button type="button" class="chat-model-toggle" aria-label="选择模型与强度" aria-expanded=${open} title=${(currentModelId || '当前模型未确认') + ' · ' + strength + '；点击设置'}
      onClick=${() => { if (!open) { if (!failedRequest.current) touched.current = false; setNotice(''); refresh() }; setOpen(value => !value) }}>
      <span style=${{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '1px' }}>
        <span translate="no">${currentModelId || (tool === 'claude' ? 'Claude' : 'Codex') + ' · 模型未确认'}</span><small>${strength}</small>
      </span><span aria-hidden="true">⌄</span>
    </button>
    ${open && html`<form class="chat-model-popover" ref=${panel} onSubmit=${apply} aria-label="当前会话模型设置">
      <header><strong>当前会话模型</strong><button type="button" aria-label="关闭模型设置" onClick=${() => setOpen(false)}>×</button></header>
      <p class="chat-model-current">${currentModelId || '当前模型尚未确认'} · ${strength}</p>
      <label><span>模型</span><select name="modelId" value=${modelId} disabled=${loading || Boolean(pending && !failedPending) || disabled}
        onChange=${event => { const value = event.currentTarget.value; touched.current = true; setModelId(value)
          if (!(models.find(model => model.value === value)?.reasoningEfforts || []).includes(effort)) setEffort('') }}>
        <option value="" disabled>请选择模型</option>${models.map(model => html`<option key=${model.value} value=${model.value}>${model.label || model.value}</option>`)}
      </select></label>
      ${efforts.length > 0 && html`<label><span>推理强度</span><select name="reasoningEffort" value=${validEffort ? effort : ''} disabled=${loading || Boolean(pending && !failedPending) || disabled}
        onChange=${event => { touched.current = true; setEffort(event.currentTarget.value) }}><option value="" disabled>请选择强度</option>
        ${efforts.map(value => html`<option key=${value} value=${value}>${effortText(value)}</option>`)}</select></label>`}
      ${loading && html`<p role="status">正在核对当前模型…</p>`}
      ${(disabled || state?.canChange === false) && html`<p>${state?.reason || '当前会话处理完成后可切换模型。'}</p>`}
      ${pending && !failedPending && html`<p role="status">${pending.message || (pending.state === 'pending' ? '正在应用设置，等待原生会话确认…' : '切换结果尚未确认，请刷新核对当前状态。')}</p>`}
      ${(error || notice) && html`<p role=${error ? 'alert' : 'status'}>${error || notice}</p>`}
      <footer><button type="button" disabled=${loading} onClick=${() => refresh()}>刷新状态</button>
        ${pending?.canClearDraft && html`<button type="button" disabled=${disabled || loading || posting.current || pending.requestActive === true} onClick=${clearDraft}>清除未提交命令</button>`}
        ${pending && !failedPending && !pending.canClearDraft && pending.state !== 'pending' && pending.requestActive !== true && html`<button type="button" disabled=${posting.current} onClick=${stopWaiting}>停止等待</button>`}
        <button type="submit" class="chat-model-apply" disabled=${!canApply}>应用到当前会话</button></footer>
    </form>`}
  </div>`
}
