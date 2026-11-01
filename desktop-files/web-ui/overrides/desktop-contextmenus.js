import { menuModelSignal, sidebarRowsSignal } from '/static/app/dataModel.js'
import { desktopFilePath } from '/static/app/terminalLinks.js'
import { addToast } from '/static/app/toasts.js'

const style = document.createElement('style')
style.textContent = `
  .desktop-contextmenu { position: fixed; z-index: 10000; min-width: 196px; padding: 5px;
    border: 1px solid var(--border, #334155); border-radius: 8px;
    color: var(--text, #e2e8f0); background: var(--panel, #161d2c);
    box-shadow: 0 12px 36px #0006; }
  .desktop-contextmenu button { display: block; width: 100%; padding: 9px 12px;
    border: 0; border-radius: 4px; text-align: left; cursor: pointer;
    color: inherit; background: transparent; font: inherit; font-size: 13px; }
  .desktop-contextmenu button:hover, .desktop-contextmenu button:focus-visible {
    background: var(--hover, #26344b); outline: 2px solid var(--accent, #82b7ff); outline-offset: -2px; }
`
document.head.appendChild(style)

let menu = null
let previousFocus = null

function closeMenu(restoreFocus = false) {
  if (!menu) return
  menu.remove()
  menu = null
  if (restoreFocus && previousFocus?.isConnected) previousFocus.focus()
  previousFocus = null
}

async function reveal(payload) {
  const request = new CustomEvent('agentdeck:reveal-message-file', { cancelable: true, detail: payload })
  if (!document.dispatchEvent(request)) return
  try {
    const response = await fetch('/desktop/reveal', {
      method: 'POST',
      credentials: 'same-origin',
      mode: 'same-origin',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-AgentDeck-Desktop': '1' },
      body: JSON.stringify(payload),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || '无法打开文件管理器。')
    addToast('已在文件管理器中打开。', 'success')
  } catch (error) {
    addToast(`无法显示文件位置：${error.message || '请检查文件是否存在。'}`, 'error')
  }
}

function showMenu(label, payload, x, y) {
  closeMenu()
  previousFocus = document.activeElement
  menu = document.createElement('div')
  menu.className = 'desktop-contextmenu'
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', '文件操作')
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.setAttribute('role', 'menuitem')
  button.addEventListener('click', () => {
    closeMenu(true)
    reveal(payload)
  })
  menu.appendChild(button)
  document.body.appendChild(menu)
  const bounds = menu.getBoundingClientRect()
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)) + 'px'
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8)) + 'px'
  button.focus()
}

function knownSession(id) {
  return menuModelSignal.value.sessions.find(session => session.id === id)
}

function messageContext(element) {
  const message = element?.closest?.('[data-message-cwd], [data-message-directories]')
  if (!message) return {}
  const context = {}
  const cwd = message.dataset.messageCwd
  if (cwd && cwd.length <= 4096) context.messageCwd = cwd
  try {
    const directories = JSON.parse(message.dataset.messageDirectories || '[]')
    if (Array.isArray(directories)) context.directoryHints = directories
      .filter(value => typeof value === 'string' && value.length <= 4096).slice(0, 24)
  } catch { /* A malformed optional hint must not suppress the file menu. */ }
  return context
}

function sidebarSession(element) {
  const row = sidebarRowsSignal.value.find(item => item.key === element.dataset.rowKey)
  if (!row) return null
  if (row.type === 'session') return row.session
  // A group may contain several projects. Only reveal it when its actual
  // members (including subgroups) unambiguously share one project directory.
  const members = menuModelSignal.value.sessions.filter(session =>
    session.group === row.path || session.group.startsWith(row.path + '/'))
  if (!members.length || members.some(session => !session.path || session.path !== members[0].path)) return null
  if (row.group.defaultPath && row.group.defaultPath !== members[0].path) return null
  return members[0]
}

document.addEventListener('contextmenu', event => {
  closeMenu()
  const target = event.target instanceof Element ? event.target : event.target?.parentElement
  if (!target) return
  const row = target.closest('.sidebar .sess[data-row-key], .sidebar .side-group-head[data-row-key]')
  if (row) {
    const session = sidebarSession(row)
    if (!session?.id || !session.path) return
    event.preventDefault()
    showMenu('打开项目目录', { sessionId: session.id }, event.clientX, event.clientY)
    return
  }
  const link = target.closest('a[href]')
  const owner = link?.closest('[data-desktop-session-id]')
  const sessionId = owner?.dataset.desktopSessionId
  const path = link && desktopFilePath(link.getAttribute('href'))
  if (!path || !knownSession(sessionId)) return
  event.preventDefault()
  showMenu('在文件管理器中显示', { sessionId, path, ...messageContext(link) }, event.clientX, event.clientY)
}, true)

document.addEventListener('agentdeck:reveal-contextmenu', event => {
  const { sessionId, path, clientX, clientY } = event.detail || {}
  const owner = event.target.closest?.('[data-desktop-session-id]')
  if (owner?.dataset.desktopSessionId !== sessionId || !knownSession(sessionId) || typeof path !== 'string' || !path) return
  event.preventDefault()
  showMenu('在文件管理器中显示', { sessionId, path, ...messageContext(event.target) }, clientX, clientY)
})

document.addEventListener('pointerdown', event => {
  if (menu && !menu.contains(event.target)) closeMenu()
}, true)
document.addEventListener('keydown', event => {
  if (!menu) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeMenu(true)
  } else if (event.key === 'Tab') {
    closeMenu(true)
  } else {
    // Do not let the app's single-letter session shortcuts consume menu keys.
    event.stopPropagation()
  }
}, true)
document.addEventListener('scroll', () => closeMenu(), true)
window.addEventListener('resize', () => closeMenu())
window.addEventListener('blur', () => closeMenu())
