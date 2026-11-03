import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { handleAccountSessions, native, upstream } from './account-sessions.mjs';

const directory = path.join(os.homedir(), '.local/share/agent-deck/chat-receipts/account-batches');
const active = new Map();
const validId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const file = id => path.join(directory,id+'.json');

async function save(record) {
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const temporary = file(record.id)+'.'+crypto.randomUUID()+'.tmp';
  await fs.writeFile(temporary,JSON.stringify(record),{mode:0o600,flag:'wx'});
  await fs.rename(temporary,file(record.id));
}
async function read(id) {
  if (!validId(id)) throw new Error('批量请求标识无效。');
  const record = JSON.parse(await fs.readFile(file(id),'utf8'));
  if (record.id !== id) throw new Error('批量请求身份不一致。');
  if (record.state === 'running' && active.get(record.profile)?.id !== id) {
    record.state = 'interrupted';
    for (const item of record.items) {
      if (item.state === 'switching') { item.state = 'unknown'; item.message = '切换结果待核对，请查看此会话当前账号。'; }
      if (item.state === 'queued') item.state = 'cancelled';
    }
    await save(record);
  }
  return record;
}
async function prepare(req,api,target) {
  if (typeof target !== 'string' || !target || target.length > 128 || /[\x00-\x1f]/.test(target)) throw new Error('请选择已保存的 Codex 账号。');
  const status = await native(api,['harness','status','codex']);
  if (!status.accounts?.some(account => account.name === target && account.logged_in === true)) throw new Error('目标账号尚未登录，请先完成授权。');
  const inventory = await upstream(req,'/api/sessions');
  if (typeof inventory.profile !== 'string' || !inventory.profile) throw new Error('当前配置尚未确认。');
  const items = inventory.sessions.filter(row => row.tool === 'codex' && (!row.archivedAt || row.archivedAt.startsWith('0001-'))).map(row => ({
    id:row.id,title:row.title,status:row.status,nativeId:row.codexSessionId || '',
  }));
  const nativeRows = await native(api,['-p',inventory.profile,'list']);
  const sessions = items.map(item => {
    const row = nativeRows.find(row => row.id === item.id && row.tool === 'codex');
    if (!row || row.ssh_host || /\b(ssh|mosh|docker|podman)\b/.test((row.command || '')+' '+(row.wrapper || ''))) {
      return {...item,eligible:false,reason:'当前会话无法安全读取。'};
    }
    return {...item,from:row.account || '',nativeId:row.codex_session_id || '',status:row.status,
      eligible:(row.account || '') !== target};
  });
  const revision = hash([inventory.profile,target,sessions.map(row => [row.id,row.from,row.nativeId,row.eligible])]);
  return { tool:'codex',target,profile:inventory.profile,items:sessions,revision };
}
async function call(req,api,route,body) {
  const response = {};
  await handleAccountSessions({ method:'POST',headers:req.headers },response,
    new URL('http://localhost/desktop/accounts/'+route), {
      ...api,bodyJSON:async () => body,reply:(_,code,data) => Object.assign(response,{code,data}),
    });
  return response;
}
async function run(record,req,api) {
  const state = active.get(record.profile);
  const scoped = { ...api,session:id => api.session(id,record.profile) };
  try {
    for (const item of record.items) {
      if (state.stop) { item.state = 'cancelled'; await save(record); continue; }
      item.state = 'switching';
      await save(record);
      try {
        const row = await scoped.session(item.id);
        if (row.tool !== 'codex' || (row.codex_session_id || '') !== item.nativeId) throw new Error('原生对话已变化，请单独核对。');
        if ((row.account || '') === record.target) { item.state = 'skipped'; item.message = '已使用目标账号。'; }
        else {
          if ((row.account || '') !== item.from) throw new Error('会话账号已被其他操作改变。');
          let interruptTurn;
          if (row.status === 'running' || row.hook_status_fresh && row.hook_status === 'running') {
            const response = {};
            await handleAccountSessions({method:'GET',headers:req.headers},response,
              new URL('http://localhost/desktop/accounts/switch-turn?'+new URLSearchParams({tool:'codex',sessionId:item.id})),
              {...scoped,reply:(_,code,data) => Object.assign(response,{code,data})});
            if (response.code !== 200) throw new Error(response.data?.error || '当前回合无法核对。');
            interruptTurn = response.data;
          }
          const result = await call(req,scoped,'switch',{tool:'codex',sessionId:item.id,from:item.from,slot:record.target,
            ...(interruptTurn ? {interruptTurn} : {})});
          if (result.code !== 200 || result.data?.success !== true) throw new Error(result.data?.error || '切换结果未确认。');
          item.state = result.data.destinationPending || result.data.continuationUnconfirmed ? 'partial' : 'succeeded';
          item.message = result.data.destinationPending ? '账号已绑定，原生会话启动结果待核对。' :
            result.data.continuationUnconfirmed ? '账号已切换，接续结果待核对。' :
            result.data.onStart ? '已绑定，下次启动时使用。' : result.data.continuation ? '已切换，接续消息已提交。' : '已切换账号。';
          if (result.data.continuation) item.continuation = result.data.continuation;
        }
      } catch (error) { item.state = 'failed'; item.message = error.message; }
      await save(record);
    }
    record.state = state.stop ? 'cancelled' : 'done';
  } catch {
    record.state = 'interrupted';
    for (const item of record.items) {
      if (item.state === 'switching') item.state = 'unknown';
      if (item.state === 'queued') item.state = 'cancelled';
    }
  } finally {
    try { await save(record); } finally { active.delete(record.profile); }
  }
}
export async function handleAccountBatch(req,res,url,api) {
  const action = /^\/desktop\/accounts\/batch\/(preview|start|status|stop)$/.exec(url.pathname)?.[1];
  if (!action) return false;
  const reply = (code,data) => { api.reply(res,code,data); return true; };
  const get = ['preview','status'].includes(action);
  if (req.headers['x-agentdeck-desktop'] !== '1' || req.method !== (get ? 'GET' : 'POST')) return reply(403,{error:'请从账号管理界面操作。'});
  try {
    const body = get ? Object.fromEntries(url.searchParams) : await api.bodyJSON(req);
    if (action === 'status') return reply(200,await read(body.id));
    if (!get && (await upstream(req,'/api/settings')).webMutations !== true) return reply(403,{error:'当前界面为只读。'});
    if (action === 'stop') {
      const record = await read(body.id), worker = active.get(record.profile);
      if (worker?.id === record.id) worker.stop = true;
      return reply(200,record);
    }
    if (action === 'start') {
      if (!validId(body.id)) throw new Error('批量请求标识无效。');
      const previous = await read(body.id).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (previous) {
        if (previous.target !== body.slot || previous.revision !== body.revision ||
            hash(previous.items.map(item => item.id)) !== hash(body.sessionIds)) throw new Error('同一批量标识不能用于不同操作。');
        return reply(200,previous);
      }
    }
    const plan = await prepare(req,api,body.slot);
    if (action === 'preview') return reply(200,plan);
    if (plan.revision !== body.revision) return reply(409,{error:'会话范围或账号已变化，请刷新列表后重新确认。'});
    if (!Array.isArray(body.sessionIds) || !body.sessionIds.length || new Set(body.sessionIds).size !== body.sessionIds.length ||
        body.sessionIds.some(id => !plan.items.some(item => item.id === id && item.eligible))) throw new Error('请从列表选择要切换的会话。');
    const other = active.get(plan.profile);
    if (other) return reply(409,{error:'当前配置已有批量切换正在进行。',id:other.id});
    const record = { ...plan,id:body.id,state:'running',createdAt:new Date().toISOString(),
      items:body.sessionIds.map(id => ({...plan.items.find(item => item.id === id),state:'queued'})) };
    const worker = {id:record.id,stop:false};
    active.set(record.profile,worker);
    try { await save(record); }
    catch (error) { active.delete(record.profile); throw error; }
    run(record,{headers:{...req.headers}},api).catch(() => {});
    return reply(202,record);
  } catch (error) {
    return reply(error.code === 'ENOENT' ? 404 : 409,{error:error.code ? '批量请求暂时无法读取，请查询原请求。' : error.message});
  }
}
