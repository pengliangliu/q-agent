// Sidebar.js -- REWRITE. Status filters + groups + sessions list.
//
// Drops the old Tailwind Sidebar (still present in SessionList.js / SessionRow.js
// / GroupRow.js but no longer mounted). New design: bundle's `.sidebar` class
// stack with side-head / side-filter / side-list / sess rows.
//
// Action handlers route through apiFetch; mutations gated by mutationsEnabledSignal.
import { html } from 'htm/preact'
import { useState, useMemo, useEffect, useRef } from 'preact/hooks'
import { computed, signal } from '@preact/signals'
import { Icon, ICONS, Dot } from './icons.js'
import { menuModelSignal, sidebarRowsSignal, parentGroupPath, isGroupOpen, toggleGroupOpen, openCreateSessionForGroup, openRenameGroupDialog, currentGroupPath } from './dataModel.js'
import {
  selectedIdSignal, selectedGroupSignal, selectSession, selectGroup,
  mutationsEnabledSignal, confirmDialogSignal,
  editSessionDialogSignal,
} from './state.js'
import {
  statusFiltersSignal, showColsSignal, activeTabSignal,
  sidebarFilterSignal, groupExpandedSignal,
} from './uiState.js'
import { apiFetch } from './api.js'
import { addToast } from './Toast.js'
import { formatRelativeTime } from './timeFmt.js'
import { AnnotationLine } from './annotations.js'
import { noteSessionStarted } from './terminalReconnect.js'
import { ProjectActions } from './ProjectActions.js'
import { openProjectDialog } from './ProjectDialog.js'

// Older cached document shells may lack this link while loading the new tree.
// Keep its grid placement styles with the component so guides/toggles cannot
// consume the title's grid cell.
const treeStylesheet = new URL('./project.css', import.meta.url).href
if (![...document.querySelectorAll('link[rel="stylesheet"]')].some(link => link.href === treeStylesheet)) {
  const link = document.createElement('link')
  link.rel = 'stylesheet'; link.href = treeStylesheet
  document.head.append(link)
}

const collapsedSessions = signal({})
const CHAT_ICON = 'M21 11.5a8.4 8.4 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.4 8.4 0 01-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.4 8.4 0 013.8-.9h.5a8.5 8.5 0 018 8v.5z'

// Keep actual parent links, group membership and sibling order. A missing or
// filtered parent stays a reference rather than creating a synthetic session.
export const projectSidebarRowsSignal = computed(() => {
  const source = sidebarRowsSignal.value
  const collapsed = collapsedSessions.value
  const searching = !!sidebarFilterSignal.value.trim() || statusFiltersSignal.value.length > 0
  const output = []
  for (let index = 0; index < source.length;) {
    const row = source[index++]
    if (row.type === 'group') { output.push({ ...row }); continue }
    const members = [row]
    while (index < source.length && source[index].type === 'session') members.push(source[index++])
    const byId = new Map(members.map(member => [member.id, member]))
    const children = new Map()
    for (const member of members) {
      const parent = member.session.parent
      if (parent && parent !== member.id && byId.has(parent)) {
        if (!children.has(parent)) children.set(parent, [])
        children.get(parent).push(member)
      }
    }
    const visited = new Set()
    function walk(member, level, hidden = false) {
      if (visited.has(member.id)) return
      visited.add(member.id)
      const descendants = children.get(member.id) || []
      const expanded = searching || !collapsed[member.id]
      if (!hidden) output.push({ ...member, depth: member.groupDepth + 1 + level,
        childCount: descendants.length, childrenExpanded: expanded })
      for (const child of descendants) walk(child, level + 1, hidden || !expanded)
    }
    for (const member of members) if (!byId.has(member.session.parent) || member.session.parent === member.id) walk(member, 0)
    // Retain malformed cycles as visible entries; never recurse indefinitely.
    for (const member of members) if (!visited.has(member.id)) walk(member, 0)
  }
  // Connect only the rendered branches, so filtering and collapsing leave no
  // dangling lines. A root project's line never continues into another root.
  const nextAtDepth = []
  for (let index = output.length - 1; index >= 0; index--) {
    const row = output[index]
    row.treeHasNextSibling = !!nextAtDepth[row.depth]
    row.treeHasChildren = output[index + 1]?.depth > row.depth
    nextAtDepth.length = row.depth + 1
    nextAtDepth[row.depth] = row
  }
  const ancestors = []
  for (const row of output) {
    row.treeContinuationLevels = ancestors.slice(1, row.depth)
      .filter(ancestor => ancestor.treeHasNextSibling).map(ancestor => ancestor.depth)
    ancestors.length = row.depth
    ancestors[row.depth] = row
  }
  return output
})

