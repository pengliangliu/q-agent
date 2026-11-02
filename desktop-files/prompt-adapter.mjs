import crypto from 'node:crypto';
import fsp from 'node:fs/promises';

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clean = value => String(value || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
const compact = value => clean(value).replace(/\s+/g, '');
const lineText = value => clean(value).trim().replace(/\s+/g, ' ');
const questionText = value => clean(value).split('\n').map(line => line.replace(/^\s*│\s?/, '')).join('\n');
const cancel = { value: 'cancel', label: '取消' };

export function publicPrompt(prompt) {
  if (!prompt) return null;
  const { _native, ...visible } = prompt;
  return visible;
}

// Only unresolved tool_use records from the primary transcript can back a card.
// A bounded tail is sufficient; missing or truncated evidence fails closed.
async function transcriptRecords(file) {
  if (typeof file !== 'string' || !file.endsWith('.jsonl')) return null;
  const handle = await fsp.open(file, 'r');
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, 4 * 1024 * 1024);
    const bytes = Buffer.alloc(length);
    await handle.read(bytes, 0, length, stat.size - length);
    const lines = bytes.toString('utf8').split('\n');
    if (stat.size > length) lines.shift();
    const records = [];
    for (const line of lines) {
      try { records.push(JSON.parse(line)); } catch { /* Incomplete tail records are not evidence. */ }
    }
    return records;
  } finally { await handle.close(); }
}

export async function pendingClaudeRequest(file, content) {
    const calls = new Map();
    const completed = new Set();
    for (const record of await transcriptRecords(file) || []) {
      if (record.isSidechain || !['assistant', 'user'].includes(record.type)) continue;
      const blocks = record.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (block.type === 'tool_use' && typeof block.id === 'string') calls.set(block.id, block);
        if (block.type === 'tool_result') completed.add(block.tool_use_id);
      }
    }
    const pending = [...calls.values()].filter(call => !completed.has(call.id));
    if (content === undefined) return pending.at(-1) || null;
    // Parallel/background calls can be newer than the visible question. Match
    // the actual screen, keeping the corresponding unresolved native call ID.
    const visible = pending.filter(call => claudePrompt(content, call));
    return visible.length === 1 ? visible[0] : null;
}

// Only the exact native call's result proves that an answer was accepted.
// Return no answer text or tool output to the caller.
export async function claudeQuestionResult(file, requestId) {
  if (typeof requestId !== 'string' || !requestId) return null;
  for (const record of (await transcriptRecords(file) || []).reverse()) {
    if (record.isSidechain || record.type !== 'user' || !Array.isArray(record.message?.content)) continue;
    for (const block of record.message.content) {
      if (block.type !== 'tool_result' || block.tool_use_id !== requestId) continue;
      if (block.is_error === true) return 'rejected';
      if (block.is_error === undefined || block.is_error === false) return 'accepted';
      return null;
    }
  }
  return null;
}

export async function pendingCodexRequest(file) {
  const calls = new Map(), completed = new Set();
  for (const record of await transcriptRecords(file) || []) {
    const item = record.payload;
    if (record.type !== 'response_item' || !item?.call_id) continue;
    if (['function_call', 'custom_tool_call'].includes(item.type)) calls.set(item.call_id, item);
    if (['function_call_output', 'custom_tool_call_output'].includes(item.type)) completed.add(item.call_id);
  }
  return [...calls.values()].filter(call => !completed.has(call.call_id)).at(-1) || null;
}

export function codexApprovalPrompt(content) {
  const lines = clean(content).split('\n').slice(-40);
  const pattern = /^\s*(›\s*)?([1-9][0-9]*)\.\s+(.+?)\s*$/;
  let selected = -1;
  for (let i = lines.length - 1; i >= 0; i--) { if (lines[i].match(pattern)?.[1]) { selected = i; break; } }
  if (selected < 0) return null;
  const options = [];
  let first = -1, last = selected;
  for (let i = Math.max(0, selected - 12); i <= Math.min(lines.length - 1, selected + 16); i++) {
    const match = lines[i].match(pattern);
    if (!match) continue;
    if (Number(match[2]) > 9) return null;
    options.push({ value: match[2], label: lineText(match[3]) });
    if (first < 0) first = i;
    last = i;
  }
  if (options.length < 2 || !options.some(x => /^yes/i.test(x.label)) || !options.some(x => /^no/i.test(x.label))) return null;
  const text = lines.slice(Math.max(0, first - 12), last + 1)
    .map(line => lineText(line).replace(/^›\s*/, '')).filter(Boolean).join('\n');
  return { type: 'approval', kind: 'approval', supported: true, state: 'ready',
    id: digest(text), text, options, multiple: false, actions: [] };
}

