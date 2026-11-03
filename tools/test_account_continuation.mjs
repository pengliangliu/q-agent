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
const trace=path.join(home,'rollout-test-'+uuid+'.jsonl')
const row={id:'test-switch-00001',tool:'codex',account:'a',tmux_session:'fixture',resolved_codex_home:home,path:home,transcript_path:trace,codex_session_id:uuid,status:'running'}
const events=[], phase=t=>fs.appendFile(trace,JSON.stringify({type:'event_msg',payload:{type:t,turn_id:turn,reason:'interrupted'}})+'\n')
let validLogin=true,natural=false,busyLine='• Working (1s • esc to interrupt)\n›\n\n'
const api={deck:'fixture',session:async()=>({...row}),uploads:home,bodyJSON:async req=>req.body,reply:(res,code,body)=>Object.assign(res,{code,body}),
 exec:async(bin,args)=>{
  if(bin==='/usr/bin/python3') return exec(bin,args)
  let value
  if(args[0]==='accounts')value=[{name:'a'},{name:'b'}]
  else if(args[0]==='harness')value={accounts:[{name:'b',logged_in:validLogin}]}
  else if(args[1]==='switch-preview')value={source_tool:'codex',target_harness:'codex',source_account:'a',target_account:'b',source_session_id:uuid,target_account_dir:home,capability:'native-resume',execution:'supported'}
  else if(args[1]==='output')value={success:true,session_id:row.id,content:row.status==='running'?busyLine:'›\n\n'}
  else if(args[1]==='send-keys'){assert(args.includes('Escape'));events.push('interrupt');row.status='waiting';await phase(natural?'task_complete':'turn_aborted');value={success:true}}
  else if(args[1]==='switch'){events.push('switch');row.account='b';value={id:row.id,new_account:'b',success:true,restarted:true,destination_ready:true}}
  else if(args[1]==='send'){assert.equal(await fs.readFile(args[args.indexOf('--message-file')+1],'utf8'),'继续');assert(args.includes('--require-input-prompt'));events.push('continue');value={success:true,state:'queued',send_id:'test-send-0001'}}
  else throw Error('unexpected native action')
  return {stdout:JSON.stringify(value)}
 }}
global.fetch=async()=>({ok:true,json:async()=>({webMutations:true})})
async function call(name,body){const res={};await handleAccountSessions({method:body?'POST':'GET',headers:{'x-agentdeck-desktop':'1'},body},res,new URL('http://localhost/desktop/accounts/'+name+'?tool=codex&sessionId='+row.id),api);return res}
const input={tool:'codex',sessionId:row.id,slot:'b',from:'a'}
try{
 await phase('task_started')
 assert.equal((await call('switch',input)).code,409);assert.deepEqual(events,[])
 const pre=await call('switch-turn');assert.equal(pre.code,200);assert.equal(pre.body.turnId,turn)
 const confirmed={...input,interruptTurn:pre.body}
 validLogin=false;assert.equal((await call('switch',confirmed)).code,409);validLogin=true
 busyLine='• Working (esc to interrupt)\n› real draft\n\n';assert.equal((await call('switch',confirmed)).code,409)
 busyLine='• Working (esc to interrupt)\n›\n\n';assert.deepEqual(events,[])
 assert.equal((await call('switch',{...input,interruptTurn:{...pre.body,turnId:uuid}})).code,409)
 assert.equal((await call('switch',confirmed)).code,200);assert.deepEqual(events,['interrupt','switch','continue'])
 assert.equal((await call('switch',confirmed)).code,409);assert.deepEqual(events,['interrupt','switch','continue'])
 row.account='a';row.status='running';natural=true;await phase('task_started')
 assert.equal((await call('switch',confirmed)).code,200);assert.deepEqual(events,['interrupt','switch','continue','interrupt','switch'])
 console.log('PASS explicit consent, login/draft/turn checks, one continuation, replay, natural finish')
}finally{await fs.rm(home,{recursive:true,force:true})}
