import { html } from 'htm/preact'
import { useState } from 'preact/hooks'

// The parent keys this component by the server's current prompt ID. Selections
// stay local until an explicit submit; native cursor/checkbox state is not consent.
export function InlinePrompt({ prompt, response, disabled, onRespond, onRefresh, onAdvanced, advancedLoading, onStopTracking }) {
  const [choices, setChoices] = useState([])
  const [text, setText] = useState('')
  const kind = prompt?.kind || prompt?.type
  const options = Array.isArray(prompt?.options) ? prompt.options : []
  const actions = Array.isArray(prompt?.actions) ? prompt.actions : []
  const textInput = prompt?.textInput
  const supported = prompt?.supported === true && prompt?.id &&
    ['question', 'approval', 'review'].includes(kind) && (options.length || textInput || actions.length)
  const locked = disabled || Boolean(response)
  const otherSelected = choices.includes('other')
  const showText = textInput && (otherSelected || !options.length)
  const canSubmit = !locked && supported &&
    (options.length ? choices.length > 0 : textInput ? text.trim().length > 0 : actions.some(action => action.value === 'submit')) &&
    (!showText || (textInput.required === false && !otherSelected) || text.trim().length > 0)

  function submit(action = 'submit') {
    if (locked || !supported || (action === 'submit' && !canSubmit)) return
    if (action !== 'submit') { onRespond({ action }); return }
    onRespond({ ...(prompt.multiple ? { choices } : choices.length ? { choice: choices[0] } : {}),
      ...(showText ? { text } : {}), action: 'submit' })
  }

  return html`<section class="chat-inline-prompt" aria-label=${kind === 'approval' ? '权限确认' : '会话提问'}
    aria-busy=${response?.state === 'posting'} onKeyDown=${event => event.stopPropagation()}
    onKeyUp=${event => event.stopPropagation()} onKeyPress=${event => event.stopPropagation()}>
    <header class="chat-prompt-header"><strong>${kind === 'approval' ? '需要你的确认' : kind === 'review' ? '核对并提交回答' : '需要你的回答'}</strong>
      ${prompt?.questionIndex && prompt?.questionCount && html`<span>第 ${prompt.questionIndex} / ${prompt.questionCount} 题</span>`}</header>
    ${prompt?.header && html`<h3 translate="no">${prompt.header}</h3>`}
    <pre class="chat-prompt-context" translate="no">${prompt?.text || '会话正在等待输入，当前提示尚未识别。'}</pre>
    ${supported ? html`<form onSubmit=${event => { event.preventDefault(); submit() }}>
      ${options.length > 0 && html`<fieldset disabled=${locked} class="chat-prompt-options"><legend>${prompt.multiple ? '可选择多项，选好后提交' : '请选择一项，再提交'}</legend>
        ${options.map(option => html`<label class=${'chat-prompt-option' + (choices.includes(option.value) ? ' selected' : '')} key=${option.value}>
          <input type=${prompt.multiple ? 'checkbox' : 'radio'} name=${'prompt-' + prompt.id} value=${option.value}
            checked=${choices.includes(option.value)} onChange=${event => setChoices(prompt.multiple
              ? event.currentTarget.checked ? [...choices, option.value] : choices.filter(value => value !== option.value)
              : [option.value])} />
          <span><strong translate="no">${option.label}</strong>${option.description && html`<small translate="no">${option.description}</small>`}</span>
        </label>`)}</fieldset>`}
      ${showText && html`<label class="chat-prompt-text"><span>${textInput.label || '补充回答'}</span>
        <textarea rows="3" value=${text} disabled=${locked} maxLength=${textInput.maxLength || undefined}
          placeholder=${textInput.placeholder || ''} onInput=${event => setText(event.currentTarget.value)} /></label>`}
      <div class="chat-prompt-actions"><button class="chat-prompt-submit" type="submit" disabled=${!canSubmit}>
        ${response?.state === 'posting' ? '正在提交…' : actions.find(action => action.value === 'submit')?.label || (kind === 'approval' ? '提交选择' : '提交回答')}</button>
        ${actions.filter(action => ['back', 'cancel'].includes(action.value)).map(action => html`<button type="button" disabled=${locked} onClick=${() => submit(action.value)}>${action.label}</button>`)}</div>
    </form>` : html`<p class="chat-prompt-help">当前提示无法自动识别，请刷新查看；也可以打开高级控制处理。</p>
      <div class="chat-prompt-actions"><button type="button" onClick=${onRefresh}>刷新当前提示</button>
        <button type="button" disabled=${advancedLoading} onClick=${onAdvanced}>${advancedLoading ? '正在打开…' : '打开高级控制'}</button></div>`}
    ${response && html`<div class="chat-prompt-feedback" role=${['unknown', 'stale'].includes(response.state) ? 'alert' : 'status'}>
      <p>${response.trackingStopped ? '已停止自动等待，原确认记录已保留。当前问题仍需核对，可手动刷新或在独立终端查看。' : response.message || (response.state === 'posting' ? '正在提交当前回答。' : response.state === 'unknown' ? '提交结果待确认。已暂停重复提交，请刷新查询当前状态。' : response.state === 'stale' ? '提示已过期，请刷新后重新查看并选择。' : '选择已发送，正在等待会话更新。')}</p>
      ${response.state !== 'posting' && html`<button type="button" onClick=${onRefresh}>刷新当前提示</button>`}
      ${response.canStopTracking && !response.trackingStopped && onStopTracking && html`<button type="button" disabled=${disabled} onClick=${onStopTracking}>停止自动等待</button>`}
      ${response.state === 'unknown' && html`<button type="button" disabled=${advancedLoading} onClick=${onAdvanced}>${advancedLoading ? '正在打开…' : '在独立终端查看'}</button>`}</div>`}
  </section>`
}
