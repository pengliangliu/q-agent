import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const directory = path.join(os.homedir(), '.local/share/agent-deck/runtime/codex-local');
const filename = id => path.join(directory,crypto.createHash('sha256').update(id).digest('hex')+'.json');
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";

async function load(id) {
  return JSON.parse(await fs.readFile(filename(id),'utf8'));
}
async function save(record) {
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const temporary = filename(record.sessionId)+'.'+crypto.randomUUID()+'.tmp';
  await fs.writeFile(temporary,JSON.stringify(record),{flag:'wx',mode:0o600});
  await fs.rename(temporary,filename(record.sessionId));
}
export async function localCodexHistory(row) {
  if (row.tool !== 'codex') return row;
  const record = await load(row.id).catch(() => null);
  if (record?.sessionId === row.id && record.nativeId === row.codex_session_id) {
    return {...row,transcript_path:record.sourcePath};
  }
  return row;
}

export async function switchLocalCodex(api,row,slot,targetHome,hasPane,native) {
  const run = args => native(api,[...(row.profile ? ['-p',row.profile] : []),...args],90000);
  await api.exec('/usr/bin/python3',[fileURLToPath(new URL('./account-login.py',import.meta.url)),
    'trust-project','codex','--directory',targetHome,'--project',row.path],{timeout:5000});
  const previous = await load(row.id).catch(() => null);
  let record;
  if (row.codex_session_id) {
    const sourcePath = await fs.realpath(row.transcript_path || previous?.sourcePath || '');
    const root = sourcePath.lastIndexOf(path.sep+'sessions'+path.sep);
    if (root < 0 || !sourcePath.endsWith('-'+row.codex_session_id+'.jsonl')) {
      throw new Error('当前本地会话文件尚未就绪，请先打开原会话。');
    }
    const relative = sourcePath.slice(root+1);
    const reference = path.join(targetHome,relative);
    let existing = await fs.lstat(reference).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (existing?.isSymbolicLink() && await fs.realpath(reference) === sourcePath) {
      await fs.unlink(reference);
      existing = null;
    }
    if (existing) {
      const original = await fs.stat(sourcePath);
      if (existing.dev !== original.dev || existing.ino !== original.ino) {
        await fs.rename(reference,reference+'.before-q-agent-'+crypto.randomUUID());
        existing = null;
      }
    }
    if (!existing) {
      await fs.mkdir(path.dirname(reference),{recursive:true,mode:0o700});
      await fs.link(sourcePath,reference);
    }
    const originalWrapper = previous?.managedWrapper === (row.wrapper || '') ? previous.originalWrapper : row.wrapper || '';
    const sqliteHome = previous?.sqliteHome || process.env.CODEX_SQLITE_HOME || sourcePath.slice(0,root);
    const managedWrapper = 'export CODEX_SQLITE_HOME='+quote(sqliteHome)+'; '+(originalWrapper || '{command}');
    record = {sessionId:row.id,nativeId:row.codex_session_id,sourcePath,sqliteHome,originalWrapper,managedWrapper};
    await save(record);
    if (row.wrapper !== managedWrapper) await run(['session','set',row.id,'wrapper',managedWrapper]);
  }
  try {
    await run(['session','set',row.id,'account',slot,'--intended','Q-agent account selection']);
  } catch (error) {
    if (record && row.wrapper !== record.managedWrapper) {
      const current = await api.session(row.id);
      if (current.account === row.account && current.wrapper === record.managedWrapper) {
        await run(['session','set',row.id,'wrapper',row.wrapper || '']);
      }
    }
    throw error;
  }
  if (!hasPane) return {id:row.id,new_account:slot,success:false,status:'pending',pending:true,restarted:false,destination_ready:false};
  const restarted = await run(['session','restart',row.id,'--force']);
  if (!restarted.success) throw new Error('会话未能重新启动，请点击启动会话。');
  return {id:row.id,new_account:slot,success:true,restarted:true,destination_ready:true};
}