// One chip per status bucket, in the same fixed order and with the same
// glyphs the group stats panel and the TUI use (GROUP_STATUS_BUCKETS /
// internal/ui/home.go:19418-19444). `stopped` was missing entirely, so a
// parked session could not be filtered for from the web at all.
const STATUS_CHIPS = [
  { id: 'running', sym: '●' },
  { id: 'waiting', sym: '◐' },
  { id: 'idle',    sym: '○' },
  { id: 'stopped', sym: '■' },
  { id: 'error',   sym: '✕' },
]

const SHOW_COL_OPTIONS = [
  { id: 'tool',     label: 'Tool badge' },
  { id: 'cost',     label: 'Cost' },
  { id: 'branch',   label: 'Git branch' },
  { id: 'attach',   label: 'MCPs / skills' },
  { id: 'sandbox',  label: 'Docker / worktree' },
  { id: 'lastSeen', label: 'Last activity' },
  { id: 'annotations', label: 'Goal / status hints' },
]

function doAction(action, s) {
  if (!mutationsEnabledSignal.value) {
    addToast('mutations disabled')
    return
  }
  const id = s.id
  if (action === 'start')   return apiFetch('POST', `/api/sessions/${id}/start`).then(() => noteSessionStarted(id)).catch(() => {})
  if (action === 'stop')    return apiFetch('POST', `/api/sessions/${id}/stop`).catch(() => {})
  if (action === 'restart') return apiFetch('POST', `/api/sessions/${id}/restart`).then(() => noteSessionStarted(id)).catch(() => {})
  if (action === 'fork')    return apiFetch('POST', `/api/sessions/${id}/fork`, { title: s.title + '-fork' }).catch(() => {})
  if (action === 'archive') {
    confirmDialogSignal.value = {
      // Reversible (unarchive restores it), so yellow rather than red —
      // matches TUI ConfirmArchiveSession.
      tone: 'warn',
      confirmLabel: 'Archive',
      title: 'Archive session?',
      message: `Archive session "${s.title}"? The process will be stopped and hidden from the active list.`,
      onConfirm: () => apiFetch('POST', `/api/sessions/${id}/archive`)
        .then(() => {
          if (selectedIdSignal.value === id) {
            selectSession(null)
            if (window.location.pathname.startsWith('/s/')) {
              history.replaceState(null, '', '/')
            }
          }
        })
        .catch(() => {}),
    }
  }
  if (action === 'delete') {
    confirmDialogSignal.value = {
      tone: 'danger',
      confirmLabel: 'Delete',
      title: 'Delete session?',
      message: `Delete session "${s.title}"? This stops the tmux session and removes metadata.`,
      onConfirm: () => apiFetch('DELETE', `/api/sessions/${id}`).catch(() => {}),
    }
  }
  if (action === 'worktreeFinish') {
    // Issue #1126 — POST /api/sessions/{id}/worktree/finish. Mirrors TUI
    // W/shift+w. Body left empty so the backend auto-detects target
    // branch and uses default flags (merge + delete branch).
    const branch = s.worktreeBranch || s.branch
    confirmDialogSignal.value = {
      // Destructive and not undoable (branch + worktree are deleted), so it
      // keeps the red tone; only the label stops claiming to be a delete.
      tone: 'danger',
      confirmLabel: 'Finish worktree',
      title: 'Finish worktree?',
      message: `Finish worktree for "${s.title}"? Merges branch "${branch}" into default branch, removes worktree, deletes branch, and removes session.`,
      onConfirm: () => apiFetch('POST', `/api/sessions/${id}/worktree/finish`).catch(() => {}),
    }
  }
  if (action === 'edit') {
    editSessionDialogSignal.value = { sessionId: id }
  }
}

