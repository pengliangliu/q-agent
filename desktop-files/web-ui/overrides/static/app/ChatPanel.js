import { html } from 'htm/preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { selectedIdSignal, selectSession, selectGroup, readOnlySignal, wsStateSignal } from './state.js'
import { menuModelSignal } from './dataModel.js'
import { authHeaders } from './api.js'
import { noteSessionStarted } from './terminalReconnect.js'
import { EmptyStateDashboard } from './EmptyStateDashboard.js'
import { InlinePrompt } from './InlinePrompt.js'
import { SessionModelControls } from './SessionModelControls.js'
import { ChatQuota } from './ChatQuota.js'
import { SlashCommandMenu, filterSlashCommands, slashInsertText } from './SlashCommandMenu.js'
import { slashCommandPolicy } from './slashCommandPolicy.js'
import { CommandResult } from './CommandResult.js'
import { OutputFiles } from './OutputFiles.js'
import { beginUiMutation } from './uiOperations.js'

const sessions = new Map()
const MAX_FILE_SIZE = 100 * 1024 * 1024
const HEADER = { 'X-AgentDeck-Desktop': '1' }
const storageKey = id => 'agentdeck.chat.' + id

function getSession(id) {
  if (!sessions.has(id)) {
    let saved = {}
    try {
      const key = storageKey(id)
      const stored = localStorage.getItem(key)
      const legacy = stored === null ? sessionStorage.getItem(key) : null
      saved = JSON.parse(stored || legacy || '{}')
      if (legacy !== null) localStorage.setItem(key, legacy)
      sessionStorage.removeItem(key)
    } catch (_) {}
    if (saved.pendingCommand?.response?.state === 'posting') saved.pendingCommand.response = {
      ...saved.pendingCommand.response, state: 'unknown', message: '上次选择结果待确认，请查询原命令状态。',
    }
    if (saved.pending?.deliverNowState === 'posting') saved.pending.deliverNowState = 'unknown'
    sessions.set(id, { draft: '', files: [], pending: null, pendingCommand: null, promptResponse: null, recoveryRecords: [], messages: [], history: {}, loaded: false,
      ...saved, sending: false, responding: false,
      ...(saved.promptResponse?.state === 'posting' ? { promptResponse: { ...saved.promptResponse, state: 'unknown', message: '上次提交结果待确认，请刷新查询当前状态。' } } : {}) })
  }
  return sessions.get(id)
}

function persist(id, store) {
  const files = store.files.filter(file => file.path).map(({ preview, ...file }) => file)
  try {
    localStorage.setItem(storageKey(id), JSON.stringify({ draft: store.draft, files, pending: store.pending, pendingCommand: store.pendingCommand, promptResponse: store.promptResponse, recoveryRecords: store.recoveryRecords }))
    sessionStorage.removeItem(storageKey(id))
    return true
  } catch (_) { return false }
}

window.addEventListener('agentdeck:before-ui-reload', event => {
  for (const [id, store] of sessions) {
    if (!persist(id, store) || store.files.some(file => !file.path)) event.preventDefault()
  }
})

async function request(path, body, signal, allowReceipt = false) {
  const release = body === undefined ? null : beginUiMutation()
  try {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: authHeaders(HEADER), body: body === undefined ? undefined : JSON.stringify(body), signal,
  })
  let data
  try { data = await response.json() } catch (_) { throw new Error('服务返回了无法读取的响应，请检查连接后重试。') }
  if (!response.ok || data.error || (data.success === false && !allowReceipt)) {
    const error = new Error(data?.error?.message || (typeof data.error === 'string' ? data.error : '') || data.reason || data.message || '操作未完成。')
    error.status = response.status
    error.data = data
    throw error
  }
  return data
  } finally { release?.() }
}

function sizeLabel(size) {
  if (!Number.isFinite(size)) return ''
  return size < 1024 * 1024 ? Math.max(1, Math.round(size / 1024)) + ' KB' : (size / 1024 / 1024).toFixed(1) + ' MB'
}

function localPath(value) {
  if (/^file:\/\//i.test(value)) {
    try { return decodeURIComponent(new URL(value).pathname).replace(/^\/([A-Za-z]:)/, '$1') } catch (_) { return null }
  }
  if (/^\/api\/files\?/.test(value)) {
    try { return new URL(value, location.origin).searchParams.get('path') } catch (_) { return null }
  }
  return /^(?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\)/.test(value) ? value : null
}

function safeLink(value, projectPath) {
  let path = localPath(value)
  if (!path && projectPath && !/^[A-Za-z][\w+.-]*:/.test(value) && !/[\n<>]/.test(value) &&
    (/^(?:\.{1,2}[\\/]|[^\s]+[\\/])/.test(value) || /\.(?:py|js|mjs|ts|tsx|jsx|json|md|yaml|yml|txt|pdf|docx?|xlsx?|pptx?|csv|tsv|html|css|scss|go|rs|java|c|h|cpp|hpp|m|sh|bat|ps1|png|jpe?g|webp|svg|zip|gz|toml|ini|log|sql|ipynb)(?::\d+(?::\d+)?)?$/i.test(value))) {
    // Preserve the reference; the local bridge resolves it using this message's context.
    path = value
  }
  if (path) path = path.replace(/:\d+(?::\d+)?$/, '')
  if (path) return { href: '/api/files?path=' + encodeURIComponent(path), path,
    previewHref: '/api/files?path=' + encodeURIComponent(localPath(path) ? path : projectPath.replace(/[\\/]$/, '') + '/' + path) }
  if (/^https?:\/\//i.test(value)) return { href: value }
  return null
}

function inline(text, reveal, projectPath) {
  const output = []
  // Build Preact nodes only: raw HTML, scripts and non-http URL schemes remain text.
  const pattern = /(`+)([\s\S]*?)\1|(!?)\[([^\]]+)\]\((<[^>]+>|[^\s)]+)\s*(?:"[^"]*")?\)|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*\n]+)\*/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) output.push(text.slice(last, match.index))
    if (match[1]) {
      const file = safeLink(match[2], projectPath)
      output.push(file?.path ? html`<a href=${file.href} onClick=${event => { event.preventDefault(); reveal(file.path) }}><code>${match[2]}</code></a>` : html`<code>${match[2]}</code>`)
    }
    else if (match[4]) {
      const link = safeLink(match[5].replace(/^<|>$/g, ''), projectPath)
      if (!link) output.push(match[0])
      else if (match[3] && link.path) output.push(html`<${MarkdownImage} link=${link} label=${match[4]} reveal=${reveal} />`)
      else output.push(html`<a href=${link.href} target=${link.path ? undefined : '_blank'} rel="noopener noreferrer"
        onClick=${link.path ? event => { event.preventDefault(); reveal(link.path) } : undefined}>${match[4]}</a>`)
    } else if (match[6] || match[7]) output.push(html`<strong>${match[6] || match[7]}</strong>`)
    else if (match[8]) output.push(html`<del>${match[8]}</del>`)
    else output.push(html`<em>${match[9]}</em>`)
    last = match.index + match[0].length
  }
  if (last < text.length) output.push(text.slice(last))
  return output
}

function MarkdownImage({ link, label, reveal }) {
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  return html`<a class="chat-image-link" href=${link.href} onClick=${event => { event.preventDefault(); reveal(link.path) }}>
    ${!loaded && label}${!failed && html`<img style=${{ display: loaded ? 'block' : 'none' }} src=${link.previewHref || link.href} alt=${label}
      onLoad=${() => setLoaded(true)} onError=${() => { setFailed(true); setLoaded(false) }} />`}</a>`
}

function CodeBlock({ text, language }) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  return html`<div class="chat-code"><div class="chat-code-head"><span>${language || '代码'}</span>
    <button type="button" onClick=${async () => {
      try { await navigator.clipboard.writeText(text); setCopied(true); setCopyError(false) }
      catch (_) { setCopyError(true) }
    }}>${copyError ? '复制失败，请选择代码复制' : copied ? '已复制' : '复制代码'}</button></div><pre><code>${text}</code></pre></div>`
}

function markdown(source, reveal, projectPath) {
  const lines = String(source || '').replace(/\r\n/g, '\n').split('\n')
  const result = []
  const isStart = line => /^(?:\s*```|\s*~~~|#{1,6}\s|>\s?|\s*[-*+]\s|\s*\d+\.\s|\s*$)/.test(line)
  const cells = line => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'))
  for (let index = 0; index < lines.length;) {
    const line = lines[index]
    if (!line.trim()) { index++; continue }
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/)
    if (fence) {
      const code = []
      index++
      while (index < lines.length && !new RegExp('^\\s*' + fence[1][0] + '{' + fence[1].length + ',}\\s*$').test(lines[index])) code.push(lines[index++])
      if (index < lines.length) index++
      result.push(html`<${CodeBlock} key=${'code-' + index} text=${code.join('\n')} language=${fence[2].trim()} />`)
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) { const tag = 'h' + Math.min(6, heading[1].length + 1); result.push(html`<${tag}>${inline(heading[2], reveal, projectPath)}</${tag}>`); index++; continue }
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) { result.push(html`<hr />`); index++; continue }
    if (line.includes('|') && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1])) {
      const headers = cells(line)
      const rows = []
      index += 2
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(cells(lines[index++]))
      result.push(html`<div class="chat-table"><table><thead><tr>${headers.map(cell => html`<th>${inline(cell, reveal, projectPath)}</th>`)}</tr></thead>
        <tbody>${rows.map(row => html`<tr>${row.map(cell => html`<td>${inline(cell, reveal, projectPath)}</td>`)}</tr>`)}</tbody></table></div>`)
      continue
    }
    if (/^>\s?/.test(line)) {
      const quote = []
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ''))
      result.push(html`<blockquote>${markdown(quote.join('\n'), reveal, projectPath)}</blockquote>`)
      continue
    }
    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/)
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2])
      const items = []
      while (index < lines.length) {
        const item = lines[index].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/)
        if (!item || /\d/.test(item[2]) !== ordered) break
        items.push(html`<li style=${{ marginLeft: Math.min(item[1].length * 7, 56) + 'px' }}>${inline(item[3], reveal, projectPath)}</li>`)
        index++
      }
      result.push(ordered ? html`<ol start=${parseInt(listMatch[2], 10)}>${items}</ol>` : html`<ul>${items}</ul>`)
      continue
    }
    const paragraph = [line]
    index++
    while (index < lines.length && !isStart(lines[index])) paragraph.push(lines[index++])
    result.push(html`<p>${inline(paragraph.join('\n'), reveal, projectPath)}</p>`)
  }
  return result
}

