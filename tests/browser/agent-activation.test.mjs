import assert from 'node:assert/strict';
import {it} from 'node:test';
import {launchHarness,rpc,waitUntil} from '../../scripts/browser-test-utils.mjs';

async function withBackground(mode,run){
 const h=await launchHarness();try{
 const worker=h.context.serviceWorkers()[0];
 await worker.evaluate(({mode})=>{
  const original=globalThis.fetch;
  globalThis.nativeCalls={connects:0,disconnects:0};
  let registered=false;
  globalThis.fetch=async(url,init)=>{
   if(String(url).startsWith('http://127.0.0.1:16899/health'))return Response.json(mode==='old'?{ok:true,service:'tug-agent'}:{ok:true,service:'tug-agent',protocolVersion:2,authRequired:true});
   if(String(url).startsWith('http://127.0.0.1:16899/register')){registered=true;return Response.json({ok:true});}
   return original(url,init);
  };
  chrome.runtime.connectNative=()=>{
   globalThis.nativeCalls.connects++;
   if(mode==='unpaired'||(mode==='autoregister'&&!registered))throw Error('Access to native messaging host is forbidden');
   const callbacks=[];
   return {onMessage:{addListener:fn=>callbacks.push(fn)},onDisconnect:{addListener:()=>{}},disconnect:()=>globalThis.nativeCalls.disconnects++,postMessage:()=>queueMicrotask(()=>callbacks.forEach(fn=>fn(mode==='old'?{ok:true,type:'ready'}:{ok:true,protocolVersion:2,token:'ab'.repeat(32)})))};
  };
 },{mode});
 const p=await h.openPage();await rpc(p,'update_settings',{standaloneMode:false});await run({h,p,worker});
 }finally{await h.close();}
}
it('completes fresh launch with native credentials and retains the native connection',async()=>{
 await withBackground('ready',async({p,worker})=>{
  const start=Date.now();const state=await rpc(p,'launch_downloaded_agent',{downloadId:123});
  assert.equal(state.phase,'ready');assert.ok(Date.now()-start<5000);
  const calls=await worker.evaluate(()=>globalThis.nativeCalls);assert.deepEqual(calls,{connects:1,disconnects:0});
  await waitUntil(async()=>await worker.evaluate(async()=>{const saved=(await chrome.storage.session.get('tugAgentInstallSession')).tugAgentInstallSession;return saved?.state.phase==='ready';}));
  await rpc(p,'update_settings',{standaloneMode:true});
  await waitUntil(async()=>await worker.evaluate(()=>globalThis.nativeCalls.disconnects===1));
 });
});
it('reports an old running Agent as incompatible, rather than timing out',async()=>{
 await withBackground('old',async({p})=>{const state=await rpc(p,'launch_downloaded_agent',{downloadId:123});assert.equal(state.phase,'error');assert.match(state.message,/旧版/);assert.doesNotMatch(state.message,/启动超时/);});
});
it('returns an explicit pairing step for a running but unpaired Agent',async()=>{
 await withBackground('unpaired',async({p})=>{const state=await rpc(p,'launch_downloaded_agent',{downloadId:123});assert.equal(state.phase,'need_pairing');});
});
it('restores a pending pairing step from session storage in a fresh service worker',async()=>{
 const h=await launchHarness();try{
 const worker=h.context.serviceWorkers()[0];await worker.evaluate(()=>chrome.storage.session.set({tugAgentInstallSession:{state:{phase:'need_pairing',bytesReceived:10,totalBytes:10,downloadId:234}}}));
 const p=await h.openPage();assert.equal((await rpc(p,'get_agent_install_state')).phase,'need_pairing');
 }finally{await h.close();}
});
it('keeps connection failures retryable without opening a protocol page',async()=>{
 const h=await launchHarness();try{
 const base=await h.openPage();const settings=(await rpc(base,'get_state_snapshot')).settings;const p=await h.context.newPage();
 await p.addInitScript(({settings})=>{
  let phase='need_pairing';window.pairingCalls=[];
  chrome.tabs.create=async options=>{window.pairingCalls.push(options.url);return{id:123};};
  chrome.runtime.sendMessage=async m=>{let data={};window.pairingCalls.push(m.type);
   if(m.type==='get_state_snapshot')data={settings:{...settings,standaloneMode:false,locale:'en-US'},tasks:[]};
   else if(m.type==='get_agent_install_state')data={phase,bytesReceived:0,totalBytes:0,downloadId:null};
   else if(m.type==='activate_native_helper_protocol'){phase='ready';data={available:true};}
   else if(m.type==='get_native_helper_status'||m.type==='ensure_native_helper')data={available:phase==='ready'};
   return{ok:true,data};
  };
 },{settings});
 await p.goto(h.origin+'/popup.html');await p.getByRole('button',{name:'Connect Agent',exact:true}).click();await p.getByRole('button',{name:'Retry',exact:true}).waitFor();
 const calls=await p.evaluate(()=>window.pairingCalls);assert.ok(!calls.some(v=>v.startsWith('tug-agent://register?extId=')));assert.ok(!calls.includes('activate_native_helper_protocol'));assert.ok(!calls.includes('install_native_agent'));
 }finally{await h.close();}
});

