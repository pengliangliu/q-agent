import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
const exec=promisify(execFile),home=await fs.mkdtemp(path.join(os.tmpdir(),'switch-fixture-'))
process.env.HOME=home
const {handleAccountSessions}=await import('../desktop-files/account-sessions.mjs')
const uuid='beef0000-0000-0000-0000-000000000001', turn='beef0000-0000-0000-0000-000000000002'
const trace=path.join(home,'sessions/2026/01/01/rollout-test-'+uuid+'.jsonl')
await fs.mkdir(path.dirname(trace),{recursive:true})
const row={id:'test-switch-00001',tool:'codex',account:'a',tmux_session:'fixture',resolved_codex_home:home,path:home,transcript_path:trace,codex_session_id:uuid,status:'running'}
let interrupted = false; const events=[], phase=t=>fs.appendFile(trace,JSON.stringify({type:'event_msg',payload:{type:t,turn_id:turn,reason:'interrupted'}})+'\n')
let validLogin=true,natural=false,busyLine='• Working (1s • \x1b[2mesc\x1b[22m to interrupt)\n›\n\n'
const api={deck:'fixture',session:async()=>({...row}),uploads:home,bodyJSON:async req=>req.body,reply:(res,code,body)=>Object.assign(res,{code,body}),
 exec:async(bin,args)=>{
  if(bin==='/usr/bin/python3') return exec(bin,args)
  let value
  if(args[0]==='accounts')value=[{name:'a',config_dir:home},{name:'b',config_dir:path.join(home,'b')}]
  else if(args[0]==='harness')value={accounts:[{name:'b',logged_in:validLogin}]}
  else if(args[1]==='output')value={success:true,session_id:row.id,content:row.status==='running'&&!interrupted?busyLine:'›\n\n'}
  else if(args[1]==='send-keys'){assert(args.includes('Escape'));events.push('interrupt');interrupted=true;await phase(natural?'task_complete':'turn_aborted');value={success:true}}
  else if(args[1]==='set'){if(args[3]==='account'){events.push('switch');row.account=args[4];row.resolved_codex_home=path.join(home,args[4])}else if(args[3]==='wrapper')row.wrapper=args[4];else throw Error('unexpected setting');value={success:true}}
  else if(args[1]==='restart')value={success:true}
  else if(args[1]==='send'){assert.equal(await fs.readFile(args[args.indexOf('--message-file')+1],'utf8'),'继续');assert(args.includes('--require-input-prompt'));events.push('continue');value={success:true,state:'queued',send_id:'test-send-0001'}}
  else throw Error('unexpected native action')
  return {stdout:JSON.stringify(value)}
 }}
global.fetch=async()=>({ok:true,json:async()=>({webMutations:true})})
async function call(name,body){const res={};await handleAccountSessions({method:body?'POST':'GET',headers:{'x-agentdeck-desktop':'1'},body},res,new URL('http://localhost/desktop/accounts/'+name+'?tool=codex&sessionId='+row.id),api);return res}
const input={tool:'codex',sessionId:row.id,slot:'b',from:'a'}
try{
 const reference=path.join(home,'b',path.relative(home,trace));await fs.mkdir(path.dirname(reference),{recursive:true});await fs.writeFile(reference,'previous local record')
 await phase('task_started')
 assert.equal((await call('switch',input)).code,409);assert.deepEqual(events,[])
 const pre=await call('switch-turn');assert.equal(pre.code,200);assert.equal(pre.body.turnId,turn)
 const confirmed={...input,interruptTurn:pre.body}
 validLogin=false;assert.equal((await call('switch',confirmed)).code,409);validLogin=true
 busyLine='• Working (\x1b[2mesc\x1b[22m to interrupt)\n› real draft\n\n';assert.equal((await call('switch',confirmed)).code,409)
 busyLine='• Working (\x1b[2mesc\x1b[22m to interrupt)\n›\n\n';assert.deepEqual(events,[])
 assert.equal((await call('switch',{...input,interruptTurn:{...pre.body,turnId:uuid}})).code,409)
 assert.equal((await call('switch',confirmed)).code,200);assert.deepEqual(events,['interrupt','switch','continue'])
 assert((await fs.lstat(path.join(home,'b',path.relative(home,trace)))).isFile())
 assert.equal((await fs.stat(path.join(home,'b',path.relative(home,trace)))).ino,(await fs.stat(trace)).ino)
 const retained=(await fs.readdir(path.dirname(reference))).find(name=>name.startsWith(path.basename(reference)+'.before-q-agent-'));assert.equal(await fs.readFile(path.join(path.dirname(reference),retained),'utf8'),'previous local record')
 assert.equal((await call('switch',confirmed)).code,409);assert.deepEqual(events,['interrupt','switch','continue'])
 row.account='a';row.status='running';interrupted=false;natural=true;await phase('task_started')
 assert.equal((await call('switch',confirmed)).code,200);assert.deepEqual(events,['interrupt','switch','continue','interrupt','switch'])
 console.log('PASS explicit consent, login/draft/turn checks, one continuation, replay, natural finish')
}finally{await fs.rm(home,{recursive:true,force:true})}
