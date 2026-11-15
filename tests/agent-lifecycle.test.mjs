import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {it} from 'node:test';
const exe=process.env.TUG_TEST_AGENT||path.resolve('agent/target/debug/tug-agent.exe');
async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'tug-lifecycle-'));for(const d of ['AppData','Tmp'])await fs.mkdir(path.join(root,d));return{root,env:{...process.env,LOCALAPPDATA:path.join(root,'AppData'),USERPROFILE:root,HOME:root,TMP:path.join(root,'Tmp'),TEMP:path.join(root,'Tmp')}};}
async function ready(child){let buffer=Buffer.alloc(0);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('No native ready')),5000);child.once('error',reject);child.stdout.on('data',d=>{buffer=Buffer.concat([buffer,d]);if(buffer.length>=4&&buffer.length>=4+buffer.readUInt32LE()){clearTimeout(timer);resolve(JSON.parse(buffer.subarray(4,4+buffer.readUInt32LE())));}});});}
async function cleanup(f){assert.ok(path.basename(f.root).startsWith('tug-lifecycle-'));assert.equal(path.dirname(f.root),os.tmpdir());await fs.rm(f.root,{recursive:true,force:true,maxRetries:12,retryDelay:300});}
it('exits when idle even with native stdin open and repeated health checks',{timeout:10000},async()=>{
 const f=await fixture();const child=spawn(exe,['--serve-only','--native-stdio','--port=0','--idle-timeout=2'],{env:f.env,windowsHide:true});const exited=once(child,'exit');
 try{const info=await ready(child);const start=Date.now();let checks=0;while(child.exitCode===null&&Date.now()-start<6000){try{await fetch(info.baseUrl+'/health');checks++;}catch{}await new Promise(r=>setTimeout(r,250));}await exited;assert.ok(checks>1);assert.ok(Date.now()-start<5000);}finally{if(child.exitCode===null)child.kill();await cleanup(f);}
});
it('replaces only its isolated old Agent, migrates to AppData and removes the installer',{timeout:15000,skip:process.platform!=='win32'},async()=>{
 const f=await fixture(),dir=path.join(f.env.LOCALAPPDATA,'TugAgent');await fs.mkdir(dir);const target=path.join(dir,'tug-agent.exe'),installer=path.join(f.root,'tug-agent-abcdefghijklmnopabcdefghijklmnop.exe');await fs.copyFile(exe,target);await fs.copyFile(exe,installer);
 const old=spawn(target,['--serve-only','--native-stdio','--port=0','--idle-timeout=600'],{env:f.env,windowsHide:true});const oldExited=once(old,'exit');
 try{await ready(old);const launch=spawn(installer,['--isolated-install','--port=0','--idle-timeout=2'],{env:f.env,windowsHide:true});const [code]=await once(launch,'exit');assert.equal(code,0);await oldExited;
 let log='';for(let i=0;i<40;i++){log=await fs.readFile(path.join(dir,'startup.log'),'utf8');if([...log.matchAll(/Listening on (\d+),/g)].length>=2)break;await new Promise(r=>setTimeout(r,100));}
 const ports=[...log.matchAll(/Listening on (\d+),/g)];assert.equal(ports.length,2,log);const base='http://127.0.0.1:'+ports.at(-1)[1];assert.equal((await(await fetch(base+'/health')).json()).protocolVersion,2);
 for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,100));try{await fetch(base+'/health');}catch{break;}}
 assert.equal(await fs.stat(installer).then(()=>true,()=>false),false);assert.ok(log.includes(target));
 }finally{if(old.exitCode===null)old.kill();await new Promise(r=>setTimeout(r,1000));await cleanup(f);}
});
it('keeps an active slow export alive and exits after the operation becomes idle',{timeout:12000},async()=>{
 const f=await fixture();const child=spawn(exe,['--serve-only','--native-stdio','--port=0','--idle-timeout=2'],{env:f.env,windowsHide:true});const exited=once(child,'exit');
 try{const info=await ready(child);let count=0;
 const stream=new ReadableStream({async pull(controller){await new Promise(r=>setTimeout(r,600));if(count++<5)controller.enqueue(new Uint8Array([count]));else controller.close();}});
 const response=await fetch(info.baseUrl+'/fs/export',{method:'POST',duplex:'half',headers:{'X-Tug-Agent-Token':info.token,'X-Relative-Path':'active.bin','Content-Type':'application/octet-stream'},body:stream});assert.equal(response.status,200,await response.clone().text());const output=await response.json();assert.deepEqual(await fs.readFile(output.savedPath),Buffer.from([1,2,3,4,5]));
 await Promise.race([exited,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('Agent did not exit after export')),5000);t.unref();})]);
 }finally{if(child.exitCode===null)child.kill();await cleanup(f);}
});
it('uninstalls its running AppData image and confirms directory and temporary image removal',{timeout:15000,skip:process.platform!=='win32'},async()=>{
 const f=await fixture(),dir=path.join(f.env.LOCALAPPDATA,'TugAgent');await fs.mkdir(dir);const target=path.join(dir,'tug-agent.exe');await fs.copyFile(exe,target);
 const child=spawn(target,['--serve-only','--native-stdio','--port=0'],{env:f.env,windowsHide:true});const exited=once(child,'exit');
 try{const info=await ready(child);const response=await fetch(info.baseUrl+'/uninstall',{method:'POST',headers:{'X-Tug-Agent-Token':info.token}});assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).ok,true);assert.equal(await fs.stat(dir).then(()=>true,()=>false),false,'Must remove AppData before reporting success');await exited;
 const trash=path.join(f.env.LOCALAPPDATA,'.TugAgent-remove-'+child.pid);for(let i=0;i<60;i++){if(!await fs.stat(trash).then(()=>true,()=>false))break;await new Promise(r=>setTimeout(r,100));}assert.equal(await fs.stat(trash).then(()=>true,()=>false),false,'Temporary executable must be removed too');
 }finally{if(child.exitCode===null)child.kill();await cleanup(f);}
});
