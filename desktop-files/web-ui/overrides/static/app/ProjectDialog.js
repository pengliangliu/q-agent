import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { signal } from '@preact/signals'
import { authHeaders } from './api.js'
import { PathInput } from './PathInput.js'
import { DirectoryCreationOption } from './DirectoryCreationOption.js'
import { createSessionDialogSignal, mutationsEnabledSignal, pickerToolsSignal, selectGroup } from './state.js'
import { currentGroupPath, menuModelSignal, openCreateSessionForGroup } from './dataModel.js'
import { addToast } from './toasts.js'

export const projectDialogSignal = signal(null)

export function openProjectDialog(context = {}) {
  if (mutationsEnabledSignal.value) projectDialogSignal.value = { parentPath: context.parentPath || '' }
}

export function openProjectSession(project) {
  if (!mutationsEnabledSignal.value) return
  openCreateSessionForGroup(project?.groupPath || currentGroupPath())
  const context = createSessionDialogSignal.value
  const tools = pickerToolsSignal.value || []
  createSessionDialogSignal.value = {
    ...context,
    ...(project ? { groupPath: project.groupPath, groupName: project.name, defaultPath: project.path } : {}),
    tool: context.tool || (tools.includes('claude') ? 'claude' : tools.includes('codex') ? 'codex' : ''),
  }
}

async function projectRequest(action, body = {}) {
  const response = await fetch('/desktop/projects/' + action, {
    method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
    headers: authHeaders({ 'X-AgentDeck-Desktop': '1' }),
    body: JSON.stringify(body),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error?.message || result.error || '项目操作未完成。')
  return result
}

export function ProjectDialog() {
  const open = projectDialogSignal.value
  if (!open || !mutationsEnabledSignal.value) return null
  return html`<${ProjectForm} key=${open.parentPath || ''} initialParentPath=${open.parentPath || ''}/>`
}

function ProjectForm({ initialParentPath }) {
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [parentPath, setParentPath] = useState(initialParentPath)
  const [directoryCreation, setDirectoryCreation] = useState(null)
  const [startSession, setStartSession] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const form = useRef(null)
  const groups = (menuModelSignal.value.groups || []).filter(group => group.path)
  const parentAvailable = !parentPath || groups.some(group => group.path === parentPath)
  const projectKind = parentPath ? '子项目' : '项目'

  useEffect(() => {
    const previous = document.activeElement
    form.current?.querySelector('input')?.focus()
    return () => { if (!createSessionDialogSignal.value && previous?.isConnected) previous.focus() }
  }, [])

  function close() {
    if (!busy) projectDialogSignal.value = null
  }

  function handleKeys(event) {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); close() }
    if (event.key !== 'Tab') return
    const items = [...form.current.querySelectorAll('input:not(:disabled), button:not(:disabled), select:not(:disabled), [tabindex="0"]')]
    const first = items[0], last = items.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }

  async function pickDirectory() {
    setBusy('pick')
    setError('')
    try {
      const result = await projectRequest('pick-directory')
      if (result.path) { setPath(result.path); setDirectoryCreation(null) }
    } catch (err) {
      setError(err.message || '未能打开文件夹选择器。')
    } finally {
      setBusy('')
    }
  }

  async function submit(event) {
    event.preventDefault()
    if (busy || !name.trim() || !path.trim() || !parentAvailable) return
    setBusy('create')
    setError('')
    try {
      const createDirectory = directoryCreation?.inputPath === path
      const project = await projectRequest('create', {
        name: name.trim(), path, parentPath,
        createDirectory,
        ...(createDirectory ? { createDirectoryPaths: directoryCreation.missing } : {}),
      })
      projectDialogSignal.value = null
      selectGroup(project.groupPath)
      addToast(`${projectKind}“${name.trim()}”已创建${parentPath ? `于“${parentPath}”下` : ''}。`, 'success')
      if (startSession) openProjectSession({ ...project, name: name.trim() })
    } catch (err) {
      setDirectoryCreation(null)
      setError(err.message || '未能创建项目。')
    } finally {
      setBusy('')
    }
  }

  return html`
    <div class="overlay path-dialog-overlay desktop-project-overlay" onKeyDown=${handleKeys}
         onClick=${event => event.target === event.currentTarget && close()}>
      <form ref=${form} class="dialog path-dialog desktop-project-dialog" onSubmit=${submit}
            role="dialog" aria-modal="true" aria-labelledby="desktop-project-title" data-testid="desktop-project-dialog">
        <div class="dh">
          <div class="t" id="desktop-project-title">新建${projectKind}</div>
          <button type="button" class="icon-btn" onClick=${close} disabled=${!!busy} aria-label="关闭">×</button>
        </div>
        <div class="db">
          <p class="desktop-project-intro">${parentPath ? `将在“${parentPath}”下创建子项目。` : ''}为项目选择工作目录，新会话会默认使用这个位置。</p>
          <div class="field">
            <label for="desktop-project-parent">父项目</label>
            <select id="desktop-project-parent" value=${parentPath} disabled=${!!busy}
                    onChange=${event => setParentPath(event.target.value)}>
              <option value="">顶级项目（无父项目）</option>
              ${groups.map(group => html`<option key=${group.path} value=${group.path}>${group.name && group.name !== group.path ? group.name + ' · ' + group.path : group.path}</option>`)}
              ${!parentAvailable && html`<option value=${parentPath} disabled>${parentPath}（已不可用）</option>`}
            </select>
            ${!parentAvailable && html`<p class="desktop-project-error" role="alert">父项目已不可用，请重新选择。</p>`}
          </div>
          <div class="field">
            <label for="desktop-project-name">项目名称</label>
            <input id="desktop-project-name" required value=${name} disabled=${!!busy}
                   placeholder="例如：示例项目" onInput=${event => setName(event.target.value)}/>
          </div>
          <div class="field">
            <label for="create-session-path">项目目录</label>
            <div class="desktop-project-path">
              <fieldset disabled=${!!busy}>
                <${PathInput} value=${path} onInput=${event => { setPath(event.target.value); setDirectoryCreation(null) }}/>
              </fieldset>
              <button type="button" class="btn" disabled=${!!busy} onClick=${pickDirectory} data-testid="desktop-project-pick">
                ${busy === 'pick' ? '选择中…' : '选择文件夹'}
              </button>
            </div>
            <p class="desktop-project-hint">可选择 Windows 文件夹，也可填写 WSL 路径，如 /home/user/projects/my-project。</p>
            <${DirectoryCreationOption} path=${path} refresh=${error} onChange=${setDirectoryCreation}/>
          </div>
          <label class="desktop-project-next">
            <input type="checkbox" checked=${startSession} disabled=${!!busy} onChange=${event => setStartSession(event.target.checked)}/>
            创建后新建会话
          </label>
          ${error && html`<p class="desktop-project-error" role="alert">${error}</p>`}
        </div>
        <div class="df">
          <button type="button" class="btn ghost" disabled=${!!busy} onClick=${close}>取消</button>
          <button type="submit" class="btn primary" disabled=${!!busy || !name.trim() || !path.trim() || !parentAvailable} data-testid="desktop-project-submit">
            ${busy === 'create' ? '创建中…' : '创建' + projectKind + (startSession ? '并继续' : '')}
          </button>
        </div>
      </form>
    </div>
  `
}
