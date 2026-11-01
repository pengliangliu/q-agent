import { html } from 'htm/preact'
import { InlinePrompt } from './InlinePrompt.js'

export function CommandResult({ record, time, disabled, onRefresh, onRespond, onTerminal, openingTerminal, onDismiss, onStopTracking }) {
  const terminal = ['done', 'failed'].includes(record.state)
  const labels = { running: '命令执行中', awaiting_input: '等待你的选择', done: '命令已提交', failed: '命令未完成', unknown: '命令结果待确认' }
  const prompt = record.prompt
  return html`<section class="chat-command-result" aria-label="原生命令结果" onKeyDown=${event => event.stopPropagation()}>
    <header><div><strong>${labels[record.state] || '等待命令状态'}</strong><code translate="no">${record.command}</code></div>${time}
      ${terminal && html`<button type="button" aria-label="关闭命令结果" onClick=${onDismiss}>×</button>`}</header>
    ${record.message && html`<p role="status">${record.message}</p>`}
    ${record.trackingStopped && html`<p role="status">已停止自动等待，原命令回执已保留。可随时查询结果。</p>`}
    ${record.output && html`<details class="chat-command-output"><summary>查看命令输出</summary><pre translate="no">${record.output}</pre></details>`}
    ${prompt?.supported === true && prompt.id && prompt.options?.length ? html`<${InlinePrompt} key=${prompt.id}
      prompt=${{ ...prompt, kind: prompt.kind || 'question', type: prompt.type || 'question',
        actions: prompt.actions || [{ value: 'submit', label: '提交选择' }, { value: 'cancel', label: '取消' }] }}
      response=${record.response} disabled=${disabled} onRespond=${onRespond} onRefresh=${onRefresh} onAdvanced=${onTerminal} advancedLoading=${openingTerminal}/>`
      : prompt && html`<div class="chat-command-prompt"><pre translate="no">${prompt.text || '命令正在等待原生交互。'}</pre>
        <p>当前菜单无法自动识别，请在独立终端继续。</p><button type="button" disabled=${openingTerminal} onClick=${onTerminal}>${openingTerminal ? '正在打开…' : '在独立终端继续'}</button></div>`}
    ${!terminal && html`<div class="chat-command-actions"><button type="button" onClick=${onRefresh}>查询原命令状态</button>
      ${!record.trackingStopped && record.canStopTracking && !prompt && onStopTracking && html`<button type="button" disabled=${disabled} onClick=${onStopTracking}>停止等待，保留回执</button>`}
      ${!prompt && record.state === 'unknown' && html`<button type="button" disabled=${openingTerminal} onClick=${onTerminal}>在独立终端继续</button>`}</div>`}
  </section>`
}
