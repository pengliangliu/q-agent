// CreateSessionDialog.js -- Modal form for creating a new session.
// Restyled (PR-B) to use the bundle's `.dialog` / `.dh` / `.db` / `.df` /
// `.field` / `.seg-row` / `.btn` classes from app.css.
import { html } from 'htm/preact'
import { useState } from 'preact/hooks'
import {
  createSessionDialogSignal, mutationsEnabledSignal, selectSession,
  toolFilterFallbackSignal, pickerToolsSignal, modelCatalogSignal,
} from './state.js'
import { activeTabSignal } from './uiState.js'
import { Icon, ICONS } from './icons.js'
import { apiFetch } from './api.js'
import { PathInput } from './PathInput.js'
import { DirectoryCreationOption } from './DirectoryCreationOption.js'
import { displayLabelForTool, resolveCreateSessionPickerTools } from './pickerTools.js'
import {
  CUSTOM_MODEL, effortOptionsForTool, modelOptionsForTool, seedModelSelection,
} from './modelCatalog.js'

export function CreateSessionDialog() {
  const open = createSessionDialogSignal.value
  const ctx = open || { groupPath: '', groupName: '', defaultPath: '', tool: '', modelId: '' }

  const [title, setTitle] = useState('')
  const [tool, setTool] = useState('claude')
  const [modelId, setModelId] = useState('')
  const [customModel, setCustomModel] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState('')
  const [path, setPath] = useState('')
  const [directoryCreation, setDirectoryCreation] = useState(null)
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [seededFor, setSeededFor] = useState(null)

  // Tools actually offered by the picker (operator-filtered via hidden_tools /
  // show_only_installed_tools). Computed before the seeding effect below so
  // the seed can be checked against it — see next comment.
  const shownTools = resolveCreateSessionPickerTools(pickerToolsSignal.value)

  // Re-seed when the dialog opens for a different group. Keyed on groupPath so
  // SSE-driven re-renders never stomp edits the user is in the middle of, and
  // reopening on another group does not inherit the previous group's values.
  if (open && seededFor !== ctx.groupPath) {
    // Only seed a tool the picker actually shows: an operator-hidden tool
    // (e.g. `claude` filtered via hidden_tools) must never seed a selection
    // no button reflects, which used to submit an invisible/wrong tool on
    // create (review finding #2). Fall back to the first shown tool.
    const seedTool = shownTools.includes(ctx.tool) ? ctx.tool : shownTools[0]
    setTool(seedTool)
    setPath(ctx.defaultPath || '')
    setDirectoryCreation(null)
    // A known id selects its option; an unknown one (newer than this build's
    // list) is carried as a custom id instead of silently dropped (#2388).
    const seeded = seedModelSelection(seedTool, ctx.modelId, modelCatalogSignal.value)
    setModelId(seeded.modelId)
    setCustomModel(seeded.customModel)
    setReasoningEffort('')
    setTitle('')
    setError(null)
    setSeededFor(ctx.groupPath)
  }

  // WEB-P0-4 prevention layer: when mutations are disabled (server
  // webMutations=false), do not render the dialog at all. Hooks order is
  // preserved by placing this guard AFTER all useState calls.
  if (!mutationsEnabledSignal.value) return null

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const payload = { title, tool, projectPath: path }
      if (directoryCreation?.inputPath === path) {
        payload.createDir = true
        payload.createDirPaths = directoryCreation.missing
      }
      if (ctx.groupPath) payload.groupPath = ctx.groupPath
      const modelId = selectedModelId()
      if (modelId) payload.modelId = modelId
      if (effectiveEffort) payload.reasoningEffort = effectiveEffort
      const { sessionId } = await apiFetch('POST', '/api/sessions', payload)
      selectSession(sessionId)
      activeTabSignal.value = 'terminal'
      createSessionDialogSignal.value = null
    } catch (err) {
      setDirectoryCreation(null)
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  // Tool buttons defer focus until click: an earlier PathInput blur collapses
  // its suggestions and moves the pressed button before pointerup arrives.
  function selectTool(nextTool) {
    setTool(nextTool)
    setModelId('')
    setCustomModel('')
    setReasoningEffort('')
  }

  function selectedModelId() {
    if (modelId === CUSTOM_MODEL) return customModel.trim()
    return modelId || ''
  }

  const close = () => (createSessionDialogSignal.value = null)
  const handleBackdropClick = (e) => { if (e.target === e.currentTarget) close() }
  const modelIDs = modelOptionsForTool(tool, modelCatalogSignal.value)
  const reasoningEfforts = effortOptionsForTool(tool, selectedModelId(), modelCatalogSignal.value)
  // The options change with the model (select or custom id) and with the
  // settings hydration; an effort they no longer offer is never submitted.
  const effectiveEffort = reasoningEfforts.some(e => e.value === reasoningEffort) ? reasoningEffort : ''
  const needsCustomModel = modelId === CUSTOM_MODEL
  const submitDisabled = submitting || !title || !path || (needsCustomModel && !customModel.trim())

  return html`
    <div class="overlay path-dialog-overlay" onClick=${handleBackdropClick}>
      <form class="dialog path-dialog" onClick=${e => e.stopPropagation()} onSubmit=${handleSubmit}>
        <div class="dh">
          <span class="kicker">新建</span>
          <div class="t">新建会话</div>
          <button type="button" class="icon-btn" onClick=${close} aria-label="关闭">
            <${Icon} d=${ICONS.x}/>
          </button>
        </div>
        <div class="db">
          ${ctx.groupName && html`
            <div class="field">
              <label>所属项目 / 分组</label>
              <div class="ro-value" data-testid="create-session-group">${ctx.groupName}</div>
            </div>
          `}
          <div class="field">
            <label>会话名称</label>
            <input autofocus required value=${title} onInput=${e => setTitle(e.target.value)} placeholder="会话名称"/>
          </div>
          <div class="field">
            <label for="create-session-path">工作目录</label>
            <${PathInput} value=${path} onInput=${e => { setPath(e.target.value); setDirectoryCreation(null) }}/>
            <${DirectoryCreationOption} key=${ctx.groupPath} path=${path} refresh=${error} onChange=${setDirectoryCreation}/>
          </div>
          <div class="field">
            <label>工具</label>
            <div class="seg-row">
              ${shownTools.map(t => html`
                <button type="button" key=${t} data-tool=${t} aria-pressed=${tool === t}
                        class=${`seg-btn ${tool === t ? 'on' : ''}`}
                        onPointerDown=${e => e.preventDefault()}
                        onClick=${e => { selectTool(t); e.currentTarget.focus() }}>${t === 'codex' ? 'Codex' : t === 'claude' ? 'Claude' : displayLabelForTool(t)}</button>
              `)}
            </div>
            ${toolFilterFallbackSignal.value && html`
              <div style="font-family: var(--mono); font-size: 11px; color: var(--tn-comment, #888);
                          margin-top: 6px;">
                No tools matched PATH; showing all. Set <code>show_only_installed_tools = false</code> to silence.
              </div>
            `}
          </div>
          ${modelIDs.length > 0 && html`
            <div class="field">
              <label>模型 ID</label>
              <select value=${modelId} onInput=${e => setModelId(e.target.value)}>
                <option value="">工具默认值</option>
                ${modelIDs.map(m => html`
                  <option key=${m.value} value=${m.value}>${m.value} — ${m.label}</option>
                `)}
                <option value=${CUSTOM_MODEL}>自定义模型 ID…</option>
              </select>
            </div>
            ${needsCustomModel && html`
              <div class="field">
                <label>模型 ID</label>
                <input required value=${customModel} onInput=${e => setCustomModel(e.target.value)} placeholder="provider/model-or-version"/>
              </div>
            `}
          `}
          ${reasoningEfforts.length > 0 && html`
            <div class="field">
              <label>推理强度</label>
              <select value=${effectiveEffort} onInput=${e => setReasoningEffort(e.target.value)}>
                <option value="">工具默认值</option>
                ${reasoningEfforts.map(effort => html`
                  <option key=${effort.value} value=${effort.value}>${effort.label} — ${effort.value}</option>
                `)}
              </select>
            </div>
          `}
          ${error && html`
            <div style="font-family: var(--mono); font-size: 11.5px; color: var(--tn-red); padding: 8px 10px;
                        border: 1px solid rgba(247,118,142,0.3); border-radius: 4px; background: rgba(247,118,142,0.06);">
              ${error}
            </div>
          `}
        </div>
        <div class="df">
          <button type="button" class="btn ghost" onClick=${close}>取消</button>
          <button type="submit" class="btn primary" disabled=${submitDisabled}>
            ${submitting ? '创建中…' : html`创建会话 <span class="kbd">⏎</span>`}
          </button>
        </div>
      </form>
    </div>
  `
}
