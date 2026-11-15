import assert from 'node:assert/strict';
import {it} from 'node:test';
import {cacheAgentPackage} from '../src/shared/agent-package.ts';
it('downloads the installer once and saves only cached bytes through a stable blob URL',async()=>{
 let calls=0;const bytes=new Uint8Array([77,90,1,2,3]);
 const result=await cacheAgentPackage('https://tug.nanio.cc/downloads/tug-agent.exe?t=123',()=>{},async(url,options)=>{assert.equal(url,'https://tug.nanio.cc/downloads/tug-agent.exe?t=123');assert.equal(options?.cache,'no-store');calls++;return new Response(bytes,{headers:{'content-length':'5'}});});
 try{assert.match(result.blobUrl,/^blob:/);for(let i=0;i<2;i++)assert.deepEqual(new Uint8Array(await(await fetch(result.blobUrl)).arrayBuffer()),bytes);assert.equal(calls,1);}finally{URL.revokeObjectURL(result.blobUrl);}
});
it('does not export an incomplete installer cache',async()=>{
 await assert.rejects(cacheAgentPackage('https://tug.nanio.cc/downloads/tug-agent.exe?t=123',()=>{},async()=>new Response('MZ',{headers:{'content-length':'5'}})),/incomplete/);
});
it('rejects Agent packages outside the official HTTPS download endpoint',async()=>{
 for(const url of ['http://tug.nanio.cc/downloads/tug-agent.exe','https://example.com/downloads/tug-agent.exe','https://tug.nanio.cc/other.exe']){
  await assert.rejects(cacheAgentPackage(url,()=>{},async()=>{throw Error('Unexpected network request');}),/Invalid Agent download URL/);
 }
});
