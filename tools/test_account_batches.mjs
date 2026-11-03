import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'qagent-batch-'));process.env.HOME=temp;
const {handleAccountBatch}=await import('../desktop-files/account-batches.mjs');
const execute=promisify(execFile), rows=new Map(), counts={interrupt:0,switch:0,send:0};
let allowed=true;
for (const [n,status] of [['one','running'],['two','waiting'],['draft','waiting'],['three','stopped']]) {
 const nativeId='beef0000-0000-0000-0000-'+String(rows.size+1).padStart(12,'0');
 const trace=path.join(temp,'sessions/2026/01/01/rollout-'+nativeId+'.jsonl');
 await fs.mkdir(path.dirname(trace),{recursive:true});
 await fs.writeFile(trace,JSON.stringify({type:'event_msg',payload:{type:'task_started',turn_id:nativeId}})+'\n');
 rows.set(n,{id:'fixture-'+n,tool:'codex',title:n,profile:'fixture',status,account:'a',codex_session_id:nativeId,
  transcript_path:trace,tmux_session:'fixture-'+n,resolved_codex_home:temp,path:temp,queue:[]});
}
let hold, release;
const api={
 deck:'fixture',session:async(id,profile)=>{assert(!profile||profile==='fixture');return {...[...rows.values()].find(row=>row.id===id)}},
 reply:(res,code,data)=>Object.assign(res,{code,data}),bodyJSON:async req=>req.body,uploads:temp,
 exec:async(bin,args)=>{
  if(bin==='/usr/bin/python3')return execute(bin,args);
  const argv=args[0]==='-p'?args.slice(2):args;
  const row=[...rows.values()].find(row=>row.id===argv[2]);
  let v;
  if(argv[0]==='list')v=[...rows.values()];
  else if(argv[0]==='harness')v={accounts:[{name:'b',logged_in:true}]};
  else if(argv[0]==='accounts')v=[{name:'a',config_dir:temp},{name:'b',config_dir:path.join(temp,'b')}];
  else if(argv[1]==='output')v={success:true,session_id:row.id,content:row.title==='draft'?'› operator draft\n\n':row.status==='running'?'• Working (\x1b[2mesc\x1b[22m to interrupt)\n›\n\n':'›\n\n'};
  else if(argv[1]==='send-keys'){counts.interrupt++;row.status='waiting';await fs.appendFile(row.transcript_path,JSON.stringify({type:'event_msg',payload:{type:'turn_aborted',turn_id:row.codex_session_id,reason:'interrupted'}})+'\n');v={success:true}}
  else if(argv[1]==='set'){if(argv[3]==='account'){counts.switch++;if(hold)await hold;row.account=argv[4];row.resolved_codex_home=path.join(temp,argv[4])}else if(argv[3]==='wrapper')row.wrapper=argv[4];else throw Error('unexpected setting');v={success:true}}
  else if(argv[1]==='restart')v={success:true}
  else if(argv[1]==='send'){counts.send++;v={success:true,send_id:'fixture-send-00001',state:'queued'}}
  else throw Error('unexpected native call');
  return {stdout:JSON.stringify(v)};
 }
};
global.fetch=async url=>({ok:true,json:async()=>url.endsWith('/api/settings')?{webMutations:allowed}:{profile:'fixture',sessions:[...[...rows.values()].map(r=>({id:r.id,tool:r.tool,title:r.title,status:r.status,archivedAt:'0001-01-01T00:00:00Z',codexSessionId:r.codex_session_id})),{id:'claude-ignored',tool:'claude'}]}});
async function req(action,body){
 const res={};await handleAccountBatch({method:body?'POST':'GET',headers:{'x-agentdeck-desktop':'1'},body},res,new URL('http://localhost/desktop/accounts/batch/'+action),api);return res;
}
const id='beef0000-0000-0000-0000-000000000090';
try{
 const preview=await req('preview?slot=b');assert.equal(preview.code,200);assert.equal(preview.data.items.length,4);assert.deepEqual(counts,{interrupt:0,switch:0,send:0});
 const body={id,slot:'b',revision:preview.data.revision,sessionIds:preview.data.items.map(i=>i.id)};
 allowed=false;assert.equal((await req('start',body)).code,403);allowed=true;
 const start=await req('start',body);assert.equal(start.code,202);
 const again=await req('start',body);assert.equal(again.data.id,id);
 let status;
 for(let i=0;i<100;i++){status=await req('status?id='+id);if(status.data.state!=='running')break;await new Promise(r=>setTimeout(r,30))}
 assert.equal(status.data.state,'done');assert.deepEqual(status.data.items.map(i=>i.state),['succeeded','succeeded','failed','succeeded']);
 assert.deepEqual(counts,{interrupt:1,switch:3,send:1});
 await req('start',body);assert.deepEqual(counts,{interrupt:1,switch:3,send:1});
 assert.equal((await req('start',{...body,slot:'a'})).code,409);
 for(const row of rows.values()){row.account='a';row.status='waiting'}
 const before=await req('preview?slot=b');const second='beef0000-0000-0000-0000-000000000091';
 hold=new Promise(r=>release=r);
 await req('start',{id:second,slot:'b',revision:before.data.revision,sessionIds:before.data.items.map(i=>i.id)});
 for(let i=0;i<100&&counts.switch!==4;i++)await new Promise(r=>setTimeout(r,10));
 await req('stop',{id:second});release();hold=null;
 for(let i=0;i<100;i++){status=await req('status?id='+second);if(status.data.state!=='running')break;await new Promise(r=>setTimeout(r,20))}
 assert.deepEqual(status.data.items.map(i=>i.state),['succeeded','cancelled','cancelled','cancelled']);
 const interrupted={...status.data,id:'beef0000-0000-0000-0000-000000000092',state:'running',items:[{state:'switching'},{state:'queued'}]};
 await fs.writeFile(path.join(temp,'.local/share/agent-deck/chat-receipts/account-batches',interrupted.id+'.json'),JSON.stringify(interrupted));
 const recovered=await req('status?id='+interrupted.id);assert.equal(recovered.data.state,'interrupted');assert.deepEqual(recovered.data.items.map(i=>i.state),['unknown','cancelled']);
 console.log('PASS batch scope, consent, active continuation, draft refusal, stopped assignment, idempotent repeats, stop and restart recovery');
}finally{if(release)release();await fs.rm(temp,{recursive:true,force:true})}
