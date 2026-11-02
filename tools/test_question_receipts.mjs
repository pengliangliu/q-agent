// All sessions, native results and keys below are synthetic. Receipts use a temporary home.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qagent-question-receipts-'));
const previousHome = process.env.HOME, previousProfile = process.env.USERPROFILE;
process.env.HOME = directory;
process.env.USERPROFILE = directory;
assert.equal(path.resolve(os.homedir()), path.resolve(directory));
const { handleChat } = await import('../desktop-files/chat-backend.mjs');
const { claudeQuestionResult } = await import('../desktop-files/prompt-adapter.mjs');
const question = (header = '合成问题', text = '请选择一个合成选项。') => ({ header, question: text, multiSelect: false,
  options: [{ label: '选项甲', description: '合成说明甲' }, { label: '选项乙', description: '合成说明乙' }] });
const record = block => JSON.stringify({ type: block.type === 'tool_result' ? 'user' : 'assistant',
  message: { content: [block] } }) + '\n';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const tested = [];

async function run(mode) {
  const id = 'synthetic-session-' + mode;
  const request = { type: 'tool_use', id: 'synthetic-call-' + mode, name: 'AskUserQuestion', input: {
    questions: mode === 'next-step' ? [question(), question('第二题', '请选择下一合成选项。')] : [question()],
  } };
  const file = path.join(directory, mode + '.jsonl');
  await fs.writeFile(file, record(request));
  const row = { id, tool: 'claude', status: 'waiting', path: directory, tmux_session: 'synthetic-pane',
    claude_session_id: 'synthetic-native-' + mode, transcript_path: file };
  let visibleRequest = request, questionIndex = 0, cursor = 0, blank = false;
  const keys = [];
  function pane() {
    if (blank) return '';
    const questions = visibleRequest.input.questions, q = questions[questionIndex];
    const header = questions.length === 1 ? '☐ ' + q.header : '← ☐ 合成问题 ☐ 第二题 ✔ Submit →';
    return [header, q.question, ...q.options.flatMap((option, index) => [
      `${cursor === index ? '❯' : ' '} ${index + 1}. ${option.label}`, '    ' + option.description]),
    '  3. Type something.', '────────────────', '  4. Chat about this',
    'Enter to select · ↑/↓ to navigate · Esc to cancel', ''].join('\n');
  }
  const api = {
    deck: 'synthetic-deck', session: async () => row, bodyJSON: async req => req.body,
    reply: (res, code, body) => Object.assign(res, { code, body }),
    exec: async (command, args) => {
      if (command === '/usr/bin/python3') return { stdout: JSON.stringify({ messages: [] }) };
      if (args.includes('output')) return { stdout: JSON.stringify({ success: true, session_id: id, content: pane() }) };
      assert(args.includes('send-keys'), 'Unexpected native command');
      const key = args.includes('--enter') ? 'Enter' : args[args.indexOf('--named-key') + 1];
      keys.push(key);
      if (key === 'Down') { cursor++; if (mode === 'navigation-only') blank = true; }
      if (key === 'Enter' || key === 'Escape') {
        if (mode === 'final-key-refused') return { stdout: JSON.stringify({ success: false }) };
        if (['accepted', 'rejected', 'cancelled'].includes(mode)) {
          await fs.appendFile(file, record({ type: 'tool_result', tool_use_id: request.id,
            is_error: mode !== 'accepted', content: 'Synthetic result content stays private' }));
          blank = true;
        } else if (mode === 'next-step') { questionIndex++; cursor = 0; }
        else if (mode === 'different-call') {
          visibleRequest = { ...request, id: 'synthetic-other-call', input: { questions: [question('其他问题', '请选择其他合成选项。')] } };
          await fs.appendFile(file, record(visibleRequest));
          cursor = 0;
        } else if (mode === 'missing-null') blank = true;
      }
      return { stdout: JSON.stringify({ success: true, session_id: id }) };
    },
  };
  async function invoke(route, body) {
    const res = {};
    await handleChat({ method: body ? 'POST' : 'GET', body, headers: { 'x-agentdeck-desktop': '1' } }, res,
      new URL('http://fixture/desktop/chat/' + route), api);
    return res;
  }
  const initial = await invoke('history?sessionId=' + id);
  assert.equal(initial.body.prompt?.supported, true);
  const promptId = initial.body.prompt.id;
  const body = { sessionId: id, promptId, ...(mode === 'cancelled' ? { action: 'cancel' } : { action: 'submit', choice: mode === 'navigation-only' ? '2' : '1' }) };
  const result = await invoke('respond', body);
  const receiptFile = path.join(directory, '.local/share/agent-deck/chat-receipts', 'prompt-' + digest(id + ':' + promptId) + '.json');
  const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
  assert.equal(receipt.requestId, request.id);
  assert.equal(receipt.action, mode === 'cancelled' ? 'cancel' : 'submit');
  for (const name of ['text', 'choice', 'choices', 'answer', 'label']) assert.equal(Object.hasOwn(receipt, name), false);
  assert.equal(JSON.stringify(receipt).includes('合成说明'), false);
  assert.equal(keys.filter(key => key === 'Enter' || key === 'Escape').length, mode === 'navigation-only' ? 0 : 1,
    JSON.stringify({ mode, keys, result }));
  assert.equal(receipt.finalKeyAttempted, mode !== 'navigation-only');
  assert.equal(receipt.finalKeySent, !['navigation-only', 'final-key-refused'].includes(mode));
  if (mode === 'rejected') {
    assert.equal(result.code, 409);
    assert.equal(result.body.success, false);
    assert.equal(result.body.verified, true);
    assert.equal(result.body.reason, 'native_question_rejected');
  } else if (['accepted', 'cancelled', 'next-step'].includes(mode)) {
    assert.equal(result.body.success, true);
    assert.equal(result.body.outcome, mode);
    assert.equal(result.body.verified, true);
  } else if (mode.startsWith('missing') || mode === 'different-call') {
    assert.equal(result.code, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.outcome, 'pending');
    assert.equal(result.body.verified, false);
    assert.equal(result.body.state, 'waiting');
    if (mode === 'different-call') assert(result.body.nextPromptId && result.body.nextPromptId !== promptId);
  } else {
    assert.equal(result.code, 409);
    assert.equal(receipt.outcome, 'pending');
    assert.equal(receipt.verified, false);
  }
  if (['missing-same', 'navigation-only', 'final-key-refused'].includes(mode)) {
    blank = false;
    const count = keys.length;
    const repeated = await invoke('respond', body);
    assert.equal(repeated.code, 409);
    assert.equal(keys.length, count, 'An uncertain receipt must never replay keys.');
    const status = (await invoke('history?sessionId=' + id)).body.responseStatus;
    assert.equal(status.promptId, promptId);
    assert.equal(status.inputBlocked, true);
    assert.equal(status.finalKeySent, receipt.finalKeySent);
    assert.equal(status.outcome, 'pending');
  }
  tested.push(mode);
}

try {
  for (const mode of ['accepted', 'rejected', 'cancelled', 'missing-null', 'missing-same', 'next-step',
    'different-call', 'navigation-only', 'final-key-refused']) await run(mode);
  const scopeFile = path.join(directory, 'result-scope.jsonl');
  await fs.writeFile(scopeFile, record({ type: 'tool_result', tool_use_id: 'other-call', content: 'Synthetic unrelated output' }) +
    JSON.stringify({ type: 'user', isSidechain: true, message: { content: [
      { type: 'tool_result', tool_use_id: 'exact-call', content: 'Synthetic sidechain output' },
    ] } }) + '\n');
  assert.equal(await claudeQuestionResult(scopeFile, 'exact-call'), null);
  console.log('PASS: ' + tested.join(', ') + '; exact call scope; no answer text in receipts; no key replay.');
} finally {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert(path.basename(directory).startsWith('qagent-question-receipts-'));
  await fs.rm(directory, { recursive: true, force: true });
}
