import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {before,after,it} from 'node:test';
import {launchHarness,rpc} from '../../scripts/browser-test-utils.mjs';
let h,defaults;
const tasks = ['downloading','paused','failed','completed','fetching_metadata','verifying','exporting','queued','seeding','paused'].map((state,i)=>({id:i+1,kind:i===4?'torrent':'http',name:i===0?'ReArk-1.2.0-windows-x64-setup.exe':`android-studio-rabbit2-patch1-windows-long-file-name-${i}.exe`,state,url:'https://example.test/file',total:232221672,downloaded:42047898,speedBps:229888,uploaded:0,uploadSpeedBps:0,etaSecs:828,error:state==='failed'?'The connection was interrupted. Resume to try again.':null,saveDir:'',fileName:'file.exe',path:'',createdAt:i,connections:8,rangeSupported:true,segments:[],chromeDownloadId:null,referrer:null,infoHash:null}));
before(async()=>{h=await launchHarness();const p=await h.openPage();defaults=(await rpc(p,'get_state_snapshot')).settings;await p.close();await fs.mkdir('test-results/popup',{recursive:true});});
after(async()=>{await h?.close();});
async function open({locale='zh-CN',theme='light',standalone=true,empty=false,delay=0,taskCount=10,failOnce=false}={}){
 const p=await h.context.newPage();await p.setViewportSize({width:410,height:560});
 await p.addInitScript(({settings,tasks,delay,failOnce})=>{window.popupCalls=[];let failed=false;chrome.runtime.sendMessage=async m=>{window.popupCalls.push(m);let data={};if(m.type==='get_state_snapshot'){if(failOnce&&!failed){failed=true;throw new Error('temporary unavailable');}await new Promise(r=>setTimeout(r,delay));data={settings,tasks};}else if(m.type==='add_task'){await new Promise(r=>setTimeout(r,100));}else if(m.type==='ensure_native_helper'){await new Promise(r=>setTimeout(r,1200));data={available:true};}else if(m.type==='get_agent_install_state'){data={phase:'idle'};}return {ok:true,data};};},{settings:{...defaults,locale,theme,standaloneMode:standalone},tasks:empty?[]:tasks.slice(0,taskCount),delay,failOnce});
 await p.goto(h.origin+'/popup.html');await p.locator('.popup-shell').waitFor();return p;
}
async function bounds(p){return p.evaluate(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};return{header:rect('.popup-head'),brand:rect('.popup-brand strong'),speed:rect('.popup-speed'),footer:rect('.popup-foot')};});}
it('keeps header and footer geometry stable while initial state and Agent check resolve',async()=>{
 const p=await open({locale:'en-US',standalone:false,delay:700});const initial=await bounds(p);await p.getByText('Checking Agent…',{exact:true}).waitFor();await p.screenshot({path:'test-results/popup/checking.png'});await p.getByText('Agent connected',{exact:true}).waitFor();const settled=await bounds(p);assert.deepEqual(settled,initial);assert.equal(await p.locator('.popup-head button').count(),1);assert.equal(await p.locator('.popup-foot').getByText('Dashboard',{exact:true}).count(),1);await p.screenshot({path:'test-results/popup/en-connected.png'});await p.close();
});
it('fits all five languages, light and dark, with all tasks reachable and footer fixed',async()=>{
 for(const locale of ['zh-CN','zh-TW','en-US','ja-JP','ko-KR'])for(const theme of ['light','dark']){
 const p=await open({locale,theme});await p.locator('.popup-task').first().waitFor();assert.equal(await p.locator('.popup-task').count(),10);assert.ok((await p.locator('.popup-task > .progress').first().boundingBox()).height>=6);
 const before=await bounds(p);await p.locator('.popup-list').evaluate(e=>e.scrollTop=e.scrollHeight);assert.deepEqual(await bounds(p),before);
 const overflow=await p.evaluate(()=>Array.from(document.querySelectorAll('.popup-head, .popup-compose, .popup-list-heading, .popup-task, .popup-foot')).filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.className));assert.deepEqual(overflow,[]);
 await p.locator('.popup-list').evaluate(e=>e.scrollTop=0);await p.screenshot({path:`test-results/popup/${locale}-${theme}.png`});
 await p.locator('.popup-foot .popup-manager').click();assert.ok(await p.evaluate(()=>window.popupCalls.some(m=>m.type==='open_manager_tab')));
 await p.close();}
});
it('shows an empty state, prevents duplicate submissions and labels task controls',async()=>{
 const p=await open({empty:true});await p.locator('.popup-empty').waitFor();assert.equal(await p.locator('.popup-quick button').isDisabled(),true);await p.locator('.popup-quick input').fill('https://example.test/test.exe');await p.evaluate(()=>{const f=document.querySelector('.popup-quick');f.requestSubmit();f.requestSubmit();});await p.waitForFunction(()=>document.querySelector('.popup-quick input').value==='');assert.equal(await p.evaluate(()=>window.popupCalls.filter(m=>m.type==='add_task').length),1);await p.screenshot({path:'test-results/popup/empty.png'});await p.close();
 const q=await open();await q.locator('.popup-task').first().waitFor();await q.locator('.popup-task').first().getByRole('button',{name:'暂停',exact:true}).click();assert.ok(await q.evaluate(()=>window.popupCalls.some(m=>m.type==='pause_task'&&m.payload.id===1)));await q.close();
});

