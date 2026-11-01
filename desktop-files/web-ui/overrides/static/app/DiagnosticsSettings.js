import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { connectionSignal, wsStateSignal } from './state.js'
import { menuModelSignal } from './dataModel.js'
import { authHeaders } from './api.js'
import { languageSignal, themeSignal, completionEnabledSignal } from './desktopPreferences.js'
import { mutationCountSignal } from './uiOperations.js'

const version = value => /^ui-[a-f0-9]{12}$/.test(value || '') ? value : null
const connection = value => ['connected', 'connecting', 'disconnected', 'error', 'closed'].includes(value) ? value : 'unknown'

function localCounts() {
  const result = { drafts: 0, attachments: 0, pendingSends: 0, pendingCommands: 0, pendingPrompts: 0, pendingModels: 0 }
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (!key?.startsWith('agentdeck.chat.') && !key?.startsWith('agentdeck.model.')) continue
      let value; try { value = JSON.parse(localStorage.getItem(key) || 'null') } catch (_) { continue }
      if (!value || typeof value !== 'object') continue
      if (key.startsWith('agentdeck.model.')) { result.pendingModels++; continue }
      if (typeof value.draft === 'string' && value.draft.trim()) result.drafts++
      result.attachments += Array.isArray(value.files) ? value.files.length : 0
      if (value.pending) result.pendingSends++
      if (value.pendingCommand && !['done', 'failed'].includes(value.pendingCommand.state)) result.pendingCommands++
      if (value.promptResponse) result.pendingPrompts++
    }
  } catch (_) {}
  return result
}

export function diagnosticReport(data) {
  return { format: 'agentdeck-diagnostics-v1',
    applicationVersion: /^[0-9]+(?:\.[0-9]+)+(?:[-+][A-Za-z0-9.-]+)?$/.test(data?.applicationVersion || '') ? data.applicationVersion : null,
    loadedInterfaceVersion: version(window.__agentDeckInterfaceVersion), deployedInterfaceVersion: version(data?.interfaceVersion),
    host: window.__agentDeckDesktop?.host === 'agentdeck-winforms' ? 'windows-client' : 'browser',
    bridge: data?.bridge?.status === 'connected' ? 'connected' : 'unavailable',
    environment: ['wsl', 'linux', 'win32', 'darwin'].includes(data?.bridge?.environment) ? data.bridge.environment : 'unknown',
    backend: data?.backend?.status === 'connected' ? 'connected' : 'unavailable',
    backendError: /^(?:timeout|connection-failed|http-[0-9]{3})$/.test(data?.backend?.errorCode || '') ? data.backend.errorCode : null,
    sessionSync: connection(connectionSignal.value), chatSync: connection(wsStateSignal.value),
    sessionCount: menuModelSignal.value.sessions?.length || 0,
    language: languageSignal.value, theme: themeSignal.value, completionAlerts: completionEnabledSignal.value,
    inFlightMutations: mutationCountSignal.value, ...localCounts() }
}

