import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { authHeaders } from './api.js'
import { readOnlySignal } from './state.js'
import { ManualLogin } from './ManualLogin.js'

export function AccountSettings({ en }) {
  const [open, setOpen] = useState(false)
  const [accounts, setAccounts] = useState([])
  const [selected, setSelected] = useState({})
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [adding, setAdding] = useState(''), [name, setName] = useState(''), [addError, setAddError] = useState('')
  const [bindDefault, setBindDefault] = useState(false)
  const [manual, setManual] = useState(null)
  const reading = useRef(null), launching = useRef(false)
  const headers = () => authHeaders({ 'X-AgentDeck-Desktop': '1' })

  async function refresh() {
    reading.current?.abort()
    const ctrl = new AbortController()
    reading.current = ctrl; setLoading(true)
    try {
      const res = await fetch('/desktop/accounts', { headers: headers(), signal: ctrl.signal })
      if (!res.ok) throw new Error()
      const data = await res.json()
      if (reading.current === ctrl) setAccounts(data.accounts)
    } catch {
      if (!ctrl.signal.aborted) { setAccounts([]); setNotice('read-error') }
    } finally { if (reading.current === ctrl) setLoading(false) }
  }

  useEffect(() => {
    if (!open) return
    refresh()
    window.addEventListener('focus', refresh)
    return () => { window.removeEventListener('focus', refresh); reading.current?.abort(); reading.current = null }
  }, [open])

  async function login(tool, slot) {
    if (launching.current || readOnlySignal.value) return
    launching.current = true; setBusy(tool); setNotice('')
    try {
      const res = await fetch('/desktop/accounts/login', { method: 'POST', headers: headers(),
        body: JSON.stringify({ tool, slot }) })
      if (!res.ok || (await res.json()).opened !== true) throw new Error()
      setNotice('opened')
    } catch { setNotice('open-error') }
    finally { launching.current = false; setBusy('') }
  }

  const t = (zh, english) => en ? english : zh
  async function add(tool) {
    if (launching.current || readOnlySignal.value || !name.trim()) return
    const slot = name.trim()
    launching.current = true; setBusy(tool); setAddError(''); setNotice('')
    try {
      const res = await fetch('/desktop/accounts/add', { method: 'POST', headers: headers(), body: JSON.stringify({ tool, slot, bindDefault }) })
      const data = await res.json()
      if (!res.ok || !data.success) throw new Error(data.error || t('保存失败', 'Save failed'))
      setSelected(old => ({ ...old, [tool]: slot })); setAdding(''); setName(''); await refresh(); setNotice(bindDefault ? 'bound' : 'saved')
    } catch (error) { setAddError(error.message) }
    finally { launching.current = false; setBusy('') }
  }
  return html`<section class="desktop-diagnostics">
    <button type="button" aria-expanded=${open} onClick=${() => { setManual(null); setOpen(!open); setNotice('') }}>
      ${t('账号管理', 'Account management')} ${open ? '▴' : '▾'}
    </button>
    ${open && html`<p>${t('“登录 / 切换账号”打开 WSL 原生窗口。“手动网页登录”在这里显示授权网址和下一步操作。', 'Sign in / switch opens the native WSL terminal. Manual web sign-in shows the authorization link and next step here.')}</p>
      ${accounts.map(row => {
        const slot = row.slots.find(s => s.name === selected[row.tool])
        const signedIn = slot ? slot.loggedIn : row.loggedIn
        return html`<div key=${row.tool}><div class="desktop-settings-row"><span><strong>${row.tool === 'claude' ? 'Claude Code' : 'Codex'}</strong>
          <small>${row.unavailable ? t('状态读取失败', 'Status unavailable') : !row.installed ? t('尚未安装', 'Not installed') : !row.loginSupported ? t('请在终端运行已配置的自定义登录命令', 'Run your custom login command in a terminal') :
            signedIn === true ? t('已检测到登录', 'Login detected') : signedIn === false ? t('未检测到登录', 'No login detected') : t('登录状态待核对', 'Login status unknown')}</small></span>
          ${row.slots.length > 0 && html`<select aria-label=${row.tool + t(' 登录配置', ' login profile')} value=${slot?.name || ''}
            disabled=${!!manual || !!busy} onChange=${e => setSelected({ ...selected, [row.tool]: e.currentTarget.value })}>
            <option value="">${t('默认账号', 'Default account')}</option>${row.slots.map(s => html`<option key=${s.name} value=${s.name}>${s.name}</option>`)}</select>`}
          <button type="button" disabled=${readOnlySignal.value || !row.installed || !row.loginSupported || !!manual || !!busy || loading}
            onClick=${() => login(row.tool, slot?.name || '')}>${busy === row.tool ? t('处理中…', 'Working…') : t('登录 / 切换账号', 'Sign in / switch')}</button></div>
          ${manual?.tool === row.tool ? html`<${ManualLogin} tool=${manual.tool} slot=${manual.slot} en=${en}
            onDone=${refresh} onClose=${() => setManual(null)}/>` : html`<button type="button" disabled=${!!manual || readOnlySignal.value || !row.installed || !row.loginSupported || !!busy || loading}
            onClick=${() => { setAdding(''); setNotice(''); setManual({tool:row.tool,slot:slot?.name || ''}) }}>${t('手动网页登录','Manual web sign-in')}</button>`}
          ${adding === row.tool ? html`<form class="desktop-diagnostics-actions" onSubmit=${e => { e.preventDefault(); add(row.tool) }}>
            <input aria-label=${t('账号名称', 'Account name')} placeholder=${t('账号名称，例如：工作', 'Account name, e.g. Work')} required maxlength="48"
              value=${name} onInput=${e => setName(e.currentTarget.value)}/>
            <label><input type="checkbox" checked=${bindDefault} onChange=${e => setBindDefault(e.currentTarget.checked)}/>
              ${t('引用当前默认登录（随默认登录变化）', 'Use current default login (follows its changes)')}</label>
            <button disabled=${!!busy || readOnlySignal.value || !name.trim()}>${t('保存账号', 'Save account')}</button>
            <button type="button" disabled=${!!busy} onClick=${() => setAdding('')}>${t('取消', 'Cancel')}</button>
            ${addError && html`<span role="alert">${addError}</span>`}</form>`
          : html`<button type="button" disabled=${!!manual || !!busy || readOnlySignal.value} onClick=${() => { setAdding(row.tool); setName(''); setBindDefault(false); setAddError(''); setNotice('') }}>
            ${t('添加账号', 'Add account')}</button>`}</div>`
      })}
      <div class="desktop-diagnostics-actions"><button type="button" disabled=${loading} onClick=${() => { setNotice(''); refresh() }}>
        ${loading ? t('正在读取…', 'Checking…') : t('刷新登录状态', 'Refresh login status')}</button></div>
      ${notice && html`<p role=${['opened','saved','bound'].includes(notice) ? 'status' : 'alert'}>${notice === 'bound' ? t('已为当前默认登录保存名称。', 'Your current default login now has a name.') : notice === 'saved' ? t('账号配置已保存，点“登录 / 切换账号”完成原生登录。', 'Profile saved. Choose Sign in / switch to authorize it.') : notice === 'opened'
        ? t('登录窗口已打开。完成授权后返回这里查看状态。', 'The login window is open. Return here after authorization.')
        : notice === 'read-error' ? t('无法读取账号状态，请刷新。', 'Could not read account status. Please refresh.')
        : t('原生登录窗口未能打开，可点该账号的“手动网页登录”。', 'Could not open the terminal. Choose Manual web sign-in for this account.')}</p>`}`}
  </section>`
}
