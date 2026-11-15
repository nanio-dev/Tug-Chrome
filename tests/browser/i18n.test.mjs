import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { it } from 'node:test';
import { launchHarness, rpc } from '../../scripts/browser-test-utils.mjs';

const languages = [
 {locale:'zh-CN',folder:'zh_CN',browser:'纯插件模式',dashboard:'管理面板',download:'下载 Agent',launch:'启动 Agent',check:'检查下载状态'},
 {locale:'zh-TW',folder:'zh_TW',browser:'純擴充功能模式',dashboard:'管理面板',download:'下載 Agent',launch:'啟動 Agent',check:'檢查下載狀態'},
 {locale:'en-US',folder:'en',browser:'Browser mode',dashboard:'Dashboard',download:'Download Agent',launch:'Launch Agent',check:'Check download status'},
 {locale:'ja-JP',folder:'ja',browser:'拡張機能のみ',dashboard:'管理画面',download:'Agentをダウンロード',launch:'Agentを起動',check:'ダウンロード状況を確認'},
 {locale:'ko-KR',folder:'ko',browser:'확장 프로그램 모드',dashboard:'관리 패널',download:'Agent 다운로드',launch:'Agent 실행',check:'다운로드 상태 확인'},
];

it('persists all five languages, renders popup controls, and packages native browser translations',async()=>{
 const h=await launchHarness();try{
  const base=await h.openPage();await fs.mkdir('test-results/i18n',{recursive:true});
  const expectedKeys=Object.keys(JSON.parse(await fs.readFile(h.extension+'/_locales/en/messages.json','utf8'))).sort();
  for(const language of languages){
   await rpc(base,'update_settings',{standaloneMode:true,locale:language.locale});
   const p=await h.context.newPage();await p.setViewportSize({width:410,height:560});await p.goto(h.origin+'/popup.html');
   await p.getByRole('button',{name:language.browser,exact:true}).waitFor();
   await p.getByRole('button',{name:language.dashboard,exact:true}).waitFor();
   assert.equal(await p.locator('html').getAttribute('lang'),language.locale);
   assert.equal((await rpc(base,'get_state_snapshot')).settings.locale,language.locale);
   assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,language.locale);
   await p.screenshot({path:`test-results/i18n/popup-${language.locale}.png`});
   const messages=JSON.parse(await fs.readFile(`${h.extension}/_locales/${language.folder}/messages.json`,'utf8'));
   assert.deepEqual(Object.keys(messages).sort(),expectedKeys);assert.ok(Object.values(messages).every(v=>v.message.trim()));
   await p.close();
  }
 }finally{await h.close();}
});

it('handles Agent downloads with and without browser confirmation in every language',async()=>{
 const h=await launchHarness();try{
  const base=await h.openPage(),settings=(await rpc(base,'get_state_snapshot')).settings;
  await fs.mkdir('test-results/i18n',{recursive:true});
  for(const language of languages)for(const prompt of [true,false]){
   const p=await h.context.newPage();await p.setViewportSize({width:410,height:560});
   await p.addInitScript(({settings,locale,prompt})=>{
    let phase='idle',downloadId=null;window.installerDownloads=0;window.installerOpened=0;
    window.confirmAgentDownload=()=>{phase='need_manual_launch';};
    chrome.downloads.open=async()=>{window.installerOpened++;};
    chrome.runtime.sendMessage=async m=>{let data={};
     if(m.type==='get_state_snapshot')data={settings:{...settings,standaloneMode:false,locale},tasks:[]};
     else if(m.type==='ensure_native_helper'||m.type==='get_native_helper_status')data={available:phase==='ready'};
     else{
      if(m.type==='install_native_agent')phase='confirming_save';
      if(m.type==='export_downloaded_agent'){window.installerDownloads++;downloadId=123;phase=prompt?'confirming_save':'need_manual_launch';}
      if(m.type==='launch_downloaded_agent')phase='ready';
      data={phase,bytesReceived:10,totalBytes:10,downloadId};
     }
     return{ok:true,data};
    };
   },{settings,locale:language.locale,prompt});
   await p.goto(h.origin+'/popup.html');await p.locator('.popup-agent').click();
   await p.getByRole('button',{name:language.download,exact:true}).click();
   if(prompt){
    await p.getByRole('button',{name:language.check,exact:true}).waitFor();
    assert.equal(await p.getByRole('button',{name:language.download,exact:true}).count(),0);
    await p.screenshot({path:`test-results/i18n/agent-${language.locale}.png`});
    assert.equal(await p.evaluate(()=>document.querySelector('.modal').scrollWidth>document.querySelector('.modal').clientWidth),false,language.locale);
    await p.evaluate(()=>window.confirmAgentDownload());
   }
   await p.getByRole('button',{name:language.launch,exact:true}).click();
   await p.locator('.modal-backdrop').waitFor({state:'hidden'});
   assert.equal(await p.evaluate(()=>window.installerDownloads),1);
   assert.equal(await p.evaluate(()=>window.installerOpened),1);
   await p.close();
  }
 }finally{await h.close();}
});

it('offers five languages in settings and applies each saved selection to existing and new pages',async()=>{
 const h=await launchHarness();try{
  const base=await h.openPage();await rpc(base,'update_settings',{standaloneMode:true,locale:'en-US'});
  const p=await h.context.newPage();await p.goto(h.origin+'/manager.html');
  await p.getByRole('button',{name:'Settings',exact:true}).click();
  await p.getByRole('button',{name:'Appearance & Language',exact:true}).click();
  const selector=p.locator('select:has(option[value="zh-CN"])');
  assert.deepEqual(await selector.locator('option').evaluateAll(options=>options.map(o=>o.value)),['system','zh-CN','zh-TW','en-US','ja-JP','ko-KR']);
  for(const language of languages){
   await selector.selectOption(language.locale);await p.locator('form button[type="submit"]').click();
   await p.waitForFunction(locale=>document.documentElement.lang===locale,language.locale);
   assert.equal((await rpc(base,'get_state_snapshot')).settings.locale,language.locale);
   const popup=await h.context.newPage();await popup.goto(h.origin+'/popup.html');
   await popup.getByRole('button',{name:language.browser,exact:true}).waitFor();await popup.close();
  }
  await p.screenshot({path:'test-results/i18n/settings-ko-KR.png'});
 }finally{await h.close();}
});