// Groups and sessions share one coordinate system: each real level is a full
// tree indent, including the first session below a project folder.
const indentVar = (levels) => `--depth:${Math.max(0, levels)}`

function TreeGuides({ row }) {
  return html`<span class="desktop-tree-guides" aria-hidden="true">
    ${row.treeContinuationLevels.map(level => html`<span key=${level} class="desktop-tree-line desktop-tree-ancestor" style=${`--ancestor-depth:${level}`}/>`)}
    ${row.depth > 0 && html`<span class=${`desktop-tree-line desktop-tree-elbow ${row.type === 'session' && !row.childCount ? 'desktop-tree-leaf' : ''}`}/>`}
    ${row.depth > 0 && row.treeHasNextSibling && html`<span class="desktop-tree-line desktop-tree-sibling"/>`}
    ${row.treeHasChildren && html`<span class="desktop-tree-line desktop-tree-children"/>`}
  </span>`
}

function ProjectMenu({ group }) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef(null)
  const buttonRef = useRef(null)
  useEffect(() => {
    if (!open) return
    const outside = event => { if (!menuRef.current?.contains(event.target)) setOpen(false) }
    const escape = event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open])
  return html`<div ref=${menuRef} class="desktop-project-menu" onClick=${event => event.stopPropagation()}>
    <button ref=${buttonRef} type="button" class="desktop-session-menu-button"
      aria-label="项目操作" title="项目操作" aria-haspopup="menu" aria-expanded=${open}
      data-testid=${`group-menu-${group.path}`} onClick=${() => setOpen(value => !value)}>⋯</button>
    ${open && html`<div class="desktop-project-menu-items" role="menu" aria-label="项目操作" onKeyDown=${event => event.stopPropagation()}>
      <button type="button" role="menuitem" data-testid=${`group-new-child-${group.path}`}
        onClick=${() => { setOpen(false); openProjectDialog({ parentPath: group.path }) }}>
        <${Icon} d=${ICONS.plus} size=${12}/>新建子项目
      </button>
      <button type="button" role="menuitem" data-testid=${`group-rename-${group.path}`}
        onClick=${() => { setOpen(false); openRenameGroupDialog(group.path) }}>
        <${Icon} d=${ICONS.edit} size=${12}/>重命名项目
      </button>
    </div>`}
  </div>`
}