it('offers retry after initial loading fails',async()=>{
 const p=await open({failOnce:true});await p.getByRole('button',{name:'重试',exact:true}).click();await p.locator('.popup-task').first().waitFor();assert.equal(await p.locator('.popup-loading').count(),0);await p.close();
 const q=await open({taskCount:1});await q.locator('.popup-task').waitFor();await q.screenshot({path:'test-results/popup/single.png'});await q.close();
});
it('does not restore stale Agent dialogs in browser mode or after a late install-state response',async()=>{
 for(const initiallyStandalone of [true,false]){
 const p=await h.context.newPage();await p.setViewportSize({width:410,height:560});
 await p.addInitScript(({defaults,initiallyStandalone})=>{
  const settings={...defaults,standaloneMode:initiallyStandalone,locale:'en-US'};const listeners=new Set();window.agentPopupCalls=[];
  chrome.runtime.onMessage.addListener=fn=>listeners.add(fn);chrome.runtime.onMessage.removeListener=fn=>listeners.delete(fn);
  window.disablePopupAgent=()=>{settings.standaloneMode=true;listeners.forEach(fn=>fn({channel:'tug-web-event',event:{type:'settings',settings:{...settings}}}));};
  chrome.runtime.sendMessage=async m=>{window.agentPopupCalls.push(m.type);let data={};
   if(m.type==='get_state_snapshot')data={settings:{...settings},tasks:[]};
   else if(m.type==='get_agent_install_state')data=await new Promise(resolve=>{window.resolvePopupInstall=()=>resolve({phase:'need_pairing',bytesReceived:0,totalBytes:0,downloadId:null});});
   else if(m.type==='ensure_native_helper')data={available:false};
   return{ok:true,data};};
 },{defaults,initiallyStandalone});
 await p.goto(h.origin+'/popup.html');
 if(!initiallyStandalone){await p.waitForFunction(()=>window.resolvePopupInstall);await p.evaluate(()=>window.disablePopupAgent());}
 await p.getByText('Browser mode',{exact:true}).waitFor();
 if(!initiallyStandalone){await p.evaluate(()=>window.resolvePopupInstall());await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}
 assert.equal(await p.locator('.modal-backdrop').count(),0);
 const calls=await p.evaluate(()=>window.agentPopupCalls);
 assert.ok(!calls.includes('install_native_agent'));
 if(initiallyStandalone){assert.ok(!calls.includes('get_agent_install_state'));assert.ok(!calls.includes('ensure_native_helper'));}
 await p.close();
 }
});
it('shows Open File only for HTTP and single-selected-file torrents in both interfaces',async()=>{
 const fixture=[['http',1],['torrent',2],['torrent',1],['torrent',null]].map(([kind,selectedFileCount],i)=>({...tasks[3],id:i+1,kind,selectedFileCount,state:'completed',name:'completed-file-'+i+'.zip'}));
 for(const surface of ['popup','manager']){
 const p=await h.context.newPage();await p.addInitScript(({settings,tasks})=>{chrome.runtime.sendMessage=async m=>({ok:true,data:m.type==='get_state_snapshot'?{settings:{...settings,standaloneMode:true,locale:'en-US'},tasks,info:{name:'Tug Web',version:'1',platform:'test',storageEngine:'opfs',downloadSubdir:'',activeTasks:0}}:{phase:'idle'}});},{settings:defaults,tasks:fixture});
 await p.goto(h.origin+'/'+surface+'.html');if(surface==='manager')await p.locator('.nav-item').filter({hasText:'All Tasks'}).click();const rows=p.locator(surface==='popup'?'.popup-task':'.task-item');await rows.first().waitFor();assert.equal(await rows.count(),4);
 for(let i=0;i<4;i++){assert.equal(await rows.filter({hasText:'completed-file-'+i+'.zip'}).getByRole('button',{name:'Open File',exact:true}).count(),i===0||i===2?1:0);assert.equal(await rows.filter({hasText:'completed-file-'+i+'.zip'}).getByRole('button',{name:'Show in Folder',exact:true}).count(),1);}
 await p.close();
 }
});
