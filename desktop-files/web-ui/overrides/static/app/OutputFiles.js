import { html } from 'htm/preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { authHeaders } from './api.js'
import { languageSignal } from './desktopPreferences.js'
import { beginUiMutation } from './uiOperations.js'
import { outputFileReferences } from './outputFileReferences.js'

const stylesheet = new URL('./outputFiles.css', import.meta.url).href
if (![...document.querySelectorAll('link[rel="stylesheet"]')].some(link => link.href === stylesheet)) {
  const link = document.createElement('link')
  link.rel = 'stylesheet'; link.href = stylesheet
  document.head.append(link)
}

function ReferenceCard({ reference, sessionId, message, en }) {
  const [resolved, setResolved] = useState(null)
  const [choices, setChoices] = useState(null)
  const [status, setStatus] = useState('')
  const [failure, setFailure] = useState(null)
  const [busy, setBusy] = useState(false)
  const working = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const act = async (action, target = resolved?.path || reference.reference) => {
    if (working.current) return
    working.current = true
    setBusy(true); setFailure(null); setStatus(''); setChoices(null)
    const release = beginUiMutation()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 45000)
    try {
      const response = await fetch('/desktop/output-files/' + (action === 'copy' ? 'resolve' : action), {
        method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json', 'X-AgentDeck-Desktop': '1' }),
        body: JSON.stringify({ sessionId, path: target, messageCwd: message.cwd, directoryHints: message.directoryHints || [] }),
        signal: controller.signal,
      })
      const result = await response.json()
      if (!alive.current) return
      if (result.item) setResolved(result.item)
      if (!response.ok || result.error) {
        const error = new Error(result.error || '文件操作失败，请核对路径。')
        error.code = result.code || 'operation_failed'
        throw error
      }
      if (result.status === 'ambiguous') { setChoices({ action, items: result.candidates }); return }
      if (action === 'copy') {
        try { await navigator.clipboard.writeText(result.item.path) }
        catch (_) { const error = new Error('复制失败，请选中上方完整路径手动复制。'); error.code = 'copy_failed'; throw error }
      }
      if (alive.current) setStatus(action === 'copy' ? 'copied' : action === 'reveal' ? 'revealed' : 'opened')
    } catch (error) {
      if (alive.current) setFailure({ code: error.name === 'AbortError' ? 'unknown' : error.code || 'operation_failed', message: error.code ? error.message : '' })
    } finally {
      clearTimeout(timer); release(); working.current = false
      if (alive.current) setBusy(false)
    }
  }
  const location = resolved?.path || reference.reference
  const canOpen = resolved ? resolved.canOpen : reference.canOpen
  const directory = resolved ? resolved.type === 'directory' : reference.directoryHint
  const failureText = failure && (en ? failure.code === 'not_found' ? 'This file was not found in the message locations.'
    : failure.code === 'unsupported_type' ? 'Use Show location for this file type.'
    : failure.code === 'copy_failed' ? 'Copy failed. Select and copy the full path shown above.'
    : failure.code === 'unknown' ? 'Operation result is unknown. Check the application window before trying again.'
    : 'File operation failed. Check the path and application window.'
    : failure.code === 'unknown' ? '操作结果尚未确认，请先检查应用窗口再决定是否重试。' : failure.message || '文件操作失败，请核对路径和应用窗口。')
  return html`<div class="output-file-card">
    <div class="output-file-main"><span class="output-file-kind" aria-label=${directory ? en ? 'Directory' : '目录' : en ? 'File' : '文件'}>${directory ? '▱' : '▤'}</span>
      <div class="output-file-info"><strong title=${resolved?.name || reference.name}>${resolved?.name || reference.name}</strong>
        <div class="output-file-path" title=${location}>${location}</div></div></div>
    <div class="output-file-actions">
      ${canOpen && html`<button type="button" disabled=${busy} onClick=${() => act('open')}>${en ? 'Open' : '打开'}</button>`}
      <button type="button" disabled=${busy} onClick=${() => act('reveal')}>${en ? 'Show location' : '显示位置'}</button>
      <button type="button" disabled=${busy} onClick=${() => act('copy')}>${en ? 'Copy path' : '复制路径'}</button>
    </div>
    ${(busy || status || failure) && html`<div class=${'output-file-status' + (failure ? ' error' : '')} role="status">${failureText || (busy ? en ? 'Resolving…' : '正在处理…'
      : status === 'copied' ? en ? 'Full path copied' : '已复制完整路径'
      : status === 'revealed' ? en ? 'Location shown' : '已显示位置' : en ? 'Opened' : '已打开')}</div>`}
    ${choices && html`<div class="output-file-choices"><span>${en ? 'Multiple locations found. Choose one:' : '找到多个位置，请选择：'}</span>
      ${choices.items.map(item => html`<button type="button" key=${item.path} disabled=${busy} onClick=${() => act(choices.action, item.path)}>${item.path}</button>`)}</div>`}
  </div>`
}

export function OutputFiles({ sessionId, message }) {
  const references = useMemo(() => outputFileReferences(message.text), [message.text])
  const [expanded, setExpanded] = useState(false)
  const en = languageSignal.value === 'en'
  if (!sessionId || !references.length) return null
  return html`<section class="output-files" translate="no" aria-label=${en ? 'Referenced files' : '文件引用'}>
    <div class="output-files-heading">${en ? 'Referenced files' : '文件引用'} <span>${references.length}</span></div>
    ${(expanded ? references : references.slice(0, 4)).map(reference => html`<${ReferenceCard} key=${sessionId + ':' + reference.reference}
      reference=${reference} sessionId=${sessionId} message=${message} en=${en} />`)}
    ${references.length > 4 && html`<button type="button" class="output-files-expand" aria-expanded=${expanded} onClick=${() => setExpanded(!expanded)}>
      ${expanded ? en ? 'Show fewer' : '收起' : en ? 'Show ' + (references.length - 4) + ' more' : '展开其余 ' + (references.length - 4) + ' 项'}</button>`}
  </section>`
}
