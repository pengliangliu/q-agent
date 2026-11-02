// Pure command-selection checks. No command or model is executed.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { slashCommandPolicy } from '../desktop-files/web-ui/overrides/static/app/slashCommandPolicy.js'

const builtin = (name, extra = {}) => ({ name, source: 'builtin', ...extra })
for (const tool of ['claude', 'codex']) {
  for (const name of ['/status', '/diff', '/mcp', '/skills', '/config', '/theme']) {
    assert.equal(slashCommandPolicy(builtin(name), tool).mode, 'execute')
  }
  for (const name of ['/model', '/effort']) assert.equal(slashCommandPolicy(builtin(name), tool).mode, 'model')
  for (const name of ['/clear', '/new', '/compact', '/quit', '/logout', '/approve', '/permissions', '/stop', '/delete', '/heapdump']) {
    assert.equal(slashCommandPolicy(builtin(name), tool).mode, 'confirm')
  }
  for (const name of ['/cd', '/rename', '/goal']) assert.equal(slashCommandPolicy(builtin(name), tool).mode, 'input')
}
for (const name of ['/help', '/context', '/cost', '/tasks', '/memory']) {
  assert.equal(slashCommandPolicy(builtin(name), 'claude').mode, 'execute')
  assert.equal(slashCommandPolicy(builtin(name), 'codex').mode, 'input')
}
for (const name of ['/apps', '/plugins', '/ps', '/warnings', '/debug-config', '/pwd']) {
  assert.equal(slashCommandPolicy(builtin(name), 'codex').mode, 'execute')
  assert.equal(slashCommandPolicy(builtin(name), 'claude').mode, 'input')
}
assert.equal(slashCommandPolicy(builtin('/status', { supportsInlineArgs: true }), 'codex').mode, 'execute')
assert.equal(slashCommandPolicy(builtin('/approve', { supportsInlineArgs: false, interaction: 'menu' }), 'codex').mode, 'confirm')
for (const extra of [{ requiresArguments: true }, { requiresArgs: true }, { argumentHint: '<target>' }]) {
  assert.equal(slashCommandPolicy(builtin('/status', extra), 'claude').mode, 'input')
}
assert.equal(slashCommandPolicy(builtin('/status', { argumentHint: '[optional]' }), 'claude').mode, 'execute')
for (const command of [{ name: '/status' }, { name: '/status', source: 'project-skill' },
  builtin('/status', { kind: 'skill' }), builtin('/status', { kind: 'mcp' }),
  builtin('/unknown', { interaction: 'menu', supportsInlineArgs: false }), builtin('/plugin:task'),
  builtin('/status-extra'), builtin('/Status'), builtin('/status extra'), builtin('/doctor'),
  builtin('/status', { tool: 'codex' }), builtin('/status', { internal: true }), builtin('/status', { visibleOnLinux: false })]) {
  const result = slashCommandPolicy(command, 'claude')
  assert.equal(result.mode, 'input')
  assert(result.message.length > 0)
}
assert.equal(slashCommandPolicy(builtin('/status'), 'unknown').mode, 'input')
assert.equal(slashCommandPolicy(null, 'claude').mode, 'input')
for (const tool of ['claude', 'codex']) {
  const catalog = JSON.parse(await fs.readFile(new URL('../desktop-files/' + tool + '-slash-commands.json', import.meta.url), 'utf8'))
  for (const command of catalog.commands) {
    const result = slashCommandPolicy({ ...command, source: command.source || 'builtin' }, tool)
    assert(['execute', 'input', 'confirm', 'model'].includes(result.mode))
    assert.equal(typeof result.message, 'string')
    assert(result.message.trim(), 'Every catalog entry has visible feedback.')
  }
}
console.log('PASS: exact built-ins, model routing, required input, confirmations, untrusted/unknown fallback, catalog feedback.')