function numberedRows(lines) {
  return lines.flatMap((line, index) => {
    const match = line.match(/^\s*(❯\s*)?([1-9])\.\s+(?:\[([ ✔xX])\]\s*)?(.*?)\s*$/);
    return match ? [{ index, focused: Boolean(match[1]), value: match[2],
      checked: match[3] === undefined ? null : match[3] !== ' ', label: match[4] }] : [];
  });
}

function nativeState(rows, extra = {}) {
  return { cursor: rows.findIndex(item => item.focused), rows, ...extra };
}

export function claudePrompt(content, request) {
  const lines = clean(content).split('\n');
  let tabs = lines.findLastIndex(line => /^\s*←.*[☐☒].*✔\s*Submit.*→\s*$/.test(line));
  // A single question has only its header, without the multi-question tab bar.
  // Keep the exact native header and all question/option checks below.
  const single = request?.name === 'AskUserQuestion' && request.input?.questions?.length === 1
    ? request.input.questions[0] : null;
  if (tabs < 0 && single?.multiSelect !== true && typeof single?.header === 'string' && single.header.trim()) {
    tabs = lines.findLastIndex(line => {
      const header = line.match(/^\s*[☐☒]\s+(.+?)\s*$/);
      return header && compact(header[1]) === compact(single.header);
    });
  }
  if (request?.name === 'AskUserQuestion' && tabs >= 0) {
    const questions = request.input?.questions;
    if (!Array.isArray(questions) || !questions.length || questions.length > 4 ||
        questions.some(q => typeof q.question !== 'string' || !Array.isArray(q.options) ||
          q.options.length < 2 || q.options.length > 8 || q.options.some(o => typeof o.label !== 'string'))) return null;
    const section = lines.slice(tabs + 1);
    const rows = numberedRows(section);
    if (rows.filter(row => row.focused).length > 1) return null;
    const review = section.findIndex(line => line.trim() === 'Review your answers');
    if (review >= 0) {
      const block = section.slice(review, rows[0]?.index).join('\n').trim();
      if (rows.filter(row => row.focused).length !== 1 || rows.length !== 2 || rows[0].label !== 'Submit answers' || rows[1].label !== 'Cancel' ||
          !block.includes('Ready to submit your answers?') ||
          !questions.every(q => compact(questionText(block)).includes(compact(q.question)))) return null;
      return { type: 'review', kind: 'review', supported: true, state: 'ready',
        id: digest([request.id, request.input, 'review', compact(block)]), text: block, multiple: false, options: [],
        actions: [{ value: 'submit', label: '提交全部答案' }, cancel],
        _native: nativeState(rows, { requestId: request.id }) };
    }
    const footer = section.findIndex((line, index) => /^\s*Enter to select ·/.test(line) &&
      [1, 2, 3].some(count => /^Enter to select · .*Esc to cancel$/.test(lineText(section.slice(index, index + count).join(' ')))));
    const divider = section.findIndex(line => /^\s*─{5,}\s*$/.test(line));
    if (footer < 0 || divider < 0) return null;
    const menu = rows.filter(row => row.index < divider);
    if (menu.length < 3 || menu.some((row, index) => row.value !== String(index + 1))) return null;
    const title = questionText(section.slice(0, menu[0].index).join('\n')).trim();
    const questionIndex = questions.findIndex(q => compact(q.question) === compact(title));
    if (questionIndex < 0) return null;
    const question = questions[questionIndex];
    const multiple = question.multiSelect === true;
    if (menu.length !== question.options.length + 1 || menu.some(row => multiple !== (row.checked !== null))) return null;
    for (let index = 0; index < question.options.length; index++) {
      // Include wrapped label lines, but never use guessed or hidden menu options.
      const next = menu[index + 1].index;
      const candidate = compact([menu[index].label, ...section.slice(menu[index].index + 1, next)].join(''));
      const expected = compact(question.options[index].label + (question.options[index].description || ''));
      if (candidate !== expected) return null;
    }
    const other = menu.at(-1);
    const nextLine = section.findIndex((line, index) => index > other.index && index < divider && /^\s*(?:❯\s*)?(?:Next|Submit)\s*$/.test(line));
    const otherLabel = [other.label, ...section.slice(other.index + 1, nextLine >= 0 ? nextLine : divider).map(line => line.trim())].join('');
    const otherText = /^Type something\.?$/.test(otherLabel) ? '' : otherLabel;
    if (multiple && nextLine < 0) return null;
    const cursor = menu.findIndex(row => row.focused);
    const nextFocused = nextLine >= 0 && /^\s*❯/.test(section[nextLine]);
    if (cursor < 0 && !nextFocused) return null;
    const options = question.options.map((option, index) => ({ value: String(index + 1), label: option.label,
      description: typeof option.description === 'string' ? option.description : '', selected: menu[index].checked === true }));
    options.push({ value: 'other', label: '其他（填写）', selected: other.checked === true });
    return { type: 'question', kind: 'question', supported: true, state: 'ready',
      id: digest([request.id, request.input, questionIndex]), header: question.header || '', text: question.question,
      questionIndex: questionIndex + 1, questionCount: questions.length, multiple, options,
      textInput: { label: '其他答案', placeholder: '填写你的答案', maxLength: 1000, value: otherText },
      actions: [{ value: 'submit', label: questions.length === 1 && !multiple ? '提交回答' : questionIndex + 1 < questions.length ? '下一题' : '确认本题' }, cancel],
      _native: nativeState(menu, { cursor: nextFocused ? menu.length : cursor, otherText,
        next: nextLine >= 0, requestId: request.id }) };
  }
  // Only a visible yes/no permission menu with its native keyboard footer is supported.
  // The associated unresolved tool call distinguishes repeated identical commands.
  if (!request || request.name === 'AskUserQuestion') return null;
  const tail = lines.slice(-70);
  const rows = numberedRows(tail);
  if (rows.filter(row => row.focused).length !== 1 || rows.length < 2 || rows.length > 5 ||
      rows.some((row, index) => row.value !== String(index + 1) || row.checked !== null) ||
      !rows.some(row => /^Yes\b/.test(row.label)) || !rows.some(row => /^No\b/.test(row.label)) ||
      !tail.some(line => /Esc to cancel/.test(line))) return null;
  const title = tail.findLastIndex((line, index) => index < rows[0].index &&
    /^(?:\s*)(?:Do you want to (?:proceed|allow)|Would you like to (?:proceed|allow)|Allow Claude to )/.test(line));
  if (title < 0) return null;
  const target = request.name === 'Bash' ? request.input?.command
    : ['Read', 'Write', 'Edit', 'MultiEdit'].includes(request.name) ? request.input?.file_path
      : request.name === 'WebFetch' ? request.input?.url : null;
  if (typeof target !== 'string' || !target || !compact(tail.slice(0, title).join('\n')).includes(compact(target))) return null;
  const menuText = tail.slice(title, rows.at(-1).index + 1).map(line => lineText(line).replace(/^❯\s*/, '')).filter(Boolean).join('\n');
  const text = `${request.name}\n${JSON.stringify(request.input || {}, null, 2)}\n\n${menuText}`;
  return { type: 'approval', kind: 'approval', supported: true, state: 'ready',
    id: digest([request.id, request.input, compact(text)]), text, multiple: false,
    options: rows.map(row => ({ value: row.value, label: row.label })), actions: [],
    _native: nativeState(rows, { requestId: request.id }) };
}