function FileCard({ file, reveal, remove }) {
  const [preview, setPreview] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)
  const [imageLoaded, setImageLoaded] = useState(false)
  const href = file.path ? '/api/files?path=' + encodeURIComponent(file.path) : undefined
  const image = imageFailed ? '' : file.preview || (file.path && (/^image\//.test(file.mime || '') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name || '')) ? href : '')
  return html`<div class=${'chat-file ' + (file.status || '')}>
    <button type="button" class="chat-file-main" disabled=${!file.path && !image} title=${image ? '预览 ' + file.name : '打开 ' + file.name}
      onClick=${() => image ? setPreview(true) : reveal(file.path)}>
      ${image && html`<img src=${image} style=${{ display: imageLoaded ? 'block' : 'none' }} alt="" onLoad=${() => setImageLoaded(true)} onError=${() => setImageFailed(true)} />`}
      ${(!image || !imageLoaded) && html`<span class="chat-file-icon" aria-hidden="true">▤</span>`}
      <span><strong>${file.name || file.path?.split(/[\\/]/).pop() || '附件'}</strong>
        <small>${file.status === 'uploading' ? '正在上传…' : file.status === 'error' ? file.error : sizeLabel(file.size) || '文件'}</small></span>
    </button>
    ${file.path && html`<a class="chat-file-location" href=${href} title="打开文件位置" aria-label=${'打开 ' + file.name + ' 的位置'} onClick=${event => { event.preventDefault(); reveal(file.path) }}>↗</a>`}
    ${remove && html`<button type="button" class="chat-file-remove" title="移除附件" aria-label=${'移除 ' + file.name} onClick=${remove}>×</button>`}
    ${preview && html`<div class="chat-preview" role="dialog" aria-modal="true" aria-label=${'预览 ' + file.name} onClick=${() => setPreview(false)}>
      <button type="button" autoFocus aria-label="关闭预览" onClick=${() => setPreview(false)}>×</button><img src=${image} alt=${file.name} /></div>`}
  </div>`
}

const beijingTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })

function MessageTime({ timestamp, local = false }) {
  const date = timestamp === undefined || timestamp === null || timestamp === '' ? null : new Date(timestamp)
  if (!date || Number.isNaN(date.valueOf())) return html`<time class="chat-message-time" title="记录未提供有效时间">时间未知</time>`
  const parts = Object.fromEntries(beijingTime.formatToParts(date).map(part => [part.type, part.value]))
  const label = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
  return html`<time class="chat-message-time" datetime=${date.toISOString()} title=${label + ' 北京时间（UTC+08:00）' + (local ? ' · 本地提交时间' : '')}>${local ? '本地提交 · ' : ''}${label}</time>`
}

function Message({ message, sessionId, tool, reveal, projectPath }) {
  const [copied, setCopied] = useState(false)
  const context = { messageCwd: message.cwd, directoryHints: message.directoryHints }
  const revealMessageFile = path => reveal(path, context)
  if (message.role === 'tool') return html`<details class="chat-tool" data-message-cwd=${message.cwd || ''} data-message-directories=${JSON.stringify(message.directoryHints || [])}><summary><span class="chat-tool-mark" aria-hidden="true">⌘</span>
    <span>${message.toolName || '工具活动'}</span><small>${message.status === 'running' ? '执行中' : message.status === 'error' ? '执行出错' : '查看详情'}</small><${MessageTime} timestamp=${message.timestamp} /></summary>
    <div class="chat-markdown" translate="no">${markdown(message.text, revealMessageFile, projectPath)}</div></details>`
  return html`<article class=${'chat-message chat-message-' + message.role} data-message-id=${message.id}
    data-message-cwd=${message.cwd || ''} data-message-directories=${JSON.stringify(message.directoryHints || [])}>
    <div class="chat-message-label"><strong>${message.role === 'user' ? '你' : tool === 'claude' ? 'Claude' : tool === 'codex' ? 'Codex' : '助手'}</strong><${MessageTime} timestamp=${message.timestamp} /></div>
    <div class="chat-bubble" translate="no">${message.role === 'user' ? html`<div class="chat-user-text">${message.text}</div>` : html`<div class="chat-markdown">${markdown(message.text, revealMessageFile, projectPath)}</div>`}
      ${message.attachments?.length > 0 && html`<div class="chat-files">${message.attachments.map((file, index) => html`<${FileCard} key=${file.path || index} file=${file} reveal=${reveal} />`)}</div>`}
    </div>
    ${message.role === 'assistant' && html`<${OutputFiles} sessionId=${sessionId} message=${message} /><footer class="chat-message-footer">
      <${MessageTime} timestamp=${message.timestamp} />
      ${message.text && html`<button class="chat-copy-message" type="button" onClick=${async () => {
      try { await navigator.clipboard.writeText(message.text); setCopied(true) } catch (_) { setCopied(false) }
    }}>${copied ? '已复制' : '复制回复'}</button>`}
    </footer>`}
  </article>`
}

export function ChatPanel() {
  const sessionId = selectedIdSignal.value
  useEffect(() => {
    window.__preactTerminalActive = true
    if (!document.querySelector('link[data-desktop-chat], link[href="/static/app/chat.css"]')) {
      const style = document.createElement('link')
      style.rel = 'stylesheet'; style.href = '/static/app/chat.css'; style.dataset.desktopChat = 'true'
      document.head.appendChild(style)
    }
    return () => { window.__preactTerminalActive = false }
  }, [])
  return sessionId ? html`<${SessionChat} key=${sessionId} sessionId=${sessionId} />` : html`<${EmptyStateDashboard} />`
}

