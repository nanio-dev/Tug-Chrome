import { readFile, readdir, mkdir, copyFile, writeFile, stat, unlink } from 'node:fs/promises';
import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import {RELEASE_FILES} from './release-artifacts.mjs';
const root=path.resolve(import.meta.dirname,'..'),source=path.join(root,'dist/extension'),out=path.join(root,'out');
const manifest=JSON.parse(await readFile(path.join(source,'manifest.json'),'utf8'));
if(manifest.manifest_version!==3||manifest.version!==JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version)throw Error('Extension manifest/version does not match package.json');
async function walk(dir){const result=[];for(const e of await readdir(dir,{withFileTypes:true})){if(e.isSymbolicLink())throw Error('Symlinks cannot be packaged');const p=path.join(dir,e.name);if(e.isDirectory())result.push(...await walk(p));else result.push(p);}return result;}
for(const file of await walk(source)){const relative=path.relative(source,file).replaceAll('\\','/');if(/(^|\/)(docs|screenshots|tests|web|out|extension)(\/|$)|\.map$|(^|\/)(push\.(bat|ps1)|\.env[^/]*|README[^/]*|LICENSE)$/.test(relative))throw Error('Non-runtime file in extension: '+relative);}
for(const file of ['background.js','content.js','opfs-worker.js','popup.html','manager.html','options.html','offscreen.html'])if(!(await stat(path.join(source,file))).size)throw Error('Missing extension entry: '+file);
const keyPath=process.env.TUG_EXTENSION_SIGNING_KEY?path.resolve(process.env.TUG_EXTENSION_SIGNING_KEY):path.join(root,'.local/tug-signing.pem');
await mkdir(path.dirname(keyPath),{recursive:true});
let privateKey;
try{privateKey=createPrivateKey(await readFile(keyPath));}catch(error){if(error.code!=='ENOENT')throw error;if(process.env.TUG_EXTENSION_SIGNING_KEY)throw Error('Configured signing key does not exist');const pair=generateKeyPairSync('rsa',{modulusLength:2048});privateKey=pair.privateKey;await writeFile(keyPath,privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600});console.log('[OK] Created local signing key. Back up .local/tug-signing.pem; never publish it.');}
const publicKey=createPublicKey(privateKey).export({type:'spki',format:'der'});
const extensionId=[...createHash('sha256').update(publicKey).digest().subarray(0,16)].map(byte=>String.fromCharCode(97+(byte>>4),97+(byte&15))).join('');
// Embed only the public key so unpacking the signed build keeps the same ID.
manifest.key=publicKey.toString('base64');await writeFile(path.join(source,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
const candidates=[process.env.TUG_CHROME_PATH,path.join(process.env.PROGRAMFILES||'C:/Program Files','Google/Chrome/Application/chrome.exe'),path.join(process.env['PROGRAMFILES(X86)']||'C:/Program Files (x86)','Microsoft/Edge/Application/msedge.exe')].filter(Boolean);
let browser;for(const candidate of candidates)if(await stat(candidate).then(s=>s.isFile(),()=>false)){browser=candidate;break;}if(!browser)throw Error('Chrome/Edge is required to sign CRX3. Set TUG_CHROME_PATH to its executable.');
const packed=path.join(root,'dist/extension.crx');await unlink(packed).catch(error=>{if(error.code!=='ENOENT')throw error});
const result=spawnSync(browser,['--no-startup-window','--no-first-run','--no-message-box','--user-data-dir='+path.join(root,'.local/pack-profile'),'--pack-extension='+source,'--pack-extension-key='+keyPath],{encoding:'utf8',windowsHide:true,timeout:60000});
if(result.error||result.status!==0)throw Error('Browser CRX packaging failed: '+(result.error?.message||result.stderr));
const crx=await readFile(packed);if(crx.toString('ascii',0,4)!=='Cr24'||crx.readUInt32LE(4)!==3)throw Error('Browser did not produce a signed CRX3 package');
await mkdir(out,{recursive:true});await copyFile(packed,path.join(out,'tug.crx'));await copyFile(path.join(root,'agent/tug-agent.exe'),path.join(out,'tug-agent.exe'));
const nativeBuild=JSON.parse(await readFile(path.join(out,'agent-build.json'),'utf8'));
const files=[];for(const name of RELEASE_FILES){const bytes=await readFile(path.join(out,name));if(!bytes.length)throw Error('Empty release artifact: '+name);files.push({name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
const release={version:manifest.version,extensionId,format:'CRX3',builtAt:new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),agentSourceCommit:nativeBuild.sourceCommit,agentBuildRun:nativeBuild.runId,files};
await writeFile(path.join(out,'release.json'),JSON.stringify(release,null,2)+'\n');await writeFile(path.join(out,'SHA256SUMS.txt'),files.map(f=>`${f.sha256}  ${f.name}`).join('\n')+'\n');console.log(`[OK] Signed CRX3 ${manifest.version}; extension ID ${extensionId}; companion and checksums in out/.`);
