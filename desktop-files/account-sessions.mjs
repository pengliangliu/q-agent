import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { acquireNativeControl, hasPendingSend, nativeComposer } from './native-controls.mjs';
import { manualLogin } from './manual-login.mjs';
import { send } from './chat-backend.mjs';
import { interruptibleCodex } from './deliver-now-control.mjs';

const helper = fileURLToPath(new URL('./account-login.py', import.meta.url));
const tools = ['claude', 'codex'];
const plain = (value, max) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
export async function native(api, args, timeout = 20000) {
  const { stdout } = await api.exec(api.deck, [...args, '--json'], { timeout, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout);
}
export async function upstream(req, route) {
  const headers = {};
  for (const key of ['authorization','cookie']) if (req.headers[key]) headers[key] = req.headers[key];
  const response = await fetch('http://127.0.0.1:8420' + route, { headers, signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error('upstream refused');
  return response.json();
}
const prefix = row => row.profile ? ['-p', row.profile] : [];
const rowAccount = row => typeof row.account === 'string' ? row.account : '';
async function slots(api, tool) {
  return native(api, ['accounts', '--harness', tool]);
}
async function preview(api, row, slot) {
  const args = [...prefix(row), 'session','switch-preview',row.id,'--to-harness',row.tool,'--max-chars','1'];
  if (slot) args.push('--to-account=' + slot);
  try { return await native(api, args); }
  catch (error) {
    // The CLI returns a structured refusal with exit 1.
    if (error.stdout) { const value = JSON.parse(error.stdout); if (value.refusal) return value; }
    throw error;
  }
}
async function busy(row) {
  return !['waiting','idle','stopped'].includes(row.status) || row.hook_status_fresh && row.hook_status === 'running' ||
    /permission|approval|user-input|blocked/.test(row.substate || '') ||
    hasPendingSend(row);
}
async function codexTurn(api,row) {
  const { stdout } = await api.exec('/usr/bin/python3',[path.join(path.dirname(helper),'chat-history.py'),JSON.stringify({
    codexTurnOnly:true, tool:'codex', path:row.transcript_path, nativeId:row.codex_session_id, codexHome:row.resolved_codex_home,
  })],{timeout:8000});
  return JSON.parse(stdout);
}
async function codexDestinationReady(api,row,home) {
  if (!home || row.resolved_codex_home !== home || !row.tmux_session) return false;
  try {
    const { stdout } = await api.exec('tmux',['-L',row.tmux_socket_name || 'agent-deck','list-panes',
      '-t',row.tmux_session+':0','-F','#{pane_pid}'],{timeout:3000,maxBuffer:16384});
    const root = Number(stdout.trim().split('\n')[0]);
    if (!Number.isSafeInteger(root) || root < 2) return false;
    const pending = [root];
    for (let count = 0; pending.length && count < 64; count++) {
      const pid = pending.shift(), proc = '/proc/'+pid;
      try {
        const before = await fs.readFile(proc+'/stat','utf8');
        const executable = await fs.readlink(proc+'/exe');
        if (path.basename(executable) === 'codex') {
          const env = (await fs.readFile(proc+'/environ','utf8')).split('\0');
          const args = (await fs.readFile(proc+'/cmdline','utf8')).split('\0');
          const after = await fs.readFile(proc+'/stat','utf8');
          const start = text => text.slice(text.lastIndexOf(')')+1).trim().split(/\s+/)[19];
          if (start(before) === start(after) && env.includes('CODEX_HOME='+home) &&
              args.includes('resume') && args.includes(row.codex_session_id)) return true;
        }
        const children = await fs.readFile(proc+'/task/'+pid+'/children','utf8');
        pending.push(...children.trim().split(/\s+/).map(Number).filter(n => Number.isSafeInteger(n) && n > 1));
      } catch { /* A process may exit while the native switch is starting. */ }
    }
  } catch { /* Retry while the native pane is starting. */ }
  return false;
}
async function endedCodexTurn(api,row,confirmation) {
  if (row.tool !== 'codex' || row.codex_session_id !== confirmation.nativeId ||
      !['running','waiting','idle'].includes(row.status) || /approval|permission|menu|question/.test(row.substate || '') ||
      await hasPendingSend(row)) return null;
  const turn = await codexTurn(api,row);
  if (turn.turnId !== confirmation.turnId || !['task_complete','turn_aborted'].includes(turn.state)) return null;
  const pane = await native(api,[...prefix(row),'session','output',row.id,'--pane','--primary']);
  return pane.success && nativeComposer('codex',pane.content) ? turn : null;
}
async function finishConfirmedTurn(api, initial, confirmation) {
  const same = row => row.tool === 'codex' && !row.ssh_host && rowAccount(row) === rowAccount(initial) &&
    row.codex_session_id === confirmation.nativeId && row.tmux_session === initial.tmux_session;
  const current = await api.session(initial.id);
  if (!same(current) || await hasPendingSend(current)) throw new Error('changed');
  const pane = await native(api,[...prefix(current),'session','output',current.id,'--pane','--primary']);
  let turn = await codexTurn(api,current);
  if (turn.turnId !== confirmation.turnId) throw new Error('changed');
  const interrupt = turn.state === 'task_started';
  if (interrupt) {
    if (!pane.success || !interruptibleCodex(current,pane.content)) throw new Error('unsafe composer');
    const key = await native(api,[...prefix(current),'session','send-keys',current.id,'--named-key','Escape','--primary']);
    if (!key.success) throw new Error('unconfirmed interrupt');
  } else if (turn.state !== 'task_complete') throw new Error('changed');
  const deadline = Date.now() + 15000;
  do {
    const row = await api.session(initial.id);
    if (!same(row) || !['running','waiting','idle'].includes(row.status) || await hasPendingSend(row)) throw new Error('changed');
    turn = await endedCodexTurn(api,row,confirmation);
    if (turn) {
      if (turn.state === 'task_complete') return false;
      if (interrupt && turn.state === 'turn_aborted' && turn.reason === 'interrupted') return true;
    }
    await new Promise(resolve => setTimeout(resolve,300));
  } while (Date.now() < deadline);
  throw new Error('unconfirmed interrupt');
}

async function continueSwitchedTurn(api,actual,confirmation,targetHome) {
  const deadline = Date.now() + 20000;
  let row = actual;
  do {
    if (row.tool !== 'codex' || row.ssh_host || row.account !== actual.account ||
        row.codex_session_id !== confirmation.nativeId || !targetHome || row.resolved_codex_home !== targetHome ||
        ['stopped','error'].includes(row.status) || await hasPendingSend(row)) throw new Error('destination changed');
    const turn = await codexTurn(api,row);
    if (turn.turnId && turn.turnId !== confirmation.turnId) return; // Already advanced on the destination.
    if (turn.turnId === confirmation.turnId && turn.state === 'turn_aborted' && turn.reason === 'interrupted' &&
        !/approval|permission|menu|question/.test(row.substate || '')) {
      const pane = await native(api,[...prefix(row),'session','output',row.id,'--pane','--primary']);
      if (pane.success && nativeComposer('codex',pane.content)) {
        return send({sessionId:row.id,clientId:'switch-continue-'+confirmation.turnId,text:'继续'},api,row);
      }
    }
    await new Promise(resolve => setTimeout(resolve,500));
    row = await api.session(actual.id);
  } while (Date.now() < deadline);
  throw new Error('destination not ready');
}
export async function handleAccountSessions(req, res, url, api) {
  const route = url.pathname;
  const manual = /^\/desktop\/accounts\/manual\/(start|status|submit|cancel)$/.exec(route)?.[1];
  const get = ['/desktop/accounts/slots','/desktop/accounts/current','/desktop/accounts/switch-turn'].includes(route);
  if (!manual && !get && !['/desktop/accounts/add','/desktop/accounts/create-session','/desktop/accounts/switch'].includes(route)) return false;
  const reply = (code, data) => { api.reply(res,code,data); return true; };
  if (req.headers['x-agentdeck-desktop'] !== '1' || req.method !== (get ? 'GET' : 'POST')) return reply(403,{error:'请从本机账号管理界面操作。'});
  try {
    const body = get ? Object.fromEntries(url.searchParams) : await api.bodyJSON(req);
    if (!get && manual !== 'status' && manual !== 'cancel' && (await upstream(req,'/api/settings')).webMutations !== true) return reply(403,{error:'当前界面为只读。'});
    if (manual) {
      try { return reply(200, manualLogin(manual,body)); }
      catch (error) {
        const allowed = ['login-busy','invalid-account','login-expired','not-waiting-for-code','invalid-code'];
        return reply(409,{error:allowed.includes(error.message) ? error.message : 'manual-login-unavailable'});
      }
    }
    const tool = body.tool;
    if (!tools.includes(tool)) return reply(400,{error:'请选择 Claude 或 Codex。'});
    if (route.endsWith('/add')) {
      if (!plain(body.slot,48)) return reply(400,{error:'请输入有效账号名。'});
      try { await api.exec('/usr/bin/python3',[helper,'add',tool,'--slot='+body.slot,...(body.bindDefault === true ? ['--bind-default'] : [])],{timeout:25000}); }
      catch (error) {
        const safe = ['默认账号目录尚不存在，请先登录。','此助手已存在同名账号配置。','此名称已用于 Agent Deck 会话配置，请换一个账号名。','账号目录已存在，请换一个账号名。','账号名须以字母、汉字或数字开头，最多 48 字，不能使用 default。'];
        const message = error.stderr?.trim();
        return reply(409,{error:safe.includes(message) ? message : '账号配置未能保存，请刷新后核对。'});
      }
      return reply(200,{success:true});
    }
    const choices = await slots(api, tool);
    if (route.endsWith('/slots')) return reply(200,{slots:choices.map(c => c.name)});
    if (!get && (!plain(body.slot,128) || !choices.some(c => c.name === body.slot))) return reply(400,{error:'请选择已保存的目标账号。'});
    if (route.endsWith('/create-session')) {
      if (!body.slot || !plain(body.title,200) || !body.title.trim() || !plain(body.projectPath,4096) || !body.projectPath ||
          ['groupPath','modelId','reasoningEffort'].some(key => body[key] !== undefined && !plain(body[key],512))) return reply(400,{error:'请核对会话名称、项目目录和账号。'});
      const dir = await upstream(req,'/api/session-directory?path=' + encodeURIComponent(body.projectPath));
      if (!path.isAbsolute(dir.path) || !Array.isArray(dir.missing)) throw new Error('invalid project');
      if (dir.missing.length && (!body.createDir || !Array.isArray(body.createDirPaths) || dir.missing.some(p => !body.createDirPaths.includes(p)))) return reply(409,{error:'目录发生变化，请重新确认要创建的目录。'});
      const inventory = await upstream(req,'/api/sessions');
      if (!plain(inventory.profile,128) || !inventory.profile) throw new Error('missing web profile');
      const profile = ['-p',inventory.profile];
      const args = [...profile,'add',dir.path,'--no-parent','--cmd='+tool,'--title='+body.title,'--account='+body.slot];
      if (dir.missing.length) args.push('--create-dir');
      for (const [key, flag] of [['groupPath','group'],['modelId','model'],['reasoningEffort','effort']]) if (body[key]) args.push('--'+flag+'='+body[key]);
      const created = await native(api,args);
      if (!created.success || !created.id) throw new Error('missing create receipt');
      try {
        const row = await native(api,[...profile,'session','show',created.id]);
        if (row.id !== created.id || row.tool !== tool || rowAccount(row) !== body.slot) throw new Error('wrong binding');
        const start = await native(api,[...profile,'session','start',row.id],90000);
        if (!start.success) throw new Error('failed to start');
      } catch { return reply(200,{sessionId:created.id,startPending:true}); }
      return reply(200,{sessionId:created.id});
    }
    const row = await api.session(body.sessionId);
    if (row.tool !== tool || row.ssh_host) return reply(409,{error:'账号仅适用于此助手的本机原生会话。'});
    const account = rowAccount(row);
    if (route.endsWith('/switch-turn')) {
      if (tool !== 'codex' || !row.codex_session_id) return reply(409,{error:'无法核对当前 Codex 回合。'});
      const turn = await codexTurn(api,row);
      if (turn.state !== 'task_started' || !plain(turn.turnId,100) || !turn.turnId) return reply(409,{error:'当前回合已变化，请刷新聊天后切换。'});
      return reply(200,{turnId:turn.turnId,nativeId:row.codex_session_id});
    }
    if (get) {
      let label = account;
      if (!account && choices.length) {
        const info = await preview(api, row, '');
        const inherited = choices.filter(c => c.config_dir === info.source_account_dir);
        if (inherited.length === 1) label = inherited[0].name;
      }
      return reply(200, {account, label, slots:choices.map(c => c.name)});
    }
    const release = acquireNativeControl(row.id);
    if (!release) return reply(409,{error:'会话有其他操作正在进行。'});
    try {
      const fresh = await api.session(row.id);
      if (fresh.tool !== tool || fresh.ssh_host || rowAccount(fresh) !== body.from || body.from === body.slot) return reply(409,{error:'会话账号已变化，请重新核对。'});
      const confirmation = body.interruptTurn;
      if (confirmation && (tool !== 'codex' || !plain(confirmation.turnId,100) || !confirmation.turnId ||
          !fresh.codex_session_id || confirmation.nativeId !== fresh.codex_session_id)) return reply(409,{error:'请重新确认要中断的 Codex 回合。'});
      if (!confirmation && await busy(fresh)) return reply(409,{error:'请等待当前回答、队列或交互完成后切换。'});
      const harness = await native(api, ['harness', 'status', tool]);
      if (!harness.accounts?.some(entry => entry.name === body.slot && entry.logged_in === true)) {
        return reply(409, {error:'目标账号尚未检测到登录，请先在设置的账号管理中完成授权。'});
      }
      const info = await preview(api,fresh,body.slot);
      if (info.refusal || info.source_tool !== tool || info.target_harness !== tool || info.source_account !== body.from || info.target_account !== body.slot ||
          info.capability !== 'native-resume' || info.execution !== 'supported') return reply(409,{error:'原生程序无法安全恢复此对话，切换已停止。'});
      if (!info.source_session_id || !(tool === 'codex' ? fresh.codex_session_id : fresh.claude_session_id)) {
        return reply(409,{error:'此会话尚未记录原生对话 ID，请先启动并完成一轮对话。'});
      }
      let resume = false;
      if (confirmation) {
        if (info.source_session_id !== confirmation.nativeId) return reply(409,{error:'原生对话身份已变化。'});
        try { resume = await finishConfirmedTurn(api,fresh,confirmation); }
        catch (error) {
          const reasons = {
            changed:'原回合、账号或队列已变化，请刷新当前对话后重试。',
            'unsafe composer':'原生输入框有草稿、排队消息或确认选项，请先处理。',
            'unconfirmed interrupt':'中断结果尚未确认，请刷新当前对话后核对。',
          };
          return reply(409,{error:reasons[error.message] || '中断操作未完成，请刷新当前对话后核对。'});
        }
      }
      const latest = await api.session(row.id);
      const ended = confirmation && await endedCodexTurn(api,latest,confirmation);
      if (latest.tool !== tool || latest.ssh_host || rowAccount(latest) !== body.from || (await busy(latest) && !ended) ||
          fresh.claude_session_id !== latest.claude_session_id || fresh.codex_session_id !== latest.codex_session_id) return reply(409,{error:'会话状态发生变化，请重新核对。'});
      let hasPane = latest.status === 'waiting' || Boolean(ended);
      if (latest.status === 'idle' && latest.tmux_session) {
        try { await api.exec('tmux',['-L',latest.tmux_socket_name || 'agent-deck','has-session','-t','='+latest.tmux_session],{timeout:3000}); hasPane = true; }
        catch (error) { if (!/can.t find session|no server running|No such file/i.test(error.stderr || '')) throw error; }
      }
      if (hasPane) {
        const pane = await native(api,[...prefix(latest),'session','output',latest.id,'--pane','--primary']);
        if (!pane.success || !nativeComposer(tool,pane.content)) return reply(409,{error:'请先处理原生输入框中的草稿或确认。'});
      }
      const args = [...prefix(fresh),'session','switch',fresh.id,'--to-harness',tool,'--no-settle'];
      if (body.slot) args.push('--to-account='+body.slot);
      const result = await native(api,args,120000);
      let actual = await api.session(fresh.id);
      const onStart = result.status === 'pending' && result.pending === true && result.restarted === false && result.destination_ready === false;
      const pendingRestart = tool === 'codex' && result.status === 'pending' && result.pending === true && result.restarted === true;
      if (result.id !== fresh.id || result.new_account !== body.slot || rowAccount(actual) !== body.slot ||
          actual.tool !== tool || !(result.success || onStart || pendingRestart)) return reply(409,{error:'切换结果待核对，请查看当前账号和会话状态。'});
      if (pendingRestart) {
        const deadline = Date.now()+20000;
        let ready = false;
        do {
          if (actual.account !== body.slot || actual.codex_session_id !== latest.codex_session_id || ['error','stopped'].includes(actual.status)) break;
          ready = await codexDestinationReady(api,actual,info.target_account_dir);
          if (ready) break;
          await new Promise(resolve => setTimeout(resolve,500));
          actual = await api.session(fresh.id);
        } while (Date.now() < deadline);
        if (rowAccount(actual) !== body.slot || actual.codex_session_id !== latest.codex_session_id) {
          return reply(409,{error:'目标账号或对话已被其他操作改变，请刷新核对。'});
        }
        if (!ready) return reply(200,{success:true,account:rowAccount(actual),destinationPending:true,continuationUnconfirmed:resume});
      }
      if (resume) {
        let continuation;
        try {
          if (result.restarted !== true || !(result.destination_ready || pendingRestart) || actual.codex_session_id !== confirmation.nativeId) throw new Error('not ready');
          continuation = await continueSwitchedTurn(api,actual,confirmation,info.target_account_dir);
        } catch { return reply(200,{success:true,account:rowAccount(actual),continuationUnconfirmed:true}); }
        return reply(200,{success:true,account:rowAccount(actual),continuation,onStart,
          continuationUnconfirmed:!!continuation && !continuation.sendId});
      }
      return reply(200,{success:true,account:rowAccount(actual),onStart});
    } finally { release(); }
  } catch { return reply(409,{error:get ? '暂时无法读取账号配置。' : '原生操作未确认完成，请刷新账号或会话列表核对。'}); }
}