export function validateClaudeAnswer(prompt, body) {
  if (body.action === 'cancel' && prompt.actions.some(action => action.value === 'cancel')) return { cancel: true };
  if (prompt.type === 'review') {
    if (body.action !== 'submit') throw new Error('请选择提交或取消。');
    return { target: 0 };
  }
  if (prompt.type === 'approval') {
    const target = prompt.options.findIndex(option => option.value === String(body.choice));
    if (target < 0 || body.text !== undefined || body.choices !== undefined) throw new Error('请选择当前显示的权限选项。');
    return { target };
  }
  if (body.action && body.action !== 'submit') throw new Error('此问题不支持该操作。');
  const values = prompt.multiple ? body.choices : [body.choice ?? (body.text ? 'other' : undefined)];
  if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== 'string') ||
      new Set(values).size !== values.length || values.some(value => !prompt.options.some(option => option.value === value))) {
    throw new Error('请选择当前问题中的有效选项。');
  }
  const text = values.includes('other') ? body.text : undefined;
  if (values.includes('other') && (typeof text !== 'string' || !text.trim() || text.length > 1000 || /[\x00-\x1f\x7f]/.test(text))) {
    throw new Error('其他答案需为 1–1000 个字符的单行文字。');
  }
  if (!values.includes('other') && body.text) throw new Error('填写文字时请选择其他答案。');
  if (prompt._native.otherText && text !== undefined && prompt._native.otherText !== text) {
    throw new Error('原生问题中已有不同的文字，请核对后再提交。');
  }
  if (prompt.multiple && prompt._native.otherText && !values.includes('other')) {
    throw new Error('原生多选题中已有其他答案，请核对该文字后再提交。');
  }
  return { values, text, target: prompt.options.findIndex(option => option.value === values[0]) };
}

