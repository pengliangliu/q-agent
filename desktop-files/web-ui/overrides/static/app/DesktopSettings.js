import { html } from 'htm/preact'
import { useEffect, useRef } from 'preact/hooks'
import { effect, signal } from '@preact/signals'
import { tweaksOpenSignal } from './uiState.js'
import { languageSignal, themeSignal, completionEnabledSignal, setLanguage, setTheme, setCompletionEnabled } from './desktopPreferences.js'
import { DiagnosticsSettings } from './DiagnosticsSettings.js'
import { AccountSettings } from './AccountSettings.js'

export const desktopSettingsOpenSignal = signal(false)

const stylesheet = new URL('./desktopSettings.css', import.meta.url).href
if (![...document.querySelectorAll('link[rel="stylesheet"]')].some(link => link.href === stylesheet)) {
  const link = document.createElement('link')
  link.rel = 'stylesheet'; link.href = stylesheet
  document.head.append(link)
}

// Use the existing document theme hooks and startup storage key.
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
function applyTheme() {
  const selected = themeSignal.value
  const resolved = selected === 'system' ? systemTheme.matches ? 'dark' : 'light' : selected
  const root = document.documentElement
  root.dataset.theme = resolved
  root.classList.toggle('dark', resolved === 'dark')
  root.classList.toggle('light', resolved === 'light')
  root.style.colorScheme = resolved
  try {
    if (selected === 'system') localStorage.removeItem('theme')
    else localStorage.setItem('theme', selected)
  } catch (_) {}
}
effect(applyTheme)
systemTheme.addEventListener('change', () => { if (themeSignal.value === 'system') applyTheme() })

export function DesktopSettings() {
  const open = desktopSettingsOpenSignal.value
  const en = languageSignal.value === 'en'
  const panel = useRef(null)
  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement
    panel.current?.querySelector('[name="uiLanguage"]')?.focus()
    return () => { if (previousFocus?.isConnected) previousFocus.focus() }
  }, [open])
  if (!open) return null
  const close = () => { desktopSettingsOpenSignal.value = false }
  const handleKey = event => {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); close(); return }
    if (event.key !== 'Tab') return
    const controls = [...panel.current.querySelectorAll('button:not(:disabled), select:not(:disabled), input:not(:disabled), [tabindex="0"]')]
      .filter(element => element.getClientRects().length)
    const first = controls[0], last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  return html`<div class="desktop-settings-backdrop" onClick=${event => { if (event.target === event.currentTarget) close() }}
    onKeyDown=${handleKey} onKeyUp=${event => event.stopPropagation()} onKeyPress=${event => event.stopPropagation()}>
    <section class="desktop-settings-panel" role="dialog" aria-modal="true" aria-labelledby="desktop-settings-title" ref=${panel} translate="no">
      <header><div><h2 id="desktop-settings-title">${en ? 'Settings' : '设置'}</h2><p>${en ? 'Your preferences are saved on this device.' : '偏好设置自动保存在当前设备。'}</p></div>
        <button type="button" class="desktop-settings-close" aria-label=${en ? 'Close settings' : '关闭设置'} onClick=${close}>×</button></header>
      <div class="desktop-settings-body">
        <label class="desktop-settings-row"><span><strong>${en ? 'Interface language' : '界面语言'}</strong>
          <small>${en ? 'Applies to interface labels.' : '切换界面按钮、菜单和提示的语言。'}</small></span>
          <select name="uiLanguage" aria-label=${en ? 'Interface language' : '界面语言'} value=${languageSignal.value} onChange=${event => setLanguage(event.currentTarget.value)}>
            <option value="zh-CN">简体中文</option><option value="en">English</option></select></label>
        <label class="desktop-settings-row"><span><strong>${en ? 'Appearance' : '外观主题'}</strong>
          <small>${en ? 'Choose a theme or follow your system.' : '选择主题，或跟随系统外观。'}</small></span>
          <select name="uiTheme" aria-label=${en ? 'Appearance' : '外观主题'} value=${themeSignal.value} onChange=${event => setTheme(event.currentTarget.value)}>
            <option value="system">${en ? 'System' : '跟随系统'}</option><option value="dark">${en ? 'Dark' : '深色'}</option><option value="light">${en ? 'Light' : '浅色'}</option></select></label>
        <label class="desktop-settings-row"><span><strong>${en ? 'Reply completion alerts' : '回复完成提示'}</strong>
          <small>${en ? 'Show in-app alerts and unread reply markers.' : '在应用内显示完成提示和未读标记。'}</small></span>
          <input class="desktop-settings-switch" type="checkbox" role="switch" aria-label=${en ? 'Reply completion alerts' : '回复完成提示'}
            checked=${completionEnabledSignal.value} onChange=${event => setCompletionEnabled(event.currentTarget.checked)} /></label>
        <${AccountSettings} en=${en}/>
        <${DiagnosticsSettings}/>
      </div>
      <footer><button type="button" onClick=${() => { close(); tweaksOpenSignal.value = true
        requestAnimationFrame(() => document.querySelector('[data-testid="tweaks-close"]')?.focus())
      }}>${en ? 'Advanced interface settings' : '高级界面设置'}</button>
        <span role="status">${en ? 'Changes apply immediately' : '更改立即生效'}</span></footer>
    </section>
  </div>`
}