export function DiagnosticsSettings() {
  const en = languageSignal.value === 'en'
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [notice, setNotice] = useState('')
  const controller = useRef(null)
  const busy = useRef(false)
  const loadedVersion = version(window.__agentDeckInterfaceVersion)
  const deployedVersion = version(data?.interfaceVersion)
  const blocked = mutationCountSignal.value > 0
  const status = value => value === 'connected' ? en ? 'Connected' : '已连接' : value === 'connecting' ? en ? 'Connecting' : '连接中' : en ? 'Unavailable' : '未连接'
  const check = async () => {
    if (busy.current) return
    busy.current = true; setLoading(true); setNotice(''); setError(false)
    const abort = new AbortController(); controller.current = abort
    const timeout = setTimeout(() => abort.abort(), 8000)
    try {
      const response = await fetch('/desktop/diagnostics?refresh=1', { headers: authHeaders({ 'X-AgentDeck-Desktop': '1' }), signal: abort.signal })
      const result = await response.json()
      if (!response.ok || !version(result.interfaceVersion)) throw new Error('unavailable')
      if (controller.current === abort) setData(result)
    } catch (_) { if (controller.current === abort) { setData(null); setError(true) } }
    finally { clearTimeout(timeout); if (controller.current === abort) { setLoading(false); busy.current = false } }
  }
  useEffect(() => {
    check()
    return () => { const abort = controller.current; controller.current = null; abort?.abort() }
  }, [])
  async function copy() {
    try { await navigator.clipboard.writeText(JSON.stringify(diagnosticReport(data), null, 2)); setNotice('copied') }
    catch (_) { setNotice('copy-failed') }
  }
  function reload() {
    if (mutationCountSignal.value > 0) return
    const ready = new Event('agentdeck:before-ui-reload', { cancelable: true })
    window.dispatchEvent(ready)
    if (ready.defaultPrevented) { setNotice('save-failed'); return }
    location.reload()
  }
  return html`<section class="desktop-diagnostics" aria-label=${en ? 'Status and interface updates' : '状态与界面更新'}>
    <h3>${en ? 'Status and interface updates' : '状态与界面更新'}</h3>
    <dl>
      <div><dt>${en ? 'Backend: Agent Deck' : '后端：Agent Deck'}</dt><dd>${data?.applicationVersion ? 'v' + data.applicationVersion : en ? 'Unknown version' : '版本未读取'}</dd></div>
      <div><dt>${en ? 'Loaded interface' : '当前界面'}</dt><dd>${loadedVersion || (en ? 'Reload to identify' : '重新加载后识别')}</dd></div>
      <div><dt>${en ? 'WSL bridge / Agent Deck' : 'WSL 桥接 / Agent Deck'}</dt><dd>${status(data?.bridge?.status)} / ${status(data?.backend?.status)}</dd></div>
      <div><dt>${en ? 'Session / chat sync' : '会话列表 / 聊天同步'}</dt><dd>${status(connectionSignal.value)} / ${status(wsStateSignal.value)}</dd></div>
    </dl>
    <p role="status">${loading ? en ? 'Checking local interface…' : '正在检查本机界面…' : error ? en ? 'Connection check failed. Try again.' : '连接检查失败，可重新检查。' :
      loadedVersion && deployedVersion ? loadedVersion === deployedVersion ? en ? 'The latest installed interface is loaded.' : '当前为本机已安装的最新界面。' :
        en ? 'An updated interface is installed. Reload to use it.' : '已有新的界面文件，重新加载后生效。' : en ? 'Reload to read the interface version.' : '重新加载后可读取界面版本。'}</p>
    <div class="desktop-diagnostics-actions">
      <button type="button" disabled=${loading} onClick=${check}>${en ? 'Check interface updates' : '检查界面更新'}</button>
      <button type="button" disabled=${blocked} onClick=${reload}>${en ? 'Reload interface' : '重新加载界面'}</button>
      <button type="button" onClick=${copy}>${en ? 'Copy diagnostics' : '复制诊断信息'}</button>
    </div>
    <small>${blocked ? en ? 'A request is being submitted. Reload after it finishes.' : '当前操作正在提交，请完成后再重新加载。' :
      en ? 'Drafts and pending receipts are kept. Checks use local installed files.' : '保留草稿和待确认记录，仅检查本机已安装的界面文件。'}</small>
    ${notice && html`<p role="status">${notice === 'copied' ? en ? 'Diagnostics copied without conversation text, paths or credentials.' : '已复制诊断信息，不含对话正文、路径或凭据。' : notice === 'copy-failed' ? en ? 'Copy failed. Try again.' : '复制失败，请重试。' : en ? 'Draft saving is incomplete. Reload was cancelled.' : '草稿暂存未完成，已取消重新加载。'}</p>`}
  </section>`
}