// The caller serializes the original session. Every key is preceded by a fresh
// read, and every navigation/toggle is checked before another key is emitted.
export async function answerClaudePrompt(original, answer, io) {
  let current = original;
  let sent = false;
  let finalKeyAttempted = false, finalKeySent = false;
  const result = prompt => ({ prompt, keySent: sent, finalKeyAttempted, finalKeySent });
  const unchanged = prompt => {
    if (!prompt || prompt.id !== original.id) throw new Error('当前问题内容已变化，操作已停止。');
    return prompt;
  };
  const state = prompt => JSON.stringify([prompt._native.cursor,
    prompt._native.rows.map(row => row.checked), prompt._native.otherText]);
  async function press(args, final = false) {
    const fresh = unchanged(await io.read());
    if (state(fresh) !== state(current)) throw new Error('原生选项已被其他操作改变，请刷新后核对。');
    sent = true;
    if (final) finalKeyAttempted = true;
    await io.send(args, final);
    if (final) finalKeySent = true;
    await io.pause();
    const after = await io.read();
    if (!final) current = unchanged(after);
    return after;
  }
  async function move(target) {
    while (current._native.cursor !== target) {
      const previous = current._native.cursor;
      const delta = target > previous ? 1 : -1;
      await press(['--named-key', delta > 0 ? 'Down' : 'Up']);
      if (current._native.cursor !== previous + delta) throw new Error('未能确认原生选项位置，操作已停止。');
    }
  }
  async function toggle(target, selected) {
    if (current._native.rows[target].checked === selected) return;
    await move(target);
    await press(['--named-key', 'Space']);
    if (current._native.rows[target].checked !== selected) throw new Error('未能确认原生多选状态，操作已停止。');
  }
  try {
    if (answer.cancel) {
      if (original.type === 'review') { await move(1); return result(await press(['--named-key', 'Enter'], true)); }
      return result(await press(['--named-key', 'Escape'], true));
    }
    if (original.type === 'question' && original.multiple) {
      for (let index = 0; index < original.options.length; index++) {
        const option = original.options[index];
        if (option.value === 'other') continue;
        await toggle(index, answer.values.includes(option.value));
      }
    }
    if (answer.text !== undefined) {
      await move(original.options.length - 1);
      if (!current._native.otherText) {
        await press(['--text', answer.text]);
        if (compact(current._native.otherText) !== compact(answer.text)) throw new Error('未能完整核对其他答案，尚未提交。');
      }
    }
    if (original.type === 'question' && original.multiple) {
      if (current._native.rows.at(-1).checked !== answer.values.includes('other')) {
        throw new Error('未能确认其他答案的勾选状态，尚未提交。');
      }
      await move(original.options.length); // The native Next row, never the adjacent Chat action.
    } else await move(answer.target);
    return result(await press(['--named-key', 'Enter'], true));
  } catch (error) {
    error.keySent = sent;
    error.finalKeyAttempted = finalKeyAttempted;
    error.finalKeySent = finalKeySent;
    throw error;
  }
}
