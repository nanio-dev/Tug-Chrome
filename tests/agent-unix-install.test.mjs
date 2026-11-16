import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {it} from 'node:test';

it('installs Unix native hosts, reconnects, replaces the old process and fully uninstalls',{skip:process.platform==='win32',timeout:30000},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'tug-unix-'));
 const env={...process.env,HOME:root,XDG_DATA_HOME:path.join(root,'data'),XDG_CONFIG_HOME:path.join(root,'config')};
 const exe=process.env.TUG_TEST_AGENT||path.resolve('agent/target/release/tug-agent');
 const app=process.platform==='darwin'?path.join(root,'Library/Application Support/TugAgent'):path.join(root,'data/tug-agent');
 const browser=process.platform==='darwin'?path.join(root,'Library/Application Support/Google/Chrome'):path.join(root,'config/google-chrome');
 const native=path.join(browser,'NativeMessagingHosts/cc.nanio.tug.agent.json');
 const binary=path.join(app,'tug-agent'),origin='chrome-extension://abcdefghijklmnopabcdefghijklmnop/';
 const wait=async(fn)=>{for(let i=0;i<100;i++){try{const value=await fn();if(value)return value;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('Unix installation did not become ready');};
 let token;
 try{
  await fs.mkdir(browser,{recursive:true});await fs.mkdir(path.join(root,'Downloads'));
  execFileSync(exe,['--install'],{env});
  await wait(async()=>{const response=await fetch('http://127.0.0.1:16899/health');return response.ok;});
  token=await fs.readFile(path.join(app,'auth-token'),'utf8');assert.equal(token.length,64);
  const initialPid=await fs.readFile(path.join(app,'agent.pid'),'utf8');
  const response=await fetch('http://127.0.0.1:16899/register',{method:'POST',headers:{Origin:origin.slice(0,-1),'Content-Type':'application/json'},body:JSON.stringify({extId:'abcdefghijklmnopabcdefghijklmnop'})});assert.equal(response.status,200,await response.clone().text());
  const manifest=JSON.parse(await fs.readFile(native,'utf8'));assert.equal(manifest.path,binary);assert.ok(manifest.allowed_origins.includes(origin));
  assert.equal((await fs.stat(binary)).mode&0o777,0o700);assert.equal((await fs.stat(path.join(app,'auth-token'))).mode&0o077,0);
  const host=spawn(binary,[origin],{env,stdio:['pipe','pipe','pipe']});
  const frame=await new Promise((resolve,reject)=>{let data=Buffer.alloc(0);const timer=setTimeout(()=>reject(Error('Native handshake timeout')),5000);host.on('error',reject);host.stdout.on('data',chunk=>{data=Buffer.concat([data,chunk]);if(data.length>=4&&data.length>=4+data.readUInt32LE()){clearTimeout(timer);resolve(JSON.parse(data.subarray(4,4+data.readUInt32LE())));}});});
  assert.equal(frame.token,token);host.stdin.end();
  execFileSync(exe,['--install'],{env});
  await wait(async()=>(await fs.readFile(path.join(app,'agent.pid'),'utf8'))!==initialPid);
  const exported=await fetch('http://127.0.0.1:16899/fs/export',{method:'POST',headers:{'X-Tug-Agent-Token':token,'X-Relative-Path':'Tug/unix.bin'},body:'unix-export'});assert.equal(exported.status,200,await exported.clone().text());assert.equal(await fs.readFile((await exported.json()).savedPath,'utf8'),'unix-export');
  const removed=await fetch('http://127.0.0.1:16899/uninstall',{method:'POST',headers:{'X-Tug-Agent-Token':token}});assert.equal(removed.status,200,await removed.clone().text());
  assert.equal(await fs.stat(app).then(()=>true,()=>false),false);assert.equal(await fs.stat(native).then(()=>true,()=>false),false);
 }finally{
  if(token)await fetch('http://127.0.0.1:16899/uninstall',{method:'POST',headers:{'X-Tug-Agent-Token':token}}).catch(()=>{});
  await new Promise(r=>setTimeout(r,400));
  assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('tug-unix-'));await fs.rm(root,{recursive:true,force:true});
 }
});
