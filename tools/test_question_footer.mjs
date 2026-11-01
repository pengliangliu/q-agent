// Synthetic native-menu checks; no model requests, real sessions or key sends.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claudePrompt, pendingClaudeRequest } from '../desktop-files/prompt-adapter.mjs';

const request = { type: 'tool_use', id: 'synthetic-question-footer-call', name: 'AskUserQuestion', input: {
  questions: [{ header: '合成选项', question: '请选择一个合成测试选项。', multiSelect: false,
    options: [{ label: '方案甲', description: '合成说明甲。' }, { label: '方案乙', description: '合成说明乙。' }] }],
} };
const footer = 'Enter to select · ↑/↓ to navigate · Esc to cancel';
const pane = `☐ 合成选项

请选择一个合成测试选项。

❯ 1. 方案甲
     合成说明甲。
  2. 方案乙
     合成说明乙。
  3. Type something.
────────────────────
  4. Chat about this
${footer}
`;
const prompt = claudePrompt(pane, request);
assert.equal(prompt?.supported, true);
assert.equal(prompt.type, 'question');
assert.deepEqual(prompt.options.map(option => option.value), ['1', '2', 'other']);
for (const wrapped of [footer, 'Enter to select · ↑/↓ to navigate ·\nEsc to cancel',
  'Enter to select ·\n↑/↓ to navigate ·\nEsc to cancel']) {
  for (const following of ['', 'Fixture | Context 20% | Quota 50%\n']) {
    const parsed = claudePrompt(pane.replace(footer, wrapped) + following, request);
    assert.equal(parsed?.id, prompt.id, 'Footer wrapping and later status text must preserve the same question.');
    assert.equal(parsed?.supported, true);
  }
}
for (const invalid of [pane.replace('☐ 合成选项', '☐ 不同标题'), pane.replace('1. 方案甲', '1. 不同选项'),
  pane.replace('合成说明甲。', '不同说明。'), pane.replace('Esc to cancel', 'Esc to close'),
  pane.replace(footer, 'Not a native question footer'), pane.replace('────────────────────', '')]) {
  assert.equal(claudePrompt(invalid, request), null);
}

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qagent-question-footer-'));
const file = path.join(directory, 'synthetic.jsonl');
const record = call => JSON.stringify({ type: 'assistant', message: { content: [call] } }) + '\n';
try {
  await fs.writeFile(file, record(request));
  assert.equal((await pendingClaudeRequest(file, pane + 'Fixture status line\n'))?.id, request.id);
  await fs.appendFile(file, JSON.stringify({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: request.id, content: 'Synthetic answer' },
  ] } }) + '\n');
  assert.equal(await pendingClaudeRequest(file, pane), null);
  await fs.writeFile(file, record(request) + record({ ...request, id: 'synthetic-second-call' }));
  assert.equal(await pendingClaudeRequest(file, pane), null);
} finally {
  await fs.unlink(file);
  await fs.rmdir(directory);
}
console.log('PASS: single/wrapped footer, later status text, exact question guards, unique unresolved native call.');
