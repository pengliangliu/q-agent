import { signal, batch } from '@preact/signals'

const key = 'agentdeck.desktop.preferences'
const languages = ['zh-CN', 'en']
const themes = ['system', 'dark', 'light']
const validAccount = value => typeof value === 'string' && value.length <= 128 && !/[\x00-\x1f]/.test(value)
function inheritedTheme() {
  try {
    const stored = localStorage.getItem('theme')
    if (themes.includes(stored)) return stored
    if (themes.includes(JSON.parse(stored))) return JSON.parse(stored)
  } catch (_) {}
  const root = document.documentElement
  return themes.includes(root.dataset.theme) ? root.dataset.theme : root.classList.contains('light') ? 'light' : 'dark'
}
const defaults = { language: 'zh-CN', theme: inheritedTheme(), completionNotifications: true }
function read() {
  let value
  try { value = JSON.parse(localStorage.getItem(key) || '{}') } catch (_) {}
  return { language: languages.includes(value?.language) ? value.language : defaults.language,
    theme: themes.includes(value?.theme) ? value.theme : defaults.theme,
    completionNotifications: typeof value?.completionNotifications === 'boolean' ? value.completionNotifications : true,
    defaultAccounts: Object.fromEntries(['claude','codex'].map(tool => [tool,validAccount(value?.defaultAccounts?.[tool]) ? value.defaultAccounts[tool] : ''])) }
}
const initial = read()
export const languageSignal = signal(initial.language)
export const themeSignal = signal(initial.theme)
export const completionEnabledSignal = signal(initial.completionNotifications)
export const defaultAccountsSignal = signal(initial.defaultAccounts)
function save(patch) {
  const value = { language: languageSignal.value, theme: themeSignal.value,
    completionNotifications: completionEnabledSignal.value, defaultAccounts:defaultAccountsSignal.value, ...patch }
  try { localStorage.setItem(key, JSON.stringify(value)) } catch (_) {}
  batch(() => {
    languageSignal.value = value.language
    themeSignal.value = value.theme
    completionEnabledSignal.value = value.completionNotifications
    defaultAccountsSignal.value = value.defaultAccounts
  })
}
export function setLanguage(value) { if (languages.includes(value)) save({ language: value }) }
export function setTheme(value) { if (themes.includes(value)) save({ theme: value }) }
export function setCompletionEnabled(value) { if (typeof value === 'boolean') save({ completionNotifications: value }) }
export function setDefaultAccount(tool,value) {
  if (['claude','codex'].includes(tool) && validAccount(value)) save({defaultAccounts:{...defaultAccountsSignal.value,[tool]:value}})
}
window.addEventListener('storage', event => {
  if (event.key !== key && event.key !== null) return
  const value = read()
  batch(() => {
    languageSignal.value = value.language
    themeSignal.value = value.theme
    completionEnabledSignal.value = value.completionNotifications
    defaultAccountsSignal.value = value.defaultAccounts
  })
})
