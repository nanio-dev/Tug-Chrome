import assert from 'node:assert/strict';
import {it} from 'node:test';
import {cacheAgentPackage,getAgentPackage,AGENT_PACKAGES} from '../src/shared/agent-package.ts';
it('downloads the installer once and saves only cached bytes through a stable blob URL',async()=>{
 let calls=0;const bytes=new Uint8Array([77,90,1,2,3]);
 const result=await cacheAgentPackage('https://tug.nanio.cc/downloads/tug-agent.exe?t=123',()=>{},async(url,options)=>{assert.equal(url,'https://tug.nanio.cc/downloads/tug-agent.exe?t=123');assert.equal(options?.cache,'no-store');calls++;return new Response(bytes,{headers:{'content-length':'5'}});});
 try{assert.match(result.blobUrl,/^blob:/);for(let i=0;i<2;i++)assert.deepEqual(new Uint8Array(await(await fetch(result.blobUrl)).arrayBuffer()),bytes);assert.equal(calls,1);}finally{URL.revokeObjectURL(result.blobUrl);}
});
it('selects native installers by OS and CPU, without sending Unix users an EXE',async()=>{
 for(const arch of ['x86-64','arm64'])assert.equal(getAgentPackage({os:'mac',arch}).filename,'tug-agent-macos-universal.zip');
 assert.equal(getAgentPackage({os:'win',arch:'x86-64'}).filename,'tug-agent.exe');
 assert.equal(getAgentPackage({os:'linux',arch:'x86-64'}).filename,'tug-agent-linux-x64.tar.gz');
 assert.equal(getAgentPackage({os:'linux',arch:'arm64'}).filename,'tug-agent-linux-arm64.tar.gz');
 for(const platform of [{os:'cros',arch:'x86-64'},{os:'linux',arch:'x86-32'},{os:'linux',arch:'arm'}])assert.throws(()=>getAgentPackage(platform),/not available/);
 for(const pkg of Object.values(AGENT_PACKAGES)){
  const result=await cacheAgentPackage(pkg.url+'?t=123',()=>{},async()=>new Response('archive'));
  URL.revokeObjectURL(result.blobUrl);
 }
});
it('does not export an incomplete installer cache',async()=>{
 await assert.rejects(cacheAgentPackage('https://tug.nanio.cc/downloads/tug-agent.exe?t=123',()=>{},async()=>new Response('MZ',{headers:{'content-length':'5'}})),/incomplete/);
});
it('rejects Agent packages outside the official HTTPS download endpoint',async()=>{
 for(const url of ['http://tug.nanio.cc/downloads/tug-agent.exe','https://example.com/downloads/tug-agent.exe','https://tug.nanio.cc/other.exe']){
  await assert.rejects(cacheAgentPackage(url,()=>{},async()=>{throw Error('Unexpected network request');}),/Invalid Agent download URL/);
 }
});
