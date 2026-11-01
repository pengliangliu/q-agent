import { html } from 'htm/preact'
import { useEffect, useRef } from 'preact/hooks'

if (!document.querySelector('link[href="/static/app/slashCommands.css"]')) {
  const style = document.createElement('link')
  style.rel = 'stylesheet'
  style.href = '/static/app/slashCommands.css'
  document.head.appendChild(style)
}

// The server supplies the current tool's verified command catalog. Completion
// stops at the first argument so a command's options remain ordinary editing.
export function filterSlashCommands(commands = [], draft = '', tool) {
  const match = /^\s*\/([^\s/]*)$/.exec(draft)
  if (!match) return []
  const query = match[1].toLocaleLowerCase()
  return commands
    .filter(command => command.name?.startsWith('/') && (!command.tool || !tool || command.tool === tool))
    .map(command => {
      const name = command.name.slice(1).toLocaleLowerCase()
      const description = (command.description || '').toLocaleLowerCase()
      const rank = name.startsWith(query) ? 0 : name.includes(query) ? 1 : description.includes(query) ? 2 : 3
      return { command, rank }
    })
    .filter(item => item.rank < 3)
    .sort((a, b) => a.rank - b.rank)
    .map(item => item.command)
}

export function slashInsertText(command) {
  return command.insertText || command.name + ' '
}

function commandHint(command) {
  if (command.action === 'model' || command.action === 'effort') return '打开设置'
  if (command.interaction === 'menu' || command.interaction === 'dialog') return '原生菜单 · 继续选择'
  if (command.kind === 'skill') return '技能'
  if (command.kind === 'mcp') return 'MCP'
  return '原生命令'
}

export function SlashCommandMenu({ tool, draft, commands = [], loading = false, error = '', open = false,
  activeIndex = 0, onActiveIndexChange, onChoose, onClose, id = 'chat-slash-command-list' }) {
  const listRef = useRef(null)
  const matches = filterSlashCommands(commands, draft, tool)
  const selected = Math.max(0, Math.min(activeIndex, matches.length - 1))
  useEffect(() => {
    if (open) listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, selected, draft])
  if (!open) return null
  const toolName = tool === 'codex' ? 'Codex' : tool === 'claude' ? 'Claude' : tool
  return html`<section class="chat-slash-menu" aria-label=${`${toolName || ''} 命令`} data-testid="slash-command-menu">
    <div class="chat-slash-header"><strong>${toolName || '当前会话'} 命令</strong>
      <button type="button" aria-label="关闭命令菜单" title="关闭命令菜单" onClick=${onClose}>×</button>
    </div>
    ${loading && html`<p class="chat-slash-empty" role="status">正在读取可用命令…</p>`}
    ${error && html`<p class="chat-slash-empty" role="status">${error}</p>`}
    ${!loading && !error && matches.length === 0 && html`<p class="chat-slash-empty" role="status">没有匹配的可用命令</p>`}
    ${matches.length > 0 && html`<div ref=${listRef} id=${id} class="chat-slash-list" role="listbox" aria-label="可用命令">
      ${matches.map((command, index) => html`<button key=${command.name} id=${`${id}-${index}`}
        type="button" role="option" class=${`chat-slash-option ${selected === index ? 'selected' : ''}`}
        aria-selected=${selected === index} tabIndex="-1" data-command=${command.name}
        onMouseDown=${event => event.preventDefault()} onMouseEnter=${() => onActiveIndexChange?.(index)}
        onClick=${() => onChoose?.(command)}>
        <span class="chat-slash-name" translate="no">${command.name}</span>
        <span class="chat-slash-kind">${commandHint(command)}</span>
        ${command.description && html`<span class="chat-slash-description" title=${command.description}>${command.description}</span>`}
      </button>`)}
    </div>`}
    <div class="chat-slash-footer">↑↓ 选择 · Tab / Enter 填入 · Esc 关闭</div>
  </section>`
}
