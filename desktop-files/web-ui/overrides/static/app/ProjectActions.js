import { html } from 'htm/preact'
import { apiFetch } from './api.js'
import { menuModelSignal } from './dataModel.js'
import {
  confirmDialogSignal, editSessionDialogSignal, mutationsEnabledSignal, selectedIdSignal, selectSession,
} from './state.js'
import { openProjectDialog, openProjectSession } from './ProjectDialog.js'
export { openProjectSession } from './ProjectDialog.js'

export function editProjectSession(sessionId) {
  if (!mutationsEnabledSignal.value || !menuModelSignal.value.sessions.some(s => s.id === sessionId)) return
  editSessionDialogSignal.value = { sessionId }
}

export function archiveProjectSession(sessionId) {
  if (!mutationsEnabledSignal.value) return
  const session = menuModelSignal.value.sessions.find(s => s.id === sessionId)
  if (!session) return
  confirmDialogSignal.value = {
    title: '归档会话？',
    message: `归档“${session.title}”会停止当前进程。之后可在“已归档”中恢复会话。`,
    tone: 'warn',
    confirmLabel: '归档',
    onConfirm: () => apiFetch('POST', `/api/sessions/${encodeURIComponent(sessionId)}/archive`).then(() => {
      if (selectedIdSignal.value === sessionId) {
        selectSession(null)
        if (window.location.pathname.startsWith('/s/')) history.replaceState(null, '', '/')
      }
    }).catch(() => {}),
  }
}

export function ProjectActions() {
  if (!mutationsEnabledSignal.value) return null
  return html`
    <div class="desktop-project-actions" aria-label="项目和会话">
      <button class="btn" type="button" data-testid="desktop-new-project" onClick=${() => openProjectDialog()}>
        新建项目
      </button>
      <button class="btn primary" type="button" data-testid="desktop-new-session" onClick=${() => openProjectSession()}>
        新建会话
      </button>
    </div>
  `
}
