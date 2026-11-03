import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = await fs.mkdtemp(path.join(os.tmpdir(),'qagent-fresh-'));
process.env.HOME = home;
const {send,handleChat} = await import('../desktop-files/chat-backend.mjs');
const row = {id:'fixture-new-codex',tool:'codex',status:'running',path:home,queue:[]};
let pane = '› \x1b[2mAsk Codex to do anything\x1b[0m\n\n', direct = 0, queued = 0, observed = false, typedOnly = false;
const text = 'fixture first message';
const api = {deck:'fixture',uploads:home,session:async()=>row,reply:(r,code,body)=>Object.assign(r,{code,body}),
 exec:async(file,args)=>{
  if(file==='/usr/bin/python3')return {stdout:JSON.stringify({messages:observed ? [
   {id:'fixture:1',role:'user',text,timestamp:new Date().toISOString()},
  ] : []})};
  if(args[1]==='output')return {stdout:JSON.stringify({success:true,content:pane})};
  assert.equal(args[1],'send');assert(args.includes('--require-input-prompt'));
  if(args.includes('--queue')){queued++;assert(!args.includes('--codex-composer-fallback'));return {stdout:JSON.stringify({success:true,state:'queued',send_id:'fixture-queued-send'})}}
  direct++;assert(args.includes('--no-wait'));assert(args.includes('--codex-composer-fallback'));
  assert.equal(await fs.readFile(args[args.indexOf('--message-file')+1],'utf8'),text);
  return {stdout:JSON.stringify(typedOnly ? {success:false,submitted:false,delivery:'typed_not_submitted'} : {success:true,submitted:true,delivery:'submitted'})};
 }};
try {
 const input = {sessionId:row.id,clientId:'fixture-first-message',text};
 assert.equal((await send(input,api)).status,'submitted');
 await send(input,api);assert.equal(direct,1,'the same receipt must never send twice');
 observed = true;
 const response = {};
 await handleChat({method:'GET'},response,new URL('http://localhost/desktop/chat/send-status?'+new URLSearchParams(input)),api);
 assert.equal(response.body.observedInHistory,true);
  assert.equal(response.body.status,'landed');assert.equal(response.body.requestActive,false);
 pane = '› operator draft\n\n';
 await send({...input,clientId:'fixture-with-draft'},api);
 pane = '• Working (esc to interrupt)\n›\n\n';
 await send({...input,clientId:'fixture-busy-turn'},api);
 pane = '›\n\n';row.queue=[{state:'queued'}];
 await send({...input,clientId:'fixture-existing-queue'},api);
 assert.equal(direct,1);assert.equal(queued,3);
 row.queue=[];typedOnly=true;const delayed={...input,clientId:'fixture-delayed-accept'};assert.equal((await send(delayed,api)).status,'typed');await send(delayed,api);assert.equal(direct,2);row.transcript_path=path.join(home,'first-rollout.jsonl');await fs.writeFile(row.transcript_path,'new native record');
 const accepted={};await handleChat({method:'GET'},accepted,new URL('http://localhost/desktop/chat/send-status?'+new URLSearchParams(delayed)),api);assert.equal(accepted.body.status,'landed');assert.equal(accepted.body.success,true);
 console.log('PASS fresh Codex delivery, receipt replay, history confirmation, draft, busy turn and queue protection');
} finally { await fs.rm(home,{recursive:true,force:true}); }
