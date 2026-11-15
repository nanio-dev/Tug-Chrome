import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {it} from 'node:test';
import {launchHarness,rpc,waitUntil,projectRoot} from '../../scripts/browser-test-utils.mjs';
it('exports from the real offscreen document and silently recovers lost/rotated credentials',{timeout:30000},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'tug-offscreen-agent-'));for(const n of ['AppData','Tmp'])await fs.mkdir(path.join(root,n));
 const env={...process.env,USERPROFILE:root,HOME:root,LOCALAPPDATA:path.join(root,'AppData'),TMP:path.join(root,'Tmp'),TEMP:path.join(root,'Tmp')};
 const exe=process.env.TUG_TEST_AGENT||path.join(projectRoot,'agent/target/release/tug-agent.exe');
 let child,h;const payload=Buffer.alloc(4*1024*1024,93),hash=createHash('sha256').update(payload).digest('hex');
 const server=createServer((req,res)=>{const m=/bytes=(\d+)-(\d+)/.exec(req.headers.range||''),a=m?Number(m[1]):0,b=m?Number(m[2]):payload.length-1;res.writeHead(m?206:200,{'Content-Length':b-a+1,'Content-Range':`bytes ${a}-${b}/${payload.length}`,'ETag':'"offscreen"'});res.end(payload.subarray(a,b+1));});
 async function start(port){child=spawn(exe,['--serve-only','--native-stdio','--port='+port],{windowsHide:true,env});let buffer=Buffer.alloc(0);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('No Agent ready frame')),5000);child.on('error',reject);child.stdout.on('data',data=>{buffer=Buffer.concat([buffer,data]);if(buffer.length>=4&&buffer.length>=4+buffer.readUInt32LE()){clearTimeout(timer);resolve(JSON.parse(buffer.subarray(4,4+buffer.readUInt32LE())));}});});}
 async function stop(){if(child&&child.exitCode===null){child.kill();await once(child,'exit');}}
 try{
  let ready=await start(0);h=await launchHarness({agentPort:ready.port});const worker=h.context.serviceWorkers()[0];
  await worker.evaluate(token=>{globalThis.integrationToken=token;const fetchOriginal=fetch;globalThis.fetch=(url,init)=>String(url).endsWith('/register')?Promise.resolve(Response.json({ok:true})):fetchOriginal(url,init);
   chrome.downloads.download=async()=>{throw Error('Agent mode unexpectedly fell back to browser saving');};
   chrome.runtime.connectNative=()=>{const callbacks=[];return{onMessage:{addListener:fn=>callbacks.push(fn)},onDisconnect:{addListener:()=>{}},disconnect:()=>{},postMessage:()=>queueMicrotask(()=>callbacks.forEach(fn=>fn({ok:true,protocolVersion:2,token:globalThis.integrationToken}))) };};
  },ready.token);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const p=await h.openPage();await rpc(p,'update_settings',{standaloneMode:false,autoInterceptDownloads:false,notifyOnComplete:false});
  await assert.rejects(rpc(p,'get_agent_credentials'),/private/);
  for(let i=0;i<2;i++){
   if(i){await stop();await fs.unlink(path.join(root,'AppData/TugAgent/auth-token'));ready=await start(ready.port);await worker.evaluate(token=>{globalThis.integrationToken=token;},ready.token);}
   const task=await rpc(p,'add_task',{url:`http://127.0.0.1:${server.address().port}/file-${i}.bin`,connections:1});
   const result=await waitUntil(async()=>{const taskView=(await rpc(p,'list_tasks')).find(t=>t.id===task.id);if(taskView?.state==='failed')throw Error(taskView.error);return taskView?.state==='completed'?taskView:null;});
   assert.ok(path.toNamespacedPath(result.path).startsWith(path.toNamespacedPath(path.join(root,'Downloads'))),result.path);assert.equal(createHash('sha256').update(await fs.readFile(result.path)).digest('hex'),hash);
  }
 }finally{await h?.close();await stop();server.closeAllConnections();await new Promise(r=>server.close(r));assert.ok(path.basename(root).startsWith('tug-offscreen-agent-'));await fs.rm(root,{recursive:true,force:true,maxRetries:3});}
});