function SessionItem({ s, sel, rowKey, onSelect, showCols, depth, groupDepth, childCount, childrenExpanded, row }) {
  const [exp, setExp] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const actionsRef = useRef(null)
  const actionsButtonRef = useRef(null)
  useEffect(() => {
    if (!actionsOpen) return
    const outside = event => {
      if (!actionsRef.current?.contains(event.target) && !actionsButtonRef.current?.contains(event.target)) setActionsOpen(false)
    }
    const escape = event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setActionsOpen(false)
      actionsButtonRef.current?.focus()
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [actionsOpen])
  const action = verb => {
    setActionsOpen(false)
    doAction(verb, s)
  }
  const indented = depth > groupDepth + 1
  const parent = s.parent && menuModelSignal.value.sessions.find(session => session.id === s.parent)
  const mcpCount = (s.mcps || []).length
  const skillCount = (s.skills || []).length
  // Persisted showCols from before this option existed lack the key; on by default.
  const showAnnotation = showCols.annotations !== false
  const hasSubline =
    (showCols.branch && s.branch && s.branch !== '—') ||
    (showCols.attach && (mcpCount > 0 || skillCount > 0)) ||
    (showCols.sandbox && (s.sandbox || s.worktree)) ||
    showCols.lastSeen
  return html`
    <div class=${`sess ${sel ? 'sel' : ''} ${s.kind} ${exp ? 'exp' : ''} ${indented ? 'sub' : ''}`}
         data-row-key=${rowKey}
         data-session-id=${s.id}
         data-parent-session-id=${s.parent || undefined}
         data-session-depth=${depth - groupDepth - 1}
         data-tree-depth=${depth}
         style=${indentVar(depth)}
         aria-selected=${!!sel}
         onClick=${() => { setActionsOpen(false); onSelect(s.id) }}>
      <${TreeGuides} row=${row}/>
      ${childCount > 0 && html`<button type="button" class="desktop-child-toggle" aria-expanded=${childrenExpanded}
        aria-label=${childrenExpanded ? '收起子会话' : '展开子会话'} data-testid=${`session-children-${s.id}`}
        onClick=${event => { event.stopPropagation(); collapsedSessions.value = { ...collapsedSessions.value, [s.id]: childrenExpanded } }}>
        ${childrenExpanded ? '▾' : '▸'}
      </button>`}
      <span class="sig desktop-session-icon" aria-label="会话"><${Icon} d=${CHAT_ICON} size=${15}/></span>
      <div class="titleline">
        <span class="tt" title=${s.title} translate="no">${s.title}</span>
        <${Dot} status=${s.status}/>
      </div>
      ${(childCount > 0 || (s.parent && !indented)) && html`<div class="desktop-session-relation">
        ${childCount > 0 && html`<span>${childCount} 个子会话</span>`}
        ${s.parent && !indented && html`<span class="desktop-parent-reference" title=${parent?.title || s.parent}>父会话：${parent?.title || s.parent}</span>`}
      </div>`}
      <div class="meta">
        ${showCols.tool && s.tool && html`<span class="tag">${s.tool}</span>`}
        ${showCols.cost && s.cost > 0 && html`<span class="cost">$${s.cost.toFixed(2)}</span>`}
        <button class="row-chev" title="Details" onClick=${e => { e.stopPropagation(); setExp(v => !v) }}>
          ${exp ? '▾' : '▸'}
        </button>
        ${mutationsEnabledSignal.value && html`
          <button type="button" ref=${actionsButtonRef} class="desktop-session-menu-button"
                  aria-label="会话操作" title="会话操作" aria-haspopup="menu" aria-expanded=${actionsOpen}
                  aria-controls=${`session-actions-${s.id}`} data-testid=${`session-menu-${s.id}`}
                  onClick=${event => { event.stopPropagation(); setActionsOpen(value => !value) }}>⋯</button>
        `}
      </div>
      ${showAnnotation && html`<${AnnotationLine} s=${s}/>`}
      ${hasSubline && html`
        <div class="subline">
          ${showCols.branch && s.branch && s.branch !== '—' && html`<span class="trunc"><span class="b">git</span> ${s.branch}</span>`}
          ${showCols.attach && mcpCount > 0 && html`<span class="att-count">${mcpCount} mcp${mcpCount > 1 ? 's' : ''}</span>`}
          ${showCols.attach && skillCount > 0 && html`<span class="att-count skill">${skillCount} skill${skillCount > 1 ? 's' : ''}</span>`}
          ${showCols.sandbox && s.sandbox && html`<span class="att-count warn">docker</span>`}
          ${showCols.sandbox && s.worktree && html`<span class="att-count">worktree</span>`}
          ${showCols.lastSeen && html`<span class="att-count" title="Last active">⏱ ${s.status === 'running' ? 'active now' : formatRelativeTime(s.lastAccessedAt)}</span>`}
        </div>
      `}
      ${exp && html`
        <div class="row-detail" onClick=${e => e.stopPropagation()}>
          <div class="rd-row"><span class="rd-k">tool</span><span class="rd-v">${s.tool || '—'}</span></div>
          ${s.branch && s.branch !== '—' && html`<div class="rd-row"><span class="rd-k">branch</span><span class="rd-v">${s.branch}</span></div>`}
          ${s.path && html`<div class="rd-row"><span class="rd-k">path</span><span class="rd-v" title=${s.path}>${s.path}</span></div>`}
          ${s.cost > 0 && html`<div class="rd-row"><span class="rd-k">cost</span><span class="rd-v ok">$${s.cost.toFixed(2)}</span></div>`}
        </div>
      `}
      ${actionsOpen && html`<div ref=${actionsRef} id=${`session-actions-${s.id}`}
           class="actions desktop-session-actions" role="menu" aria-label="会话操作"
           onClick=${e => e.stopPropagation()} onKeyDown=${e => e.stopPropagation()}>
        ${(s.status === 'running' || s.status === 'waiting')
          ? html`<button type="button" role="menuitem" class="mini" data-testid="session-stop-btn" onClick=${() => action('stop')}><${Icon} d=${ICONS.stop} size=${12}/>停止</button>`
          : html`<button type="button" role="menuitem" class="mini good" data-testid="session-start-btn" onClick=${() => action('start')}><${Icon} d=${ICONS.play} size=${12}/>启动</button>`}
        <button type="button" role="menuitem" class="mini good" data-testid="session-restart-btn" onClick=${() => action('restart')}><${Icon} d=${ICONS.restart} size=${12}/>重启</button>
        <button type="button" role="menuitem" class="mini" data-testid="edit-session-btn" onClick=${() => action('edit')}><${Icon} d=${ICONS.edit} size=${12}/>编辑会话</button>
        ${s.canFork && html`<button type="button" role="menuitem" class="mini fork" data-testid="session-fork-btn" onClick=${() => action('fork')}><${Icon} d=${ICONS.fork} size=${12}/>分支会话</button>`}
        ${s.worktree && html`<button type="button" role="menuitem" class="mini" onClick=${() => action('worktreeFinish')} data-action="worktree-finish" data-testid="session-worktree-finish-btn"><${Icon} d=${ICONS.merge} size=${12}/>结束工作树</button>`}
        <button type="button" role="menuitem" class="mini warn" data-testid="session-archive-btn" onClick=${() => action('archive')}><${Icon} d=${ICONS.archive} size=${12}/>归档</button>
        <button type="button" role="menuitem" class="mini danger" data-testid="session-delete-btn" onClick=${() => action('delete')}><${Icon} d=${ICONS.trash} size=${12}/>删除</button>
      </div>`}
    </div>
  `
}

export function Sidebar() {
  const { sessions, groups } = menuModelSignal.value
  const rows = projectSidebarRowsSignal.value
  const selected = selectedIdSignal.value
  const selectedGroup = selectedGroupSignal.value
  const statusFilters = statusFiltersSignal.value
  const showCols = showColsSignal.value
  const filter = sidebarFilterSignal.value
  const expandedMap = groupExpandedSignal.value
  const [showMenu, setShowMenu] = useState(false)
  const projectPaths = useMemo(() => new Map(groups.map(group => {
    const members = sessions.filter(session => session.group === group.path || session.group.startsWith(group.path + '/'))
    const paths = [...new Set(members.map(session => session.path).filter(Boolean))]
    return [group.path, group.defaultPath || (members.length && members.every(session => session.path) && paths.length === 1 ? paths[0] : '')]
  })), [groups, sessions])

  const totalVisible = useMemo(
    () => rows.reduce((n, r) => n + (r.type === 'session' ? 1 : 0), 0),
    [rows],
  )

  const toggleStatus = (id) => {
    const cur = statusFiltersSignal.value
    statusFiltersSignal.value = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]
  }
  const toggleGroup = (p) => toggleGroupOpen(p)
  const groupOpen = path => !!filter.trim() || isGroupOpen(expandedMap, path)
  const onSelect = (id) => {
    selectSession(id)
    activeTabSignal.value = 'terminal'
  }
  const setShowCol = (id) => {
    showColsSignal.value = { ...showCols, [id]: !showCols[id] }
  }

  return html`
    <div class="sidebar desktop-project-sidebar">
      <div class="desktop-sidebar-create"><${ProjectActions}/></div>
      <div class="side-head">
        <span class="label">项目与会话</span>
        <span class="count">${totalVisible} 个可见会话</span>
        <div class="spacer"/>
        <div style="position: relative;">
          <button class=${`icon-btn ${showMenu ? 'active' : ''}`} title="Show columns" aria-label="Show columns"
                  data-testid="show-cols-btn"
                  onClick=${() => setShowMenu(m => !m)}>
            <${Icon} d=${ICONS.filter}/>
          </button>
          ${showMenu && html`
            <div class="show-menu" data-testid="show-cols-menu" onClick=${e => e.stopPropagation()}>
              <div class="sm-head">SHOW IN ROW</div>
              ${SHOW_COL_OPTIONS.map(c => html`
                <label key=${c.id} class="sm-row" data-testid=${`show-col-${c.id}`}>
                  <input type="checkbox" checked=${!!showCols[c.id]} onChange=${() => setShowCol(c.id)}/>
                  <span>${c.label}</span>
                </label>
              `)}
              <div class="sm-foot" onClick=${() => setShowMenu(false)}>done</div>
            </div>
          `}
        </div>
        ${mutationsEnabledSignal.value && html`
          <button class="icon-btn" title="New session (n)" aria-label="New session"
                  onClick=${() => openCreateSessionForGroup(currentGroupPath())}>
            <${Icon} d=${ICONS.plus}/>
          </button>
        `}
      </div>
      <div class="side-filter">
        <input
          placeholder="/ filter"
          data-testid="sidebar-filter-input"
          value=${filter}
          onInput=${e => (sidebarFilterSignal.value = e.target.value)}
        />
        ${STATUS_CHIPS.map(s => html`
          <span key=${s.id}
                class=${`side-chip ${statusFilters.includes(s.id) ? 'on' : ''}`}
                data-testid=${`status-chip-${s.id}`}
                onClick=${() => toggleStatus(s.id)}
                title=${s.id}>
            ${s.sym}
          </span>
        `)}
      </div>
      <div class="side-list">
        ${rows.map(r => r.type === 'group'
          ? html`
            <div key=${r.key}
                 class=${`side-group-head ${r.group.kind || ''} ${selectedGroup === r.path ? 'sel' : ''}`}
                 data-testid=${`group-head-${r.path}`}
                 data-row-key=${r.key}
                 data-tree-depth=${r.depth}
                 data-group-path=${r.path}
                 data-parent-group-path=${parentGroupPath(r.path) || undefined}
                 style=${indentVar(r.depth)}
                 aria-selected=${selectedGroup === r.path}
                 onClick=${() => selectGroup(r.path)}>
              <${TreeGuides} row=${r}/>
              <button type="button" class="chev"
                      data-testid=${`group-chev-${r.path}`}
                      aria-expanded=${groupOpen(r.path)}
                      aria-label=${`${groupOpen(r.path) ? '收起' : '展开'}${r.depth ? '子项目' : '项目'}`}
                      title=${groupOpen(r.path) ? 'Collapse group' : 'Expand group'}
                      onClick=${e => { e.stopPropagation(); toggleGroup(r.path) }}>
                ${groupOpen(r.path) ? '▾' : '▸'}
              </button>
              <span class="desktop-project-icon"><${Icon} d=${ICONS.folder} size=${16}/></span>
              <span class="desktop-project-heading" title=${r.path}>
                <span class="desktop-project-kind">${projectPaths.get(r.path) ? (r.depth ? '子项目' : '项目') : (r.depth ? '子分组' : '分组')}</span>
                <span class="name">${r.group.name || r.group.label}</span>
                ${projectPaths.get(r.path) && html`<span class="desktop-project-location" title=${projectPaths.get(r.path)} data-desktop-preserve>${projectPaths.get(r.path)}</span>`}
              </span>
              <span class="badge">${r.memberCount} 会话</span>
              ${mutationsEnabledSignal.value && !r.group.derived && html`<${ProjectMenu} group=${r.group}/>`}
            </div>
          `
          : html`
            <${SessionItem} key=${r.key} s=${r.session} sel=${selected === r.id}
                            rowKey=${r.key} depth=${r.depth} groupDepth=${r.groupDepth}
                            row=${r}
                            childCount=${r.childCount} childrenExpanded=${r.childrenExpanded}
                            onSelect=${onSelect} showCols=${showCols}/>
          `,
        )}
        ${sessions.length === 0 && html`
          <div style="padding: 16px; font-family: var(--mono); font-size: 11px; color: var(--muted); text-align: center;">
            No sessions yet. Press <span class="kbd" style="border:1px solid var(--border); padding: 0 4px; border-radius: 3px;">n</span> to create one.
          </div>
        `}
      </div>
    </div>
  `
}