it('saves the already cached installer without downloading its remote URL again',async()=>{
 await withBackground('old',async({h,p,worker})=>{
  await worker.evaluate(()=>{
   const send=chrome.runtime.sendMessage.bind(chrome.runtime);
   chrome.runtime.sendMessage=(message,callback)=>{
    if(message.type==='download_agent_binary') { callback({ok:true,data:{blobUrl:'blob:chrome-extension://cached-package',totalBytes:7*1024*1024}});return; }
    return send(message,callback);
   };
   chrome.downloads.download=async options=>{globalThis.installerOptions=options;return 9001;};
  });
  await rpc(p,'install_native_agent');
  await waitUntil(async()=>{const state=await rpc(p,'get_agent_install_state');if(state.phase==='error')throw Error(state.message);return state.phase==='confirming_save';});
  const state=await rpc(p,'get_agent_install_state');assert.ok(state.totalBytes>1024*1024);
  await rpc(p,'export_downloaded_agent');
  const options=await worker.evaluate(()=>globalThis.installerOptions);
  assert.equal(options.url,'blob:chrome-extension://cached-package');
  assert.equal(options.filename,'tug-agent.exe');
 });
});

it('silently reconnects an already paired browser and automatically closes the activation dialog',async()=>{
 const h=await launchHarness();try{
 const base=await h.openPage(),settings=(await rpc(base,'get_state_snapshot')).settings,p=await h.context.newPage();
 await p.addInitScript(({settings})=>{
  window.protocolOpened=false;chrome.tabs.create=async()=>{window.protocolOpened=true;throw Error('Unnecessary protocol navigation');};
  chrome.runtime.sendMessage=async m=>{let data={};
   if(m.type==='get_state_snapshot')data={settings:{...settings,standaloneMode:false,locale:'en-US'},tasks:[]};
   else if(m.type==='get_agent_install_state')data={phase:'need_pairing',bytesReceived:0,totalBytes:0,downloadId:null};
   else if(m.type==='ensure_native_helper'||m.type==='get_native_helper_status')data={available:true};
   return{ok:true,data};};
 },{settings});
 await p.goto(h.origin+'/popup.html');await p.getByText('Agent connected',{exact:true}).waitFor();await p.locator('.modal-backdrop').waitFor({state:'hidden'});assert.equal(await p.evaluate(()=>window.protocolOpened),false);
 }finally{await h.close();}
});

it('registers a running Agent silently before retrieving Native Messaging credentials',async()=>{await withBackground('autoregister',async({p})=>{assert.equal((await rpc(p,'launch_downloaded_agent',{downloadId:12})).phase,'ready');});});

it('recovers browser save completion after service worker suspension',async()=>{const h=await launchHarness();try{const worker=h.context.serviceWorkers()[0];await worker.evaluate(async()=>{await chrome.storage.session.set({tugAgentInstallSession:{state:{phase:'confirming_save',bytesReceived:10,totalBytes:10,downloadId:123}}});chrome.downloads.search=async()=>[{id:123,state:'complete',exists:true}];});const p=await h.openPage();assert.equal((await rpc(p,'get_agent_install_state')).phase,'need_manual_launch');}finally{await h.close();}});
