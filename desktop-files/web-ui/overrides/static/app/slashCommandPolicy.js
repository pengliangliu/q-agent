// Checked against Claude's command reference and the Codex CLI command reference.
// Only these bare built-ins are opened automatically; menu metadata alone is not enough.
// https://code.claude.com/docs/en/commands
// https://developers.openai.com/codex/cli/slash-commands
const common = new Set(['/status', '/diff', '/mcp', '/skills', '/config', '/theme'])
const execute = {
  claude: new Set(['/help', '/context', '/usage', '/cost', '/stats', '/tasks', '/agents', '/settings',
    '/plugin', '/output-style', '/memory', '/resume']),
  codex: new Set(['/apps', '/plugins', '/statusline', '/ps', '/warnings', '/debug-config', '/pwd', '/usage', '/resume']),
}
const inputs = {
  '/add-dir': '请填写要添加的目录路径，再按 Enter 执行。',
  '/cd': '请填写新的工作目录，再按 Enter 执行。',
  '/rename': '请填写新的会话名称，再按 Enter 执行。',
  '/btw': '请填写要询问的问题，再按 Enter 执行。',
  '/side': '请填写分支对话的任务，再按 Enter 执行。',
  '/goal': '请填写目标或目标操作，再按 Enter 执行。',
  '/batch': '请填写批量任务要求，再按 Enter 执行。',
  '/deep-research': '请填写研究问题，再按 Enter 执行。',
  '/subtask': '请填写子任务要求，再按 Enter 执行。',
  '/schedule': '请填写时间和任务要求，再按 Enter 执行。',
  '/loop': '请填写循环任务要求，再按 Enter 执行。',
}
const confirmations = new Map()
for (const [names, message] of [
  ['/clear /new /reset', '将开始新的对话上下文。确认执行吗？'],
  ['/compact', '将压缩当前对话上下文。确认执行吗？'],
  ['/exit /quit', '将退出当前助手进程。确认执行吗？'],
  ['/logout', '将退出账号，可能影响共用该登录的其他会话。确认执行吗？'],
  ['/approve', '将批准最近被拒绝的操作重试。确认执行吗？'],
  ['/approvals /permissions /allowed-tools /sandbox /setup-default-sandbox', '将打开权限或沙箱设置，请核对后续权限选择。确认继续吗？'],
  ['/stop', '将停止当前会话的后台工作。确认执行吗？'],
  ['/delete', '将永久删除当前会话及其子会话。确认执行吗？'],
  ['/archive', '将归档当前会话。确认执行吗？'],
  ['/rewind', '将打开代码或对话的回退选择。确认继续吗？'],
  ['/restart /update', '将重启或更新当前助手。确认执行吗？'],
  ['/fast /autocompact /auto-mode-setup /fewer-permission-prompts', '此命令会修改助手的运行或权限设置。确认执行吗？'],
  ['/init /import', '将创建或导入本地项目与配置文件。确认执行吗？'],
  ['/fork /branch /worktree', '将创建会话分支或工作树。确认执行吗？'],
  ['/background /bg', '将把当前会话转入后台运行。确认执行吗？'],
  ['/heapdump', '将写入包含会话内容和凭据的内存快照。确认执行吗？'],
]) {
  for (const name of names.split(' ')) confirmations.set(name, message)
}

export function slashCommandPolicy(command, tool) {
  const name = command?.name
  if (!execute[tool] || typeof name !== 'string' || !/^\/[A-Za-z0-9][\w.:-]*$/.test(name) ||
      (command.tool && command.tool !== tool) || command.internal || command.visibleOnLinux === false) {
    return { mode: 'input', message: '当前命令不可直接执行，请核对会话类型和可用命令。' }
  }
  if (command.source !== 'builtin' || (command.kind && command.kind !== 'builtin' && command.kind !== 'command')) {
    return { mode: 'input', message: '命令已填入，请核对技能或扩展的用法，补充任务内容后按 Enter 执行。' }
  }
  if (name === '/model' || name === '/effort') {
    return { mode: 'model', message: '打开当前会话的模型与强度设置。' }
  }
  if (command.requiresArguments === true || command.requiresArgs === true ||
      (typeof command.argumentHint === 'string' && /<[^<>]+>/.test(command.argumentHint))) {
    return { mode: 'input', message: '请补充命令参数，再按 Enter 执行。' }
  }
  if (confirmations.has(name)) return { mode: 'confirm', message: confirmations.get(name) }
  if (inputs[name]) return { mode: 'input', message: inputs[name] }
  if (common.has(name) || execute[tool].has(name)) {
    return { mode: 'execute', message: '正在打开原生命令；如有菜单，请继续选择。' }
  }
  return { mode: 'input', message: '命令已填入；请核对用法，按需补充参数后按 Enter 执行。' }
}
