import { railSignal } from './uiState.js'

if (!document.querySelector('link[data-codex-theme]')) {
  const style = document.createElement('link')
  style.rel = 'stylesheet'
  style.href = '/static/app/codex-theme.css'
  style.dataset.codexTheme = 'true'
  document.head.appendChild(style)
}

// The details panel remains available from its existing toolbar control.
const key = 'agentdeck.codex-layout-v1'
try {
  if (!localStorage.getItem(key)) {
    railSignal.value = 'hidden'
    localStorage.setItem(key, '1')
  }
} catch (_) { /* Retain the current layout if browser storage is unavailable. */ }
