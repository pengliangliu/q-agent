import assert from 'node:assert/strict'
import { handleAccountSessions } from '../desktop-files/account-sessions.mjs'

const nativeId = 'beef0000-0000-0000-0000-000000000001'
const project = '/tmp/project with space/中文'
const targetHome = '/tmp/target-account'
const events = []
let failTrust = false
let row = {
  id: 'trust-switch-fixture', tool: 'claude', account: 'a',
  status: 'waiting', path: project, claude_session_id: nativeId,
}

const api = {
  deck: 'fixture',
  bodyJSON: async request => request.body,
  reply: (response, code, body) => Object.assign(response, { code, body }),
  session: async () => ({ ...row }),
  exec: async (binary, args) => {
    if (binary === '/usr/bin/python3') {
      assert.deepEqual(args.slice(1), [
        'trust-project', 'claude', '--directory', targetHome, '--project', project,
      ])
      events.push('trust')
      if (failTrust) throw new Error('fixture write failed')
      return { stdout: '' }
    }
    let result
    if (args[0] === 'accounts') {
      result = [{ name: 'b', config_dir: targetHome }]
    } else if (args[0] === 'harness') {
      result = { accounts: [{ name: 'b', logged_in: true }] }
    } else if (args[1] === 'switch-preview') {
      result = {
        source_tool: 'claude', target_harness: 'claude',
        source_account: 'a', target_account: 'b', source_session_id: nativeId,
        target_account_dir: targetHome, capability: 'native-resume', execution: 'supported',
      }
    } else if (args[1] === 'output') {
      result = { success: true, content: '❯\n──────────\n' }
    } else if (args[1] === 'switch') {
      assert.deepEqual(events, ['trust'])
      events.push('switch')
      row.account = 'b'
      result = { id: row.id, success: true, new_account: 'b' }
    } else {
      throw new Error('Unexpected native command')
    }
    return { stdout: JSON.stringify(result) }
  },
}

const originalFetch = globalThis.fetch
globalThis.fetch = async () => ({ ok: true, json: async () => ({ webMutations: true }) })
async function switchAccount() {
  const response = {}
  await handleAccountSessions({
    method: 'POST', headers: { 'x-agentdeck-desktop': '1' },
    body: { tool: 'claude', sessionId: row.id, from: 'a', slot: 'b' },
  }, response, new URL('http://localhost/desktop/accounts/switch'), api)
  return response
}

try {
  for (const status of ['waiting', 'stopped']) {
    row = { ...row, account: 'a', status }
    events.length = 0
    const result = await switchAccount()
    assert.equal(result.code, 200)
    assert.equal(result.body.success, true)
    assert.deepEqual(events, ['trust', 'switch'])
    assert.equal(row.claude_session_id, nativeId)
  }
  row.account = 'a'
  events.length = 0
  failTrust = true
  assert.equal((await switchAccount()).code, 409)
  assert.deepEqual(events, ['trust'])
  assert.equal(row.account, 'a')
  console.log('PASS: Claude target trust precedes live/stopped account switches; failed writes preserve the original account.')
} finally {
  globalThis.fetch = originalFetch
}
