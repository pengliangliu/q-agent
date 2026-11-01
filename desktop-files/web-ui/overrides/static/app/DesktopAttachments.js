import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { menuModelSignal } from './dataModel.js'
import { readOnlySignal, selectedIdSignal } from './state.js'

const MAX_FILE_SIZE = 100 * 1024 * 1024
const DESKTOP_HEADERS = { 'X-AgentDeck-Desktop': '1' }

function sizeLabel(size) {
  if (size < 1024) return size + ' B'
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'
  return (size / (1024 * 1024)).toFixed(1) + ' MB'
}

function responseError(data, fallback) {
  return data?.error?.message || (typeof data?.error === 'string' ? data.error : '') || data?.message || fallback
}

async function desktopRequest(path, body, signal) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { ...DESKTOP_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const data = await response.json()
  if (!response.ok || data.success === false || data.error) {
    throw new Error(responseError(data, '操作未完成，请重试。'))
  }
  return data
}

export function DesktopAttachments({ sessionId, frameRef, focusTerminal }) {
  const [files, setFiles] = useState([])
  const [dragging, setDragging] = useState(false)
  const [inserting, setInserting] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [locating, setLocating] = useState(false)
  const [locationPath, setLocationPath] = useState('')
  const [opening, setOpening] = useState(false)
  const inputRef = useRef(null)
  const requests = useRef(new Map())
  const previews = useRef(new Map())
  const alive = useRef(true)
  const dragDepth = useRef(0)
  const session = menuModelSignal.value.sessions.find(item => item.id === sessionId)
  const readOnly = readOnlySignal.value
  const isIdle = session && ['waiting', 'idle'].includes(session.status)
  const ready = files.filter(file => file.status === 'ready')
  const uploading = files.some(file => file.status === 'uploading')

  useEffect(() => () => {
    alive.current = false
    for (const controller of requests.current.values()) controller.abort()
    for (const url of previews.current.values()) URL.revokeObjectURL(url)
    requests.current.clear()
    previews.current.clear()
  }, [])

  function updateFile(id, patch) {
    if (alive.current) setFiles(current => current.map(file => file.id === id ? { ...file, ...patch } : file))
  }

  async function upload(file) {
    const id = crypto.randomUUID()
    if (file.size > MAX_FILE_SIZE) {
      setFiles(current => [...current, { id, name: file.name, size: file.size, status: 'error', error: '文件超过 100 MB' }])
      return
    }
    const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : null
    if (preview) previews.current.set(id, preview)
    const controller = new AbortController()
    requests.current.set(id, controller)
    setFiles(current => [...current, { id, name: file.name, size: file.size, preview, status: 'uploading' }])
    try {
      const query = new URLSearchParams({ sessionId, name: file.name })
      const response = await fetch('/desktop/upload?' + query, {
        method: 'POST', headers: DESKTOP_HEADERS, body: file, signal: controller.signal,
      })
      const data = await response.json()
      if (!response.ok || data.error || !data.path) {
        throw new Error(responseError(data, '上传失败，请移除后重试。'))
      }
      updateFile(id, { status: 'ready', path: data.path, name: data.name || file.name })
    } catch (err) {
      if (err.name !== 'AbortError') updateFile(id, { status: 'error', error: err.message || '上传失败' })
    } finally {
      requests.current.delete(id)
    }
  }

  function addFiles(values) {
    if (readOnlySignal.value) { setError('当前为只读模式。'); return }
    setError('')
    setMessage('')
    for (const file of Array.from(values)) upload(file)
  }

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const controller = new AbortController()
    const options = { signal: controller.signal }
    const hasFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files')
    frame.addEventListener('dragenter', event => {
      if (!hasFiles(event)) return
      event.preventDefault()
      dragDepth.current++
      setDragging(true)
    }, options)
    frame.addEventListener('dragover', event => {
      if (!hasFiles(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = readOnlySignal.value ? 'none' : 'copy'
    }, options)
    frame.addEventListener('dragleave', event => {
      if (!hasFiles(event)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (!dragDepth.current) setDragging(false)
    }, options)
    frame.addEventListener('drop', event => {
      if (!hasFiles(event)) return
      event.preventDefault()
      event.stopPropagation()
      dragDepth.current = 0
      setDragging(false)
      const entries = Array.from(event.dataTransfer.items || [])
      if (entries.some(item => item.webkitGetAsEntry?.()?.isDirectory)) {
        setError('请拖入文件；文件夹可打开后选择其中的文件。')
        return
      }
      addFiles(event.dataTransfer.files)
    }, options)
    frame.addEventListener('paste', event => {
      const pasted = Array.from(event.clipboardData?.files || [])
      if (!pasted.length) return
      event.preventDefault()
      event.stopPropagation()
      addFiles(pasted)
    }, { ...options, capture: true })
    return () => controller.abort()
  }, [sessionId])

  function removeFile(id) {
    requests.current.get(id)?.abort()
    requests.current.delete(id)
    const preview = previews.current.get(id)
    if (preview) URL.revokeObjectURL(preview)
    previews.current.delete(id)
    setFiles(current => current.filter(file => file.id !== id))
  }

  async function insertFiles() {
    if (inserting || !ready.length || uploading || !isIdle || readOnly) return
    setInserting(true)
    setError('')
    setMessage('')
    try {
      const response = await desktopRequest('/desktop/draft', { sessionId, paths: ready.map(file => file.path) })
      if (response.success !== true) throw new Error('未确认已加入输入框，请检查当前会话。')
      if (!alive.current) return
      for (const file of ready) removeFile(file.id)
      setMessage('已加入输入框。补充说明后，按 Enter 发送。')
      if (selectedIdSignal.value === sessionId) focusTerminal()
    } catch (err) {
      if (alive.current) setError(err.message || '未能加入输入框，请确认会话已空闲。')
    } finally {
      if (alive.current) setInserting(false)
    }
  }

  async function reveal(path) {
    if (opening) return
    setOpening(true)
    setError('')
    try {
      await desktopRequest('/desktop/reveal', { sessionId, ...(path ? { path } : {}) })
      if (alive.current) { setLocating(false); setMessage('已在文件管理器中打开。') }
    } catch (err) {
      if (alive.current) setError(err.message || '无法打开文件位置。')
    } finally {
      if (alive.current) setOpening(false)
    }
  }

  return html`
    <section class="desktop-attachments" aria-label="附件与文件位置" onKeyDown=${event => {
      event.stopPropagation()
      if (event.key === 'Escape') setLocating(false)
    }}>
      ${dragging && html`<div class="desktop-drop-overlay" aria-hidden="true"><strong>松开即可添加文件</strong><span>支持图片与文档，可一次拖入多个文件</span></div>`}
      <div class="desktop-file-toolbar">
        <button type="button" class="btn" disabled=${readOnly} onClick=${() => inputRef.current?.click()}>添加文件</button>
        <span class="desktop-drop-hint">拖入图片或文件，也可以粘贴截图</span>
        <span class="desktop-toolbar-spacer" />
        <button type="button" class="btn ghost" disabled=${opening} onClick=${() => reveal()}>打开项目文件夹</button>
        <button type="button" class="btn ghost" onClick=${() => { setLocating(value => !value); setError('') }}>定位文件</button>
        <input ref=${inputRef} class="desktop-file-input" type="file" multiple aria-label="选择附件"
          onChange=${event => { addFiles(event.currentTarget.files); event.currentTarget.value = '' }} />
      </div>
      ${locating && html`
        <form class="desktop-location-form" onSubmit=${event => { event.preventDefault(); if (locationPath.trim()) reveal(locationPath.trim()) }}>
          <label for=${'desktop-location-' + sessionId}>文件或文件夹路径</label>
          <input id=${'desktop-location-' + sessionId} value=${locationPath} autoFocus
            placeholder="粘贴 Windows 或 WSL 路径" onInput=${event => setLocationPath(event.currentTarget.value)} />
          <button class="btn primary" type="submit" disabled=${opening || !locationPath.trim()}>${opening ? '正在打开…' : '打开位置'}</button>
          <button class="btn ghost" type="button" onClick=${() => setLocating(false)}>取消</button>
        </form>`}
      ${files.length > 0 && html`
        <div class="desktop-file-list" aria-label="待加入附件">
          ${files.map(file => html`
            <div key=${file.id} class=${'desktop-file-card ' + file.status}>
              ${file.preview ? html`<img class="desktop-file-preview" src=${file.preview} alt="" />` : html`<span class="desktop-file-symbol" aria-hidden="true">▤</span>`}
              <div class="desktop-file-info">
                <strong title=${file.name}>${file.name}</strong>
                <span>${sizeLabel(file.size)} · ${file.status === 'uploading' ? '正在上传…' : file.status === 'ready' ? '待加入' : file.error}</span>
              </div>
              <button type="button" class="desktop-file-remove" disabled=${inserting} aria-label=${'移除 ' + file.name} title="移除附件" onClick=${() => removeFile(file.id)}>×</button>
            </div>`)}
        </div>
        <div class="desktop-file-actions">
          <span>${uploading ? '文件上传完成后即可加入输入框。' : !isIdle ? (session?.status === 'running' ? '会话运行中，空闲后可加入输入框。' : '请启动会话并返回输入框后加入附件。') : '确认附件后加入输入框，再按 Enter 发送。'}</span>
          <button type="button" class="btn primary" disabled=${inserting || uploading || !ready.length || !isIdle || readOnly} onClick=${insertFiles}>
            ${inserting ? '正在加入…' : '加入输入框' + (ready.length ? '（' + ready.length + '）' : '')}
          </button>
        </div>`}
      ${error && html`<p class="desktop-file-feedback error" role="alert">${error}</p>`}
      ${message && html`<p class="desktop-file-feedback" role="status">${message}</p>`}
    </section>
  `
}
