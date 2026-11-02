// Named-menu transport checks. No real CLI, session, account or model is used.
import assert from 'node:assert/strict';
import { sendVerifiedMenuKey } from '../desktop-files/native-controls.mjs';

const row = { id: 'synthetic-menu-session', profile: 'synthetic-profile' };
const calls = [];
const api = { deck: '/synthetic/deck', execInput: async (file, args, input) => {
  calls.push({ file, args, input });
  return { stdout: JSON.stringify({ success: true, session_id: row.id }) };
} };
// With TERM=screen, a native model row contains "❯ ESC[2m2. ESC[0mOpus".
// Ordinary send-keys Right/Enter mistakes that dim first cell for a suggestion
// and emits Escape. After the caller verifies the menu, send one raw named key
// through the CLI's primary-window TUI stream; do not send Escape or Vim's i.
for (const key of ['Right', 'Enter', 'Space', 'Escape']) {
  assert.equal((await sendVerifiedMenuKey(row, key, api)).success, true);
  assert.deepEqual(calls.at(-1), { file: api.deck, args: ['-p', row.profile, 'session', 'send-keys',
    row.id, '--stream', '--primary', '--json'], input: 'N ' + key + '\n' });
}
const count = calls.length;
for (const key of ['Right\nN Enter', 'C-c', 's', '', null]) await assert.rejects(sendVerifiedMenuKey(row, key, api));
assert.equal(calls.length, count, 'Invalid keys never reach the native process.');
let failures = 0;
await assert.rejects(sendVerifiedMenuKey(row, 'Right', { deck: api.deck, execInput: async () => {
  failures++; throw new Error('Synthetic uncertain delivery');
} }), /不会自动重发/);
assert.equal(failures, 1);
console.log('PASS: one named menu key, primary profile/window, invalid-input refusal and no retry after uncertain delivery.');