function SessionChat({ sessionId }) {
  const store = getSession(sessionId)
  const [, setVersion] = useState(0)
  const [error, setError] = useState('')
  const [historyError, setHistoryError] = useState('')
  const [notice, setNotice] = useState('')
  const [dragging, setDragging] = useState(false)
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [showLatest, setShowLatest] = useState(false)
  const [locationOpen, setLocationOpen] = useState(false)
  const [locationPath, setLocationPath] = useState('')
  const [locationChoices, setLocationChoices] = useState([])
  const [advancedPanel, setAdvancedPanel] = useState(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [advancedLoading, setAdvancedLoading] = useState(false)
  const [openingTerminal, setOpeningTerminal] = useState(false)
  const [modelBusy, setModelBusy] = useState(false)
  const [modelOpenRequest, setModelOpenRequest] = useState(null)
  const [commands, setCommands] = useState([])
  const [commandsLoading, setCommandsLoading] = useState(false)
  const [commandsError, setCommandsError] = useState('')
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const [commandConfirmation, setCommandConfirmation] = useState(null)
  const [suggestionSynced, setSuggestionSynced] = useState(false)
  const scrollRef = useRef(null)
  const threadRef = useRef(null)
  const followLatest = useRef(true)
  const inputRef = useRef(null)
  const fileRef = useRef(null)
  const alive = useRef(true)
  const refreshRef = useRef(null)
  const receiptRefreshRef = useRef(null)
  const lastSessionActivity = useRef(null)
  const uploads = useRef(new Map())
  const scrollRestore = useRef(null)
  const dragDepth = useRef(0)
  const commandPosting = useRef(false)
  const confirmationRef = useRef(null)
  const modelBusyRef = useRef(false)
  const session = menuModelSignal.value.sessions.find(item => item.id === sessionId)
  const ancestors = []
  const visited = new Set([sessionId])
  let parentId = session?.parent
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId)
    const parent = menuModelSignal.value.sessions.find(item => item.id === parentId)
    if (!parent) break
    ancestors.unshift(parent)
    parentId = parent.parent
  }
  const status = store.history.status || session?.status || ''
  const substate = store.history.substate || session?.raw?.substate || ''
  const stopped = ['stopped', 'error', 'dead', 'new'].includes(status)
  const startFailed = status === 'error' && Boolean(store.history.startupError)
  const startupError = store.history.startupError
  const running = store.history.turnRunning ?? status === 'running'
  const requestIssue = ['retrying', 'failed'].includes(store.history.requestIssue?.state) ? store.history.requestIssue : null
  const issueStatusText = requestIssue?.state === 'retrying' ? requestIssue.kind === 'network' ? '连接重试中' : '请求重试中' : '回复中断'
  const issueDescription = { network: '连接模型服务失败，请检查网络连接。', authentication: '登录或鉴权未通过，请在独立终端检查账号状态。',
    rate_limit: '请求受到额度或频率限制，请等待后查看状态。', server: '模型服务暂时不可用，请稍后查看状态。' }[requestIssue?.kind] || '请求遇到异常，请查看当前会话状态。'
  const prompt = store.history.prompt
  const verifiedPrompt = prompt?.supported === true && Boolean(prompt.id)
  const commandPromptSuperseded = verifiedPrompt && Boolean(store.pendingCommand?.prompt)
  const requiresAction = !!prompt || /approval|permission|user-input|blocked/.test(substate)
  const readOnly = readOnlySignal.value || store.history.readOnly === true
  const supported = !session?.tool || ['codex', 'claude'].includes(session.tool)
  const uploading = store.files.some(file => file.status === 'uploading')
  const invalidFile = store.files.some(file => file.status === 'error')
  const commandPending = store.pendingCommand && !['done', 'failed'].includes(store.pendingCommand.state)
  const isSlashCommand = /^\/[A-Za-z0-9][\w.:-]*(?:\s|$)/.test(store.draft.trimStart())
  const commandChoices = filterSlashCommands(commands, store.draft, session?.tool)
  const commandMenuOpen = slashOpen && /^\s*\/[^\s/]*$/.test(store.draft)
  const canSend = !!(store.draft.trim() || store.files.some(file => file.path)) && !uploading && !invalidFile && !readOnly && !stopped && !starting && !requiresAction && !store.pending && !store.sending && !commandPending && !modelBusy && supported && store.loaded && store.history.canSend !== false
  const canSubmitDraft = canSend && (!isSlashCommand || (!running && store.files.length === 0))
  const canFillContinue = requestIssue?.state === 'failed' && store.draft === '' && store.files.length === 0 &&
    !store.pending && !store.sending && !store.promptResponse && !store.responding && !commandPending && !commandPosting.current &&
    !readOnly && !stopped && !starting && !requiresAction && !modelBusy && !historyError && supported && store.loaded
  const nativeSuggestion = store.history.suggestion
  const suggestion = suggestionSynced && !historyError && !requestIssue && nativeSuggestion?.text && nativeSuggestion.revision &&
    nativeSuggestion.conversationId === store.history.conversationId && nativeSuggestion.revision !== store.dismissedSuggestion &&
    store.draft === '' && store.files.length === 0 && !readOnly && !stopped && !running && !starting && !requiresAction &&
    !store.pending && !store.sending && !commandPending && !modelBusy && !commandMenuOpen && !advancedOpen &&
    store.history.canSend !== false ? nativeSuggestion : null

  function update(patch = {}) {
    Object.assign(store, patch)
    persist(sessionId, store)
    if (alive.current) setVersion(value => value + 1)
  }

  function dismissSuggestion() {
    if (store.history.suggestion?.revision) store.dismissedSuggestion = store.history.suggestion.revision
  }

  function acceptSuggestion() {
    if (!suggestion || !alive.current || selectedIdSignal.value !== sessionId || store.draft || store.files.length || readOnlySignal.value ||
      store.history.suggestion?.revision !== suggestion.revision) return
    update({ draft: suggestion.text })
    setSlashOpen(false)
    inputRef.current?.focus()
  }

  function fillContinue() {
    if (!canFillContinue || !alive.current || selectedIdSignal.value !== sessionId || readOnlySignal.value ||
      store.history.requestIssue?.id !== requestIssue?.id || store.history.requestIssue?.state !== 'failed' ||
      store.draft !== '' || store.files.length || store.pending || store.sending || store.history.prompt ||
      store.promptResponse || store.responding || commandPosting.current) return
    dismissSuggestion()
    update({ draft: '继续' })
    setSlashOpen(false)
    inputRef.current?.focus()
  }

  function beforeMessages(prepend = false) {
    const el = scrollRef.current
    if (!el) return
    followLatest.current = !prepend
    scrollRestore.current = { top: el.scrollTop, height: el.scrollHeight, prepend }
  }

  function scrollToLatest() {
    const el = scrollRef.current
    if (!el) return
    followLatest.current = true
    el.scrollTop = el.scrollHeight
    setShowLatest(false)
  }

  useLayoutEffect(() => {
    // Closing the optional native panel must keep the legacy terminal path suppressed.
    window.__preactTerminalActive = true
    const el = scrollRef.current
    if (!el) return
    if (inputRef.current) {
      inputRef.current.style.height = 'auto'
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 200) + 'px'
    }
    const position = scrollRestore.current
    if (position) {
      if (position.prepend) el.scrollTop = position.top + el.scrollHeight - position.height
      else scrollToLatest()
      scrollRestore.current = null
    }
  })

  useLayoutEffect(() => {
    let frame
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (alive.current && followLatest.current && !scrollRestore.current?.prepend) scrollToLatest()
      })
    })
    observer.observe(threadRef.current)
    observer.observe(scrollRef.current)
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setCommandsLoading(true); setCommandsError('')
    request('/desktop/chat/commands?' + new URLSearchParams({ sessionId }), undefined, controller.signal)
      .then(data => { if (alive.current && (!data.tool || data.tool === session?.tool)) setCommands(data.commands || []) })
      .catch(err => { if (err.name !== 'AbortError' && alive.current) setCommandsError(err.message || '暂时无法读取可用命令。') })
      .finally(() => { if (alive.current) setCommandsLoading(false) })
    return () => controller.abort()
  }, [sessionId, session?.tool])

  useEffect(() => {
    alive.current = true
    let controller, timer, inFlight = false, refreshRequested = false, promptRefreshRequested = false, failures = 0
    scrollToLatest()
    async function refresh(acknowledgePrompt = false) {
      if (!alive.current) return
      if (acknowledgePrompt === true) promptRefreshRequested = true
      if (document.hidden) return
      if (inFlight) { refreshRequested = true; return }
      clearTimeout(timer)
      controller = new AbortController()
      inFlight = true
      try {
        const promptRevision = store.promptRevision
        const history = await request('/desktop/chat/history?' + new URLSearchParams({ sessionId }), undefined, controller.signal)
        if (!alive.current) return
        const conversationChanged = store.history.conversationId && history.conversationId && store.history.conversationId !== history.conversationId
        // A poll started before a response must not restore the previous prompt.
        if (!conversationChanged && promptRevision !== store.promptRevision) history.prompt = store.history.prompt
        const fresh = history.messages || []
        const known = new Map((conversationChanged ? [] : store.messages).map(message => [message.id, message]))
        const contentChanged = conversationChanged || fresh.some(message => JSON.stringify(known.get(message.id)) !== JSON.stringify(message)) ||
          history.prompt?.id !== store.history.prompt?.id || JSON.stringify(history.requestIssue || null) !== JSON.stringify(store.history.requestIssue || null)
        if (contentChanged) beforeMessages()
        for (const message of fresh) known.set(message.id, message)
        const messages = [...known.values()]
        const response = promptRevision === store.promptRevision && history.responseStatus && history.responseStatus.promptId === history.prompt?.id
          ? { ...store.promptResponse, ...history.responseStatus } : store.promptResponse
        const differentVerifiedPrompt = history.prompt?.supported === true && history.prompt.id && response?.promptId !== history.prompt.id
        const promptResponse = conversationChanged || (response && (response.state === 'stale' ? promptRefreshRequested || differentVerifiedPrompt : response.promptId !== history.prompt?.id)) ? null : response
        update({ messages, history: store.olderLoaded && !conversationChanged ? { ...history, hasMore: store.history.hasMore, before: store.before } : history,
          loaded: true, promptResponse, ...(conversationChanged ? { olderLoaded: false, before: null } : {}) })
        setSuggestionSynced(true)
        promptRefreshRequested = false
        failures = 0
        setHistoryError('')
        wsStateSignal.value = 'connected'
        if (store.pendingCommand && !['done', 'failed'].includes(store.pendingCommand.state) &&
            !(store.pendingCommand.state === 'unknown' && store.pendingCommand.requestActive === false) && !commandPosting.current) {
          await refreshCommand(false, controller.signal)
        }
      } catch (err) {
        if (err.name !== 'AbortError' && alive.current) { failures++; setSuggestionSynced(false); setHistoryError(err.message || '暂时无法同步聊天记录。'); wsStateSignal.value = 'error' }
      } finally {
        inFlight = false
        if (alive.current && !document.hidden) {
          const active = (store.history.turnRunning ?? store.history.status === 'running') || (store.pending && store.pending.requestActive !== false && !store.pending.retrySafe) ||
            store.pendingCommand?.requestActive === true || (store.promptResponse && !store.promptResponse.trackingStopped && store.promptResponse.requestActive !== false)
          const delay = failures ? Math.min(15000, 1800 * 2 ** failures) : active ? 1800 : 10000
          timer = setTimeout(refresh, refreshRequested ? 0 : delay)
        }
        refreshRequested = false
      }
    }
    const visibility = () => {
      if (document.hidden) { clearTimeout(timer); controller?.abort() }
      else refresh()
    }
    refreshRef.current = refresh
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('focus', visibility)
    refresh()
    return () => {
      alive.current = false
      controller?.abort(); clearTimeout(timer)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('focus', visibility)
      // Uploads remain bound to this session and can finish while another chat is open.
      refreshRef.current = null
    }
  }, [sessionId])

  // Native status changes wake idle history immediately, without constant transcript reads.
  useEffect(() => {
    const next = [session?.status, session?.raw?.substate, session?.raw?.hook_status].join(':')
    if (lastSessionActivity.current !== null && lastSessionActivity.current !== next) refreshRef.current?.()
    lastSessionActivity.current = next
  }, [session?.status, session?.raw?.substate, session?.raw?.hook_status])

  async function queryPending(signal) {
    const pending = store.pending
    if (!pending || store.sending) return
    const deliveryRevision = pending.deliverNowRevision || 0
    const params = pending.sendId ? { sendId: pending.sendId } : { sessionId, clientId: pending.clientId }
    try {
      const receipt = await request('/desktop/chat/send-status?' + new URLSearchParams(params), undefined, signal, true)
      if (store.pending?.clientId !== pending.clientId) return
      if (deliveryRevision !== (store.pending.deliverNowRevision || 0)) {
        for (const key of ['canDeliverNow', 'deliverNowReason', 'deliverNowWillInterrupt', 'deliverNowState', 'deliverNowAttempted']) delete receipt[key]
      }
      if (receipt.status === 'landed' || receipt.landedRowId || receipt.observedInHistory === true) {
        update({ pending: null, ...clearSubmittedDraft(pending) })
        if (receipt.observedInHistory === true && receipt.status !== 'landed' && alive.current) setNotice('已在会话记录中看到此消息；投递回执未完整确认。')
        refreshRef.current?.()
      } else {
        const retryDelivery = deliveryRevision === (store.pending.deliverNowRevision || 0) && receipt.deliverNowState === 'refused' &&
          receipt.keySent === false && receipt.retryAllowed === true && !receipt.unknown
        update({ pending: { ...store.pending, ...receipt, receiptError: '', ...(retryDelivery ? { deliverNowRequested: false, deliverNowAttempted: false } : {}) } })
      }
    } catch (err) {
      if (err.name !== 'AbortError' && store.pending?.clientId === pending.clientId) {
        update({ pending: { ...store.pending, requestActive: null, canStopTracking: false, receiptError: err.message } })
      }
    }
  }

  useEffect(() => {
    let disposed = false, timer, controller, inFlight = false
    async function refresh() {
      if (disposed || inFlight || document.hidden || !store.pending || store.sending) return
      clearTimeout(timer)
      inFlight = true
      controller = new AbortController()
      try { await queryPending(controller.signal) }
      finally {
        inFlight = false
        if (!disposed && !document.hidden && store.pending && store.pending.requestActive !== false && !store.pending.retrySafe) {
          timer = setTimeout(refresh, store.pending.receiptError ? 15000 : 1000)
        }
      }
    }
    const visibility = () => {
      if (document.hidden) { clearTimeout(timer); controller?.abort() }
      else refresh()
    }
    receiptRefreshRef.current = refresh
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('focus', visibility)
    refresh()
    return () => {
      disposed = true; clearTimeout(timer); controller?.abort()
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('focus', visibility)
      receiptRefreshRef.current = null
    }
  }, [sessionId, store.pending?.clientId, store.sending])

  async function loadMore() {
    if (loadingMore || !store.history.hasMore) return
    const conversationId = store.history.conversationId
    setLoadingMore(true)
    try {
      const data = await request('/desktop/chat/history?' + new URLSearchParams({ sessionId, before: store.before || store.history.before || store.messages[0]?.id || '' }))
      if (!alive.current) return
      if ((conversationId && store.history.conversationId && conversationId !== store.history.conversationId) ||
        (data.conversationId && store.history.conversationId && data.conversationId !== store.history.conversationId)) return
      beforeMessages(true)
      const ids = new Set(store.messages.map(message => message.id))
      update({ messages: [...(data.messages || []).filter(message => !ids.has(message.id)), ...store.messages],
        before: data.before, olderLoaded: true, history: { ...store.history, hasMore: data.hasMore, before: data.before } })
    } catch (err) { if (alive.current) setError(err.message) }
    finally { if (alive.current) setLoadingMore(false) }
  }

  useEffect(() => {
    const onReveal = event => {
      if (event.detail?.sessionId !== sessionId) return
      event.preventDefault()
      const { path, messageCwd, directoryHints } = event.detail
      reveal(path, { messageCwd, directoryHints })
    }
    document.addEventListener('agentdeck:reveal-message-file', onReveal)
    return () => document.removeEventListener('agentdeck:reveal-message-file', onReveal)
  }, [sessionId])

  async function reveal(path, context = {}) {
    setError('')
    setLocationChoices([])
    try {
      const result = await request('/desktop/reveal', { sessionId, ...(path ? { path } : {}), ...context })
      if (alive.current) {
        if (result.candidates?.length > 1) { setLocationChoices(result.candidates); return }
        setLocationChoices([]); setLocationOpen(false); setNotice('已在文件管理器中打开。')
      }
    } catch (err) { if (alive.current) setError(err.message || '无法打开文件位置。') }
  }

  function addFiles(values) {
    if (readOnlySignal.value) return
    setError('')
    for (const file of Array.from(values || [])) {
      const id = crypto.randomUUID()
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : ''
      const item = { id, name: file.name, size: file.size, mime: file.type, preview, status: 'uploading' }
      if (file.size > MAX_FILE_SIZE) { item.status = 'error'; item.error = '文件超过 100 MB' }
      update({ files: [...store.files, item] })
      if (item.status === 'error') continue
      const controller = new AbortController()
      uploads.current.set(id, controller)
      const release = beginUiMutation()
      fetch('/desktop/upload?' + new URLSearchParams({ sessionId, name: file.name }), {
        method: 'POST', headers: { ...HEADER }, body: file, signal: controller.signal,
      }).then(async response => {
        const data = await response.json()
        if (!response.ok || !data.path) throw new Error(data?.error?.message || data.error || '上传失败，请移除后重试。')
        update({ files: store.files.map(entry => entry.id === id ? { ...entry, path: data.path, name: data.name || file.name, status: 'ready' } : entry) })
      }).catch(err => {
        if (err.name !== 'AbortError') update({ files: store.files.map(entry => entry.id === id ? { ...entry, status: 'error', error: err.message } : entry) })
      }).finally(() => { uploads.current.delete(id); release() })
    }
  }

  function removeFile(file) {
    uploads.current.get(file.id)?.abort()
    if (file.preview) URL.revokeObjectURL(file.preview)
    update({ files: store.files.filter(entry => entry.id !== file.id) })
  }

  function clearSubmittedDraft(pending) {
    const sentPaths = new Set(pending.paths || [])
    for (const file of store.files) if (sentPaths.has(file.path) && file.preview) URL.revokeObjectURL(file.preview)
    return { draft: store.draft === pending.text ? '' : store.draft, files: store.files.filter(file => !sentPaths.has(file.path)) }
  }

  function stopTracking(kind) {
    const record = kind === 'send' ? store.pending : store.pendingCommand
    if (!record?.canStopTracking || store.sending || commandPosting.current) return
    update({ recoveryRecords: [...store.recoveryRecords, { ...record, kind, trackingStopped: true }],
      ...(kind === 'send' ? { pending: null, ...clearSubmittedDraft(record) } : { pendingCommand: null }) })
    refreshRef.current?.()
  }

  async function queryRecovery(record) {
    const id = record.kind === 'send' ? record.clientId : record.requestId
    const same = item => item.kind === record.kind && (item.kind === 'send' ? item.clientId : item.requestId) === id
    try {
      const params = record.kind === 'send' ? record.sendId ? { sendId: record.sendId } : { sessionId, clientId: record.clientId }
        : { sessionId, requestId: record.requestId }
      const result = await request('/desktop/chat/' + (record.kind === 'send' ? 'send-status?' : 'command-status?') + new URLSearchParams(params), undefined, undefined, true)
      update({ recoveryRecords: store.recoveryRecords.map(item => same(item) ? { ...item, ...result, receiptError: '' } : item) })
      refreshRef.current?.()
    } catch (err) {
      update({ recoveryRecords: store.recoveryRecords.map(item => same(item) ? { ...item, receiptError: err.message } : item) })
    }
  }

  async function send() {
    if (selectedIdSignal.value !== sessionId || store.sending || !canSend) return
    if (isSlashCommand) { await runCommand(); return }
    if (new TextEncoder().encode(store.draft).length > 48000) { setError('消息超过 48 KB，请缩短内容或将长内容作为文件附件发送。'); return }
    dismissSuggestion()
    const pending = { clientId: crypto.randomUUID(), text: store.draft, paths: store.files.filter(file => file.path).map(file => file.path),
      attachments: store.files.filter(file => file.path).map(({ preview, ...file }) => file), status: 'submitting', submittedAt: new Date().toISOString() }
    beforeMessages()
    update({ pending, sending: true })
    setError(''); setNotice('')
    try {
      const data = await request('/desktop/chat/send', { sessionId, text: pending.text, paths: pending.paths, clientId: pending.clientId }, undefined, true)
      if (data.success === false) {
        update({ pending: { ...pending, ...data, clientId: pending.clientId, status: data.status || 'unknown' } })
        return
      }
      update({ pending: { ...pending, ...data }, ...clearSubmittedDraft(pending) })
      if (alive.current) refreshRef.current?.()
    } catch (err) {
      // No transport failure proves the server did not receive the request.
      update({ pending: { ...pending, status: 'unknown', reason: err.message } })
    } finally { update({ sending: false }) }
  }

  async function startSession() {
    if (starting || selectedIdSignal.value !== sessionId) return
    setStarting(true); setError(''); setNotice('')
    try {
      await request('/desktop/chat/start', { sessionId })
      noteSessionStarted(sessionId)
      if (alive.current) refreshRef.current?.()
    } catch (err) {
      if (alive.current) { setError('会话启动失败：' + (err.data?.startupError?.reason || err.message || '请重试或打开高级控制检查。')); refreshRef.current?.() }
    }
    finally { if (alive.current) setStarting(false) }
  }

  async function interrupt() {
    if (stopping || selectedIdSignal.value !== sessionId) return
    setStopping(true); setError('')
    try { await request('/desktop/chat/interrupt', { sessionId }); if (alive.current) { setNotice('已发送停止请求，正在等待会话确认。'); refreshRef.current?.() } }
    catch (err) { if (alive.current) setError(err.message || '未能停止生成。') }
    finally { if (alive.current) setStopping(false) }
  }

  async function continuePending() {
    const pending = store.pending
    if (!pending?.sendId || !pending.canContinue || pending.continueRequested || readOnly || selectedIdSignal.value !== sessionId) return
    const sendId = pending.sendId
    update({ pending: { ...pending, continueRequested: true, continueState: 'posting' } })
    setError('')
    try {
      await request('/desktop/chat/continue', { sendId })
      if (store.pending?.sendId === sendId) update({ pending: { ...store.pending, canContinue: false, continueState: 'waiting' } })
      if (alive.current) refreshRef.current?.()
    } catch (err) {
      if (store.pending?.sendId === sendId) update({ pending: { ...store.pending, continueState: 'unknown' } })
      if (alive.current) {
        setError('暂存消息提交未确认：' + (err.message || '请检查连接。') + ' 正在查询原发送回执。')
        refreshRef.current?.()
      }
    }
  }

  async function deliverPendingNow() {
    const pending = store.pending
    if (!pending?.sendId || !pending.canDeliverNow || pending.deliverNowRequested || pending.deliverNowAttempted ||
        readOnly || requiresAction || selectedIdSignal.value !== sessionId) return
    const sendId = pending.sendId
    update({ pending: { ...pending, deliverNowRequested: true, deliverNowState: 'posting',
      deliverNowRevision: (pending.deliverNowRevision || 0) + 1 } })
    setError('')
    try {
      const data = await request('/desktop/chat/deliver-now', { sessionId, sendId }, undefined, true)
      if (data.sendId !== sendId) throw new Error('投递回执与原消息不一致，请查询原消息状态。')
      if (store.pending?.sendId === sendId) {
        const retryAllowed = data.keySent === false && data.retryAllowed === true && !data.unknown
        update({ pending: { ...store.pending, ...data, deliverNowRequested: !retryAllowed,
          ...(retryAllowed ? { deliverNowAttempted: false } : {}),
          deliverNowRevision: (store.pending.deliverNowRevision || 0) + 1,
          deliverNowState: data.deliverNowState || (retryAllowed ? 'refused' : 'waiting') } })
        if (alive.current && data.message) setNotice(data.message)
      }
    } catch (err) {
      if (store.pending?.sendId === sendId) {
        const retryAllowed = err.data?.keySent === false && err.data?.retryAllowed === true && !err.data?.unknown
        update({ pending: { ...store.pending, ...(err.data?.sendId === sendId ? err.data : {}),
          deliverNowRequested: !retryAllowed, ...(retryAllowed ? { deliverNowAttempted: false } : {}),
          deliverNowRevision: (store.pending.deliverNowRevision || 0) + 1,
          deliverNowState: retryAllowed ? 'refused' : 'unknown' } })
        if (alive.current) setError((retryAllowed ? '暂未投递：' : '立即投递结果待确认：') + err.message)
      }
    } finally { if (alive.current) refreshRef.current?.() }
  }

  async function respond(answer) {
    if (!prompt?.id || prompt.supported !== true || store.history.prompt?.id !== prompt.id || store.history.prompt?.supported !== true ||
      store.promptResponse || store.responding || commandPosting.current || readOnly || historyError || selectedIdSignal.value !== sessionId) return
    const promptId = prompt.id
    update({ responding: true, promptRevision: (store.promptRevision || 0) + 1, promptResponse: { promptId, state: 'posting' } })
    setError(''); setNotice('')
    try {
      const data = await request('/desktop/chat/respond', { sessionId, promptId, ...answer })
      const next = Object.prototype.hasOwnProperty.call(data, 'prompt') ? { ...store.history, prompt: data.prompt } : store.history
      beforeMessages()
      update({ history: next, promptRevision: (store.promptRevision || 0) + 1, promptResponse: next.prompt?.id !== promptId ? null : { promptId, state: 'waiting', message: data.message || '选择已发送，正在等待会话更新。' } })
      if (alive.current && data.outcome === 'pending') setNotice('本次提交结果尚待核对，请查看会话后续状态。')
      else if (alive.current && ['accepted', 'cancelled', 'next-step'].includes(data.outcome) && data.message) setNotice(data.message)
    } catch (err) {
      const stale = err.status === 409 && err.data?.keySent === false && !err.data?.unknown
      const notSent = err.data?.keySent === false && !err.data?.unknown
      const rejected = err.data?.outcome === 'rejected'
      if (rejected && alive.current) setError(err.message)
      update({ promptRevision: (store.promptRevision || 0) + 1,
        ...(Object.prototype.hasOwnProperty.call(err.data || {}, 'prompt') ? { history: { ...store.history, prompt: err.data.prompt } } : {}),
        promptResponse: { promptId, state: stale || notSent ? 'stale' : 'unknown',
          message: rejected ? err.message : (stale ? '提示已过期，请刷新后重新查看并选择。' : notSent ? '回答未提交，请刷新后重新选择。' : '提交结果待确认。已暂停重复提交，请刷新查询当前状态。') + (err.message ? ' ' + err.message : '') } })
    } finally { update({ responding: false }); if (alive.current) refreshRef.current?.() }
  }

  async function openTerminal() {
    if (openingTerminal || selectedIdSignal.value !== sessionId) return
    setOpeningTerminal(true); setError(''); setNotice('')
    try {
      const result = await request('/desktop/terminal/open', { sessionId })
      if (alive.current) setNotice(result.message || '已在独立终端打开当前会话。')
    } catch (err) { if (alive.current) setError(err.message || '未能打开独立终端。') }
    finally { if (alive.current) setOpeningTerminal(false) }
  }

  function openModelControls(command, argument = '') {
    setModelOpenRequest({ key: crypto.randomUUID(), focus: command === '/effort' ? 'effort' : 'model',
      ...(argument ? command === '/effort' ? { reasoningEffort: argument } : { modelId: argument } : {}) })
    setSlashOpen(false)
  }

  function clearCommandConfirmation() {
    confirmationRef.current = null; setCommandConfirmation(null)
  }

  function chooseCommand(command, fillOnly = false) {
    clearCommandConfirmation()
    const policy = slashCommandPolicy(command, session?.tool)
    if (!fillOnly && policy.mode === 'model') {
      update({ draft: '' }); openModelControls(command.name)
    } else if (!fillOnly && policy.mode === 'execute') {
      runCommand(command.name)
    } else {
      update({ draft: slashInsertText(command) }); setSlashOpen(false); setError('')
      if (!fillOnly && policy.mode === 'confirm') confirmCommand(command.name, policy.message)
      else setNotice(fillOnly ? '命令已填入，按 Enter 执行。' : policy.message)
      inputRef.current?.focus()
    }
  }

  function confirmCommand(command, message) {
    const confirmation = { command, message }
    confirmationRef.current = confirmation; setCommandConfirmation(confirmation)
  }

  function commandBlockedReason() {
    const current = menuModelSignal.value.sessions.find(item => item.id === sessionId)
    const status = store.history.status || current?.status
    if (!alive.current || selectedIdSignal.value !== sessionId) return '会话已切换，请在当前会话重新选择命令。'
    if (readOnlySignal.value || store.history.readOnly) return '当前界面为只读，无法执行命令。'
    if (!['claude', 'codex'].includes(current?.tool)) return '此会话不支持原生命令。'
    if (starting || ['stopped', 'error', 'dead', 'new', 'starting'].includes(status)) return '请先启动当前会话。'
    if (store.files.length) return '命令不支持附件，请移除附件后执行。'
    if (store.pending || store.sending) return '会话还有待送达消息，请等待送达后执行命令。'
    if (commandPosting.current || store.pendingCommand && !['done', 'failed'].includes(store.pendingCommand.state)) return '上一条命令尚未结束，请先处理当前命令。'
    if (store.history.prompt || store.responding || /approval|permission|user-input|blocked/.test(store.history.substate || current?.raw?.substate || '')) return '请先完成当前会话中的选择或确认。'
    if (modelBusyRef.current) return '模型设置正在处理，请完成后再执行命令。'
    if (store.history.turnRunning ?? status === 'running') return '会话正在处理，请完成后再执行命令。'
    if (historyError || !store.loaded || store.history.canSend === false) return '会话状态尚未同步，请连接并刷新后再执行命令。'
    return ''
  }

  function applyCommandRecord(record) {
    const previous = store.pendingCommand
    if (!previous || record.requestId !== previous.requestId || record.sessionId !== sessionId) throw new Error('命令回执与当前请求不一致。')
    const terminal = ['done', 'failed'].includes(record.state)
    const response = previous.response && (terminal || (previous.response.state !== 'stale' && previous.response.promptId !== record.prompt?.id)) ? null : record.response || previous.response
    beforeMessages()
    update({ commandRevision: (store.commandRevision || 0) + 1, pendingCommand: { ...previous, ...record, ...(terminal ? { prompt: null } : {}), response } })
    if (previous.state !== 'done' && record.state === 'done' && /^\/(?:model|effort)(?:\s|$)/i.test(record.command || previous.command)) {
      setModelOpenRequest({ key: crypto.randomUUID(), refreshOnly: true })
    }
  }

  async function refreshCommand(acknowledge = false, signal) {
    const current = store.pendingCommand
    if (!current?.requestId || commandPosting.current) return
    const revision = store.commandRevision || 0
    try {
      const record = await request('/desktop/chat/command-status?' + new URLSearchParams({ sessionId, requestId: current.requestId }), undefined, signal, true)
      if (store.pendingCommand?.requestId !== current.requestId || commandPosting.current || revision !== (store.commandRevision || 0)) return
      applyCommandRecord(record)
      if (acknowledge && store.pendingCommand?.response?.state === 'stale') update({ pendingCommand: { ...store.pendingCommand, response: null } })
    } catch (err) {
      if (err.name !== 'AbortError' && store.pendingCommand?.requestId === current.requestId && !commandPosting.current && revision === (store.commandRevision || 0)) {
        update({ pendingCommand: { ...store.pendingCommand, state: 'unknown', requestActive: null, canStopTracking: false, message: '命令结果待确认：' + err.message } })
      }
    }
  }

  async function runCommand(commandText = store.draft, confirmed = false) {
    const blocked = commandBlockedReason()
    if (blocked) { if (alive.current) setError(blocked); return }
    const command = commandText.trim()
    const modelCommand = /^\/(model|effort)(?:\s+([\s\S]*))?$/i.exec(command)
    if (modelCommand) { update({ draft: '' }); openModelControls('/' + modelCommand[1].toLowerCase(), (modelCommand[2] || '').trim()); return }
    const entry = commands.find(item => item.name === command.split(/\s/, 1)[0])
    const policy = slashCommandPolicy(entry, session?.tool)
    if (policy.mode === 'confirm' && !confirmed) {
      update({ draft: command }); setSlashOpen(false); setNotice(''); confirmCommand(command, policy.message); return
    }
    clearCommandConfirmation()
    const record = { sessionId, requestId: crypto.randomUUID(), command, state: 'running', submittedAt: new Date().toISOString() }
    commandPosting.current = true; setSlashOpen(false); setError(''); setNotice('正在执行 ' + command.split(/\s/, 1)[0] + '…'); beforeMessages()
    update({ commandRevision: (store.commandRevision || 0) + 1, pendingCommand: record, draft: '' })
    try {
      applyCommandRecord(await request('/desktop/chat/command', { sessionId, command, requestId: record.requestId }, undefined, true))
    } catch (err) {
      if (store.pendingCommand?.requestId === record.requestId) {
        if (err.data?.requestId === record.requestId && err.data.sessionId === sessionId) applyCommandRecord(err.data)
        else update({ pendingCommand: { ...record, state: err.data?.keySent === false ? 'failed' : 'unknown', message: err.message || '命令提交结果待确认。' } })
      }
    } finally { commandPosting.current = false; if (alive.current) setNotice(''); update(); if (alive.current) refreshRef.current?.() }
  }

  async function respondCommand(answer) {
    const record = store.pendingCommand
    if (!record?.prompt?.supported || !record.prompt.id || record.response || commandPosting.current || readOnly ||
      (store.history.prompt?.supported === true && store.history.prompt.id) || selectedIdSignal.value !== sessionId) return
    const promptId = record.prompt.id
    commandPosting.current = true
    update({ commandRevision: (store.commandRevision || 0) + 1, pendingCommand: { ...record, response: { promptId, state: 'posting' } } })
    try {
      const result = await request('/desktop/chat/command-respond', { sessionId, requestId: record.requestId, promptId,
        ...(answer.action === 'cancel' ? { action: 'cancel' } : { choice: answer.choice }) }, undefined, true)
      applyCommandRecord(result)
      if (store.pendingCommand?.response) update({ pendingCommand: { ...store.pendingCommand, response: { promptId, state: 'waiting' } } })
    } catch (err) {
      if (err.data?.requestId === record.requestId && err.data.sessionId === sessionId) applyCommandRecord(err.data)
      if (store.pendingCommand?.requestId === record.requestId) update({ pendingCommand: { ...store.pendingCommand,
        response: { promptId, state: err.data?.keySent === false && !err.data?.unknown ? 'stale' : 'unknown', message: err.message || '选择结果待确认，请查询原命令状态。' } } })
    } finally { commandPosting.current = false; update(); if (alive.current) refreshRef.current?.() }
  }

  async function openAdvanced() {
    if (advancedPanel) { setAdvancedOpen(true); return }
    setAdvancedLoading(true)
    try {
      const module = await import('./NativeTerminalPanel.js')
      if (alive.current) { setAdvancedPanel(() => module.TerminalPanel); setAdvancedOpen(true) }
    } catch (_) { if (alive.current) setError('高级控制加载失败，请重试。') }
    finally { if (alive.current) setAdvancedLoading(false) }
  }

  const statusText = starting ? '正在启动' : startFailed ? '会话启动失败' : stopped ? '未运行' : modelBusy ? '正在切换模型' :
    verifiedPrompt ? '等待你的确认' : commandPending ? store.pendingCommand.prompt ? '等待命令选择' : store.pendingCommand.state === 'unknown' ? '命令结果待确认' : '命令处理中' :
    requiresAction ? '等待你的确认' : requestIssue ? issueStatusText : running ? '正在处理' : store.history.backgroundWork ? '后台任务运行中' : store.loaded ? '可以发送消息' : '正在连接'
  const hasFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files')
  return html`<section class="chat-panel" data-desktop-session-id=${sessionId} aria-label="会话聊天"
    onDragEnter=${event => { if (hasFiles(event)) { event.preventDefault(); dragDepth.current++; setDragging(true) } }}
    onDragOver=${event => { if (hasFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = readOnly ? 'none' : 'copy' } }}
    onDragLeave=${event => { if (hasFiles(event)) { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false) } }}
    onDrop=${event => {
      if (!hasFiles(event)) return
      event.preventDefault(); event.stopPropagation(); dragDepth.current = 0; setDragging(false)
      if (Array.from(event.dataTransfer.items || []).some(item => item.webkitGetAsEntry?.()?.isDirectory)) { setError('请添加文件，文件夹可打开后多选其中的文件。'); return }
      addFiles(event.dataTransfer.files)
    }}>
    <header class="chat-header chat-header-with-quota"><div class="chat-header-info"><nav class="chat-breadcrumb" aria-label="项目与会话层级" translate="no">
      ${session?.group && html`<button type="button" title=${session.group} onClick=${() => selectGroup(session.group)}>▱ ${session.group}</button><span aria-hidden="true">›</span>`}
      ${ancestors.map(parent => html`<button type="button" title=${parent.title} onClick=${() => selectSession(parent.id)}>${parent.title}</button><span aria-hidden="true">›</span>`)}
      <span aria-current="page">${session?.title || '当前会话'}</span></nav>
      <div class="chat-title-line"><strong translate="no">${session?.title || '当前会话'}</strong><span class=${'chat-state ' + (requestIssue ? 'issue-' + requestIssue.state : running ? 'active' : '')}><i />${statusText}</span></div></div>
      <div class="chat-header-actions"><${ChatQuota} key=${'quota:' + sessionId} sessionId=${sessionId} tool=${session?.tool} />
        <${SessionModelControls} key=${sessionId + ':' + session?.tool} sessionId=${sessionId} tool=${session?.tool}
        disabled=${readOnly || stopped || running || starting || requiresAction || Boolean(store.pending) || Boolean(commandPending)}
        openRequest=${modelOpenRequest} onBusyChange=${value => { modelBusyRef.current = value; setModelBusy(value) }} onApplied=${() => refreshRef.current?.()} />
        <button type="button" class="chat-terminal-button" title="在独立终端打开" aria-label="在独立终端打开" disabled=${openingTerminal} onClick=${openTerminal}>
          <span aria-hidden="true">›_</span><span class="chat-terminal-label">${openingTerminal ? '正在打开…' : '独立终端'}</span></button>
        <button type="button" class="chat-icon-button" title="打开项目文件夹" aria-label="打开项目文件夹" onClick=${() => reveal()}>▱</button>
        <button type="button" class="chat-icon-button" title="定位文件" aria-label="定位文件" onClick=${() => setLocationOpen(value => !value)}>⌕</button>
        <button type="button" class="chat-icon-button" title="高级控制" aria-label="打开高级控制" disabled=${advancedLoading} onClick=${openAdvanced}>⋯</button></div></header>
    ${historyError && html`<div class="chat-banner error" role="alert"><span>聊天同步暂时中断：${historyError}</span><button type="button" onClick=${() => refreshRef.current?.()}>重新连接</button></div>`}
    ${locationOpen && html`<form class="chat-locate" onSubmit=${event => { event.preventDefault(); if (locationPath.trim()) reveal(locationPath.trim()) }}><input aria-label="文件或文件夹路径" placeholder="粘贴 Windows 或 WSL 文件路径" value=${locationPath} onInput=${event => setLocationPath(event.currentTarget.value)} /><button type="submit" disabled=${!locationPath.trim()}>打开位置</button><button type="button" onClick=${() => setLocationOpen(false)}>取消</button></form>`}
    ${locationChoices.length > 1 && html`<section class="chat-location-choices" aria-label="选择文件位置">
      <div><strong>找到多个位置，请选择要打开的文件</strong><button type="button" aria-label="取消选择文件位置" onClick=${() => setLocationChoices([])}>×</button></div>
      ${locationChoices.map(candidate => html`<button type="button" key=${candidate} onClick=${() => reveal(candidate)}><code translate="no">${candidate}</code></button>`)}
    </section>`}
    <div class="chat-scroll" ref=${scrollRef} onScroll=${() => {
      const el = scrollRef.current
      setShowLatest(el.scrollHeight - el.scrollTop - el.clientHeight > 180)
    }}><div class="chat-thread" ref=${threadRef}>
      ${store.history.hasMore && html`<button class="chat-load-more" type="button" disabled=${loadingMore} onClick=${loadMore}>${loadingMore ? '正在加载…' : '查看更早消息'}</button>`}
      ${!store.loaded && !historyError && html`<div class="chat-empty"><span class="chat-empty-mark">◌</span><h2>正在加载聊天记录</h2><p>连接当前会话，恢复上下文。</p></div>`}
      ${store.loaded && store.messages.length === 0 && html`<div class="chat-empty"><span class="chat-empty-mark">✳</span><h2>${startFailed ? '会话启动失败' : stopped ? '继续你的工作' : '从这里开始'}</h2><p>${startFailed ? '进程启动后提前退出，请重试或打开高级控制检查。' : stopped ? '启动会话后，输入需求或添加文件。' : '描述要完成的事，也可以拖入图片和文件。'}</p></div>`}
      ${store.messages.filter(message => ['user', 'assistant', 'tool'].includes(message.role)).map(message => html`<${Message} key=${message.id} message=${message} sessionId=${sessionId} tool=${session?.tool} reveal=${reveal} projectPath=${session?.path} />`)}
      ${store.recoveryRecords.map(record => html`<section class="chat-pending chat-recovery" key=${record.clientId || record.requestId}>
        <strong>已停止本地跟踪，原请求保留</strong><p translate="no">${record.text || record.command || record.attachments?.map(file => file.name).join('、')}</p>
        <small>${record.receiptError || record.reason || record.message || ''}</small>
        ${['landed', 'done'].includes(record.status || record.state) && html`<p>原请求已完成</p>`}
        <button type="button" onClick=${() => queryRecovery(record)}>查询原请求</button>
        ${(record.prompt || record.needsInput) && html`<button type="button" disabled=${openingTerminal} onClick=${openTerminal}>在独立终端继续</button>`}
      </section>`)}
      ${store.pending && html`<div class="chat-pending" role="status"><strong>${store.pending.retrySafe ? '消息未送达' : store.pending.status === 'submitting' ? '正在提交消息…' : store.pending.status === 'unknown' ? '发送结果待确认' : '消息已排队，等待会话确认'}</strong>
        <${MessageTime} timestamp=${store.pending.submittedAt} local=${true} />
        <p translate="no">${store.pending.text || store.pending.attachments?.map(file => file.name).join('、')}</p>
        ${store.pending.reason && html`<small>${store.pending.reason}</small>`}
        ${store.pending.receiptError && html`<small>${store.pending.receiptError}</small>`}
        ${(store.pending.canDeliverNow || store.pending.deliverNowRequested || store.pending.deliverNowAttempted || ['queued', 'typing', 'typed'].includes(store.pending.status)) && html`<div class="chat-deliver-now">
          <button type="button" disabled=${!store.pending.canDeliverNow || store.pending.deliverNowRequested || store.pending.deliverNowAttempted || readOnly || requiresAction}
            onClick=${deliverPendingNow}>${store.pending.deliverNowState === 'posting' ? '正在立即投递…' : store.pending.deliverNowState === 'unknown' ? '投递结果待确认' : store.pending.deliverNowRequested || store.pending.deliverNowAttempted ? '已请求立即投递' : '立即投递'}</button>
          ${store.pending.deliverNowWillInterrupt && !store.pending.deliverNowRequested && html`<small>立即投递可能中断当前回合。</small>`}
          ${store.pending.deliverNowReason && html`<small>${store.pending.deliverNowReason}</small>`}
          ${store.pending.deliverNowState === 'unknown' && html`<button type="button" onClick=${() => receiptRefreshRef.current?.()}>查询投递状态</button>`}
        </div>`}
        ${!store.pending.canDeliverNow && !store.pending.deliverNowRequested && (store.pending.canContinue || store.pending.continueRequested) && html`<button type="button" disabled=${store.pending.continueRequested || readOnly} onClick=${continuePending}>${store.pending.continueState === 'posting' ? '正在提交暂存消息…' : store.pending.continueRequested ? '已请求提交，等待原消息确认' : '提交已暂存消息'}</button>`}
        ${store.pending.status === 'unknown' && html`<button type="button" disabled=${store.sending} onClick=${() => receiptRefreshRef.current?.()}>查询原请求</button>`}
        ${store.pending.canStopTracking && html`<button type="button" disabled=${store.sending} onClick=${() => stopTracking('send')}>停止本地跟踪</button>`}
        ${store.pending.retrySafe && html`<button type="button" onClick=${() => {
          const pending = store.pending
          update({ draft: store.draft && store.draft !== pending.text ? store.draft + '\n\n' + pending.text : pending.text,
            files: [...store.files, ...(pending.attachments || []).filter(file => !store.files.some(current => current.path === file.path))], pending: null })
          inputRef.current?.focus()
        }}>移回输入框</button>`}</div>`}
      ${commandPromptSuperseded && html`<section class="chat-command-result" aria-label="原命令回执"><header><strong>原命令回执已保留</strong><code translate="no">${store.pendingCommand.command}</code></header>
        <p>请先处理当前原生问题，之后可查询原命令状态。</p></section>`}
      ${store.pendingCommand && !commandPromptSuperseded && html`<${CommandResult} record=${store.pendingCommand} time=${html`<${MessageTime} timestamp=${store.pendingCommand.submittedAt} local=${true} />`}
        disabled=${readOnly || Boolean(historyError) || commandPosting.current} onRefresh=${() => refreshCommand(true)} onRespond=${respondCommand}
        onTerminal=${openTerminal} openingTerminal=${openingTerminal} onDismiss=${() => update({ pendingCommand: null })} onStopTracking=${() => stopTracking('command')} />`}
      ${(requiresAction || store.promptResponse) && (!store.pendingCommand?.prompt || verifiedPrompt) && html`<${InlinePrompt} key=${prompt?.id || 'unrecognized'} prompt=${prompt} response=${store.promptResponse}
        autoSubmitSingle=${prompt?.type === 'question' && prompt.questionCount >= 1}
        disabled=${readOnly || Boolean(historyError) || store.responding || commandPosting.current} onRespond=${respond} onRefresh=${() => refreshRef.current?.(true)} onAdvanced=${openAdvanced} advancedLoading=${advancedLoading}
        onStopTracking=${() => { if (store.promptResponse?.canStopTracking && !store.responding) update({ promptResponse: { ...store.promptResponse, trackingStopped: true } }) }} />`}
      ${requestIssue && html`<section class=${'chat-pending chat-request-issue ' + requestIssue.state} role=${requestIssue.state === 'failed' ? 'alert' : 'status'} aria-label="请求状态">
        <strong>${issueStatusText}</strong>${requestIssue.timestamp && html`<${MessageTime} timestamp=${requestIssue.timestamp} />`}
        <p>${issueDescription}</p><small>${requestIssue.state === 'retrying' ? '原生会话正在自动重试。' : '本轮回复已中断，已有内容已保留。'}</small>
        ${requestIssue.state === 'retrying' && Number.isInteger(requestIssue.retryAttempt) && requestIssue.retryAttempt >= 0 && html`<small>重试次数：${requestIssue.retryAttempt}${Number.isInteger(requestIssue.maxRetries) && requestIssue.maxRetries > 0 ? ' / ' + requestIssue.maxRetries : ''}</small>`}
        ${requestIssue.state === 'retrying' && Number.isFinite(requestIssue.retryInMs) && requestIssue.retryInMs >= 0 && html`<small>原生重试间隔：约 ${Math.ceil(requestIssue.retryInMs / 1000)} 秒</small>`}
        <div class="chat-request-issue-actions"><button type="button" onClick=${() => refreshRef.current?.()}>刷新状态</button>
          <button type="button" disabled=${openingTerminal} onClick=${openTerminal}>${openingTerminal ? '正在打开…' : '独立终端'}</button>
          ${canFillContinue && html`<button type="button" onClick=${fillContinue}>填写继续</button>`}</div>
        ${canFillContinue && html`<small>仅填写输入框，按 Enter 后发送。</small>`}
      </section>`}
      ${running && html`<div class=${'chat-working ' + (requestIssue?.state === 'failed' ? 'interrupted' : '')} role="status"><span class="chat-working-dot" />${requiresAction ? '正在等待你的操作' : requestIssue ? requestIssue.state === 'retrying' ? '正在等待原生请求重试…' : '回复已中断，请查看上方提示。' : '正在处理…'}</div>`}
      ${store.history.notice && html`<p class="chat-history-notice">${store.history.notice}</p>`}
    </div></div>
    ${showLatest && html`<button type="button" class="chat-latest" onClick=${scrollToLatest}>↓ 最新消息</button>`}
    <footer class="chat-compose-wrap"><div class="chat-compose-width">
      ${stopped && html`<div class=${'chat-session-notice ' + (startFailed ? 'chat-start-failed' : '')} role=${startFailed ? 'alert' : 'status'}>
        <div>${startFailed ? html`<strong>会话启动失败</strong><span>进程启动后提前退出，请重试或打开高级控制检查。</span>
          ${startupError?.reason && html`<small translate="no">${startupError.reason}</small>`}` : html`<span>会话尚未启动，聊天记录已保留。</span>`}</div>
        <div class="chat-start-actions"><button type="button" disabled=${starting || readOnly} onClick=${startSession}>${starting ? '正在启动…' : startFailed ? '重新启动会话' : '启动会话'}</button>
          ${startFailed && html`<button type="button" disabled=${advancedLoading} onClick=${openAdvanced}>打开高级控制</button>`}</div></div>`}
      ${!supported && html`<div class="chat-banner">此工具暂不支持结构化聊天，请使用已有会话操作管理它。</div>`}
      ${(error || notice) && html`<div class=${'chat-feedback ' + (error ? 'error' : '')} role=${error ? 'alert' : 'status'}><span>${error || notice}</span><button type="button" aria-label="关闭提示" onClick=${() => { setError(''); setNotice('') }}>×</button></div>`}
      <${SlashCommandMenu} tool=${session?.tool} draft=${store.draft} commands=${commands} loading=${commandsLoading} error=${commandsError}
        open=${commandMenuOpen} activeIndex=${slashIndex} onActiveIndexChange=${setSlashIndex} onChoose=${chooseCommand} onClose=${() => setSlashOpen(false)} />
      ${commandConfirmation && html`<section class="chat-pending" role="alert" aria-label="执行命令确认">
        <strong translate="no">${commandConfirmation.command}</strong><p>${commandConfirmation.message}</p>
        <button type="button" onClick=${clearCommandConfirmation}>取消</button>
        <button type="button" onClick=${() => {
          if (confirmationRef.current !== commandConfirmation || store.draft.trim() !== commandConfirmation.command) return
          runCommand(commandConfirmation.command, true)
        }}>确认执行</button>
      </section>`}
      <form class=${'chat-composer ' + (readOnly ? 'readonly' : '')} onSubmit=${event => { event.preventDefault(); send() }}>
        ${store.files.length > 0 && html`<div class="chat-files chat-draft-files">${store.files.map(file => html`<${FileCard} key=${file.id} file=${file} reveal=${reveal} remove=${store.sending ? undefined : () => removeFile(file)} />`)}</div>`}
        <textarea ref=${inputRef} value=${store.draft} rows="2" aria-label="消息输入框" disabled=${readOnly}
          class=${suggestion ? 'has-native-suggestion' : ''} aria-describedby=${suggestion ? 'chat-native-suggestion-hint' : undefined}
          aria-controls=${commandMenuOpen && commandChoices.length ? 'chat-slash-command-list' : undefined}
          aria-expanded=${commandMenuOpen} aria-autocomplete="list" aria-activedescendant=${commandMenuOpen && commandChoices.length ? 'chat-slash-command-list-' + Math.min(slashIndex, commandChoices.length - 1) : undefined}
          placeholder=${suggestion ? suggestion.text : readOnly ? '当前会话为只读模式' : stopped ? '先写下你的想法，启动会话后发送…' : '向 ' + (session?.tool === 'claude' ? 'Claude' : 'Codex') + ' 发送消息…'}
          onInput=${event => { clearCommandConfirmation(); update({ draft: event.currentTarget.value }); setSlashOpen(/^\s*\/[^\s/]*$/.test(event.currentTarget.value)); setSlashIndex(0) }}
          onPaste=${event => { if (event.clipboardData?.files?.length) { event.preventDefault(); event.stopPropagation(); addFiles(event.clipboardData.files) } }}
          onKeyDown=${event => {
            event.stopPropagation()
            if (event.isComposing) return
            if (suggestion && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
              if (event.key === 'Tab') { event.preventDefault(); acceptSuggestion(); return }
              if (event.key === 'Escape') { event.preventDefault(); dismissSuggestion(); update(); return }
            }
            if (commandMenuOpen) {
              if (event.key === 'Escape') { event.preventDefault(); setSlashOpen(false); return }
              if (commandChoices.length && ['ArrowDown', 'ArrowUp', 'Tab', 'Enter'].includes(event.key) && !event.shiftKey) {
                event.preventDefault()
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') setSlashIndex((Math.min(slashIndex, commandChoices.length - 1) + (event.key === 'ArrowDown' ? 1 : commandChoices.length - 1)) % commandChoices.length)
                else chooseCommand(commandChoices[Math.min(slashIndex, commandChoices.length - 1)], event.key === 'Tab')
                return
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (canSubmitDraft) send() }
          }} />
        <div class="chat-composer-actions"><button type="button" class="chat-attach" disabled=${readOnly || store.sending} title="添加图片或文件" aria-label="添加图片或文件" onClick=${() => fileRef.current?.click()}>＋</button>
          <input ref=${fileRef} type="file" multiple hidden onChange=${event => { addFiles(event.currentTarget.files); event.currentTarget.value = '' }} />
          <span class="chat-input-hint">${suggestion ? html`<span id="chat-native-suggestion-hint" class="chat-suggestion-hint">${suggestion.source === 'local-context' && html`<span>基于本轮回复</span>`}<button type="button" onClick=${acceptSuggestion} aria-label="接受下一步建议"><kbd>Tab</kbd> 接受建议</button><span>Esc 忽略 · Enter 发送</span></span>` : uploading ? '文件上传中…' : isSlashCommand ? store.files.length ? '命令不支持附件，请移除附件后执行' : 'Enter 执行命令 · / 查看可用命令' : requestIssue ? requestIssue.state === 'retrying' ? '请求正在重试，新消息将加入队列 · Enter 提交' : '回复已中断 · Enter 提交 · / 命令' : running ? '正在处理，新消息将加入队列 · Enter 提交' : 'Enter 发送 · Shift + Enter 换行 · / 命令'}</span>
          ${running && html`<button type="button" class="chat-stop" disabled=${stopping || readOnly || store.history.canInterrupt === false} onClick=${interrupt}><span aria-hidden="true">■</span> ${stopping ? '正在停止…' : '停止生成'}</button>`}
          <button type="submit" class="chat-send" disabled=${!canSubmitDraft} aria-label=${isSlashCommand ? '执行命令' : running ? '加入队列' : '发送消息'} title=${isSlashCommand ? '执行命令' : running ? '加入队列' : '发送消息'}>↑</button>
        </div></form><p class="chat-composer-footnote">支持拖入多个文件、粘贴截图 · 单个文件不超过 100 MB</p>
    </div></footer>
    ${dragging && html`<div class="chat-drop-overlay"><span>＋</span><strong>松开即可添加文件</strong><p>图片、文档或代码，可一次添加多个</p></div>`}
    ${advancedOpen && advancedPanel && html`<div class="chat-advanced-backdrop" role="dialog" aria-modal="true" aria-label="高级会话控制"
      onKeyDown=${event => { event.stopPropagation(); if (event.key === 'Escape' && event.target.closest('.chat-advanced-header')) setAdvancedOpen(false) }}>
      <section class="chat-advanced"><header class="chat-advanced-header"><div><strong>高级控制</strong><span>当前会话的原生交互界面</span></div>
        <button type="button" autoFocus aria-label="关闭高级控制" onClick=${() => setAdvancedOpen(false)}>×</button></header>
        <${advancedPanel} /></section></div>`}
  </section>`
}
