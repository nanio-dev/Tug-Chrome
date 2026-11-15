import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash,randomBytes} from 'node:crypto';
import {launchHarness,projectRoot} from './browser-test-utils.mjs';

const arg=(key,fallback)=>process.argv.find(a=>a.startsWith(`--${key}=`))?.split('=')[1]??fallback;
const mib=Number(arg('mib','128')),repeats=Number(arg('repeats','3'));
assert.ok(Number.isSafeInteger(mib)&&mib>0&&mib<=1024);
assert.ok(Number.isSafeInteger(repeats)&&repeats>0&&repeats<=10);
const total=mib*1024*1024,block=randomBytes(Math.min(total,8*1024*1024));
const expected=createHash('sha256');for(let at=0;at<total;at+=block.length)expected.update(block.subarray(0,Math.min(block.length,total-at)));
const hash=expected.digest('hex');
const resultsRoot=path.join(projectRoot,'test-results');await fs.mkdir(resultsRoot,{recursive:true});
const temp=await fs.mkdtemp(path.join(resultsRoot,'agent-http-'));
for(const name of ['Downloads','AppData','Tmp'])await fs.mkdir(path.join(temp,name));
let harness,agent;const rows=[];
const server=createServer(async(req,res)=>{
 const range=/bytes=(\d+)-(\d+)/.exec(req.headers.range??'');
 const first=range?Number(range[1]):0,last=range?Math.min(Number(range[2]),total-1):total-1;
 res.writeHead(range?206:200,{'Content-Length':last-first+1,'Content-Range':`bytes ${first}-${last}/${total}`,'ETag':'"agent-http-benchmark"'});
 for(let at=first;at<=last&&!res.destroyed;){const local=at%block.length,n=Math.min(262144,block.length-local,last-at+1);const b=block.subarray(local,local+n);at+=n;if(!res.write(b))await new Promise(resolve=>{const done=()=>{res.off('drain',done);res.off('close',done);resolve();};res.once('drain',done);res.once('close',done);});}
 if(!res.destroyed)res.end();
});
try{
 const exe=arg('agent',path.join(projectRoot,'agent','tug-agent.exe'));
 const started=performance.now();
 agent=spawn(exe,['--serve-only','--native-stdio','--port=0'],{windowsHide:true,env:{...process.env,USERPROFILE:temp,HOME:temp,LOCALAPPDATA:path.join(temp,'AppData'),TEMP:path.join(temp,'Tmp'),TMP:path.join(temp,'Tmp')}});
 let buffer=Buffer.alloc(0),stderr='';agent.stderr.on('data',x=>stderr+=x);
 const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Agent startup timed out: '+stderr)),10000);agent.once('error',e=>{clearTimeout(timer);reject(e);});agent.once('exit',code=>{clearTimeout(timer);reject(Error('Agent exited '+code));});agent.stdout.on('data',x=>{buffer=Buffer.concat([buffer,x]);if(buffer.length>=4&&buffer.length>=4+buffer.readUInt32LE()){clearTimeout(timer);resolve(JSON.parse(buffer.subarray(4,4+buffer.readUInt32LE())));}});});
 const startupMs=performance.now()-started;assert.equal(ready.protocolVersion,2);assert.match(ready.token,/^[a-f0-9]{64}$/);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 process.env.TUG_TEST_TMPDIR=temp;harness=await launchHarness();const page=await harness.openPage();
 for(let repeat=0;repeat<repeats;repeat++)for(const connections of (repeat%2?[32,8]:[8,32])){
  const row=await page.evaluate(async({url,base,token,connections})=>{
   const store=new window.audit.OpfsPartStorage(),key='agent-http-benchmark';const start=performance.now();
   const download=await window.audit.runHttpDownload({url,connections,carryCookies:false,partStore:store,partKey:key,signal:AbortSignal.timeout(60000)});
   const downloadMs=performance.now()-start;const blob=await store.toBlob(key);
   const response=await fetch(base+'/fs/export',{method:'POST',headers:{'X-Tug-Agent-Token':token,'X-Relative-Path':'bench.bin','Content-Type':'application/octet-stream'},body:blob,signal:AbortSignal.timeout(60000)});
   if(!response.ok)throw Error(await response.text());const result=await response.json();const totalMs=performance.now()-start;
   await store.remove(key);return{connections,downloadMs,exportMs:totalMs-downloadMs,totalMs,bytes:download.total,metrics:download.metrics,savedPath:result.savedPath};
  },{url:`http://127.0.0.1:${server.address().port}/payload`,base:ready.baseUrl,token:ready.token,connections});
  const verified=createHash('sha256');for await(const b of createReadStream(row.savedPath))verified.update(b);assert.equal(verified.digest('hex'),hash);
  await fs.unlink(row.savedPath);delete row.savedPath;rows.push({repeat,...row,downloadMiBs:mib*1000/row.downloadMs,exportMiBs:mib*1000/row.exportMs,totalMiBs:mib*1000/row.totalMs,sha256:hash});
  console.log(JSON.stringify(rows.at(-1)));
 }
 await fs.writeFile(path.join(resultsRoot,arg('output','agent-http-benchmark.json')),JSON.stringify({mib,repeats,startupMs,rows},null,2));
 console.log(`Verified ${rows.length} complete downloads and exports. Agent ready: ${startupMs.toFixed(1)} ms.`);
}finally{
 await harness?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 if(agent){agent.kill();if(agent.exitCode===null&&agent.signalCode===null)await once(agent,'exit');}
 assert.equal(path.dirname(temp),resultsRoot);assert.ok(path.basename(temp).startsWith('agent-http-'));await fs.rm(temp,{recursive:true,force:true,maxRetries:3});
}
