import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleModel } from '../desktop-files/model-controls.mjs';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'q-agent-receipts-'));
process.env.HOME = home;
process.env.XDG_DATA_HOME = path.join(home, 'data');
const profile = 'test', id = 'fixture-session', sendId = '01J00000000000000000000000';
const time = '2026-01-01T12:00:00Z';
const item = { id:sendId, state:'typed', enqueued_at:time };
const row = { id, tool:'codex', profile, status:'waiting', queue:[item] };
let pane = '›\n\n';
const api = {
  session:async () => row, deck:'fixture-deck',
  exec:async (bin,args) => {
    if (bin === '/usr/bin/python3' && args[1] === 'models') return { stdout:JSON.stringify({
      models:[{ value:'gpt-fixture', label:'GPT Fixture', reasoningEfforts:['high'] }], catalogSource:'native',
    }) };
    assert.equal(bin,'fixture-deck'); assert.deepEqual(args,['-p',profile,'session','output',id,'--pane','--primary','--json']);
    return { stdout:JSON.stringify({ success:true, session_id:id, content:pane }) };
  },
  reply:(res,code,body) => Object.assign(res,{code,body}),
};
async function canChange() {
  const res = {};
  await handleModel({ method:'GET', headers:{} },res,new URL('http://localhost/desktop/chat/models?sessionId='+id),api);
  assert.equal(res.code,200); return res.body.canChange;
}
try {
  const directory = path.join(process.env.XDG_DATA_HOME,'agent-deck/profiles',profile,'sendqueue');
  await fs.mkdir(directory,{recursive:true});
  const file = path.join(directory,sendId+'.json');
  const record = { send_id:sendId, session_id:id, created_at:time, state:'typed', settled:true };
  const write = overrides => fs.writeFile(file, JSON.stringify({...record,...overrides}));
  await write({});
  assert.equal(await canChange(),true,'a final typed receipt must not block an idle, empty composer');
  pane = '› operator draft\n\n'; assert.equal(await canChange(),false);
  pane = '• Queued follow-up inputs\n›\n\n'; assert.equal(await canChange(),false);
  pane = '›\n\n';
  row.queue = [item,{state:'queued'}]; assert.equal(await canChange(),false); row.queue = [item];
  for (const invalid of [{settled:false},{session_id:'another-session'},{created_at:'another-time'},{send_id:'another-send'}]) {
    await write(invalid); assert.equal(await canChange(),false);
  }
  await fs.unlink(file); assert.equal(await canChange(),false);
  item.state='submitted'; await write({state:'submitted'}); assert.equal(await canChange(),true);
  console.log('PASS settled receipts, unresolved sends, identity checks, drafts and native queue protection');
} finally { await fs.rm(home,{recursive:true,force:true}); }
