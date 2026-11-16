import {execFileSync} from 'node:child_process';
import {mkdir,copyFile,readFile,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {UNIX_AGENTS} from './release-artifacts.mjs';
const root=path.resolve(import.meta.dirname,'..');
const run=(exe,args)=>execFileSync(exe,args,{cwd:root,encoding:'utf8',windowsHide:true});
const inputs=['agent','scripts/package-agent-unix.mjs','tests/agent-*.test.mjs','.github/workflows/agent-platforms.yml','.gitattributes'];
run('git',['diff','--quiet','HEAD','--',...inputs]);
const commit=run('git',['log','-1','--format=%H','--',...inputs]).trim();
let build;
for(let attempt=0;attempt<120;attempt++){
 const runs=JSON.parse(run('gh',['run','list','--repo','nanio-dev/Tug-Web','--workflow','agent-platforms.yml','--commit',commit,'--limit','5','--json','databaseId,status,conclusion']));
 build=runs.find(r=>r.conclusion==='success');
 if(build)break;
 const active=runs.find(r=>r.status!=='completed');
 if(!active)throw Error(`No successful native Agent build for ${commit}. Push Agent changes and complete the Agent platforms workflow first.`);
 console.log(`Waiting for native Agent build ${active.databaseId} (${commit.slice(0,7)}) ...`);
 await new Promise(r=>setTimeout(r,15000));
}
if(!build)throw Error('Native Agent builds did not complete in 30 minutes');
const cacheRoot=path.join(root,'.local/agent-builds');await mkdir(cacheRoot,{recursive:true});
const cache=await mkdtemp(path.join(cacheRoot,commit.slice(0,12)+'-'));
for(const [artifact,file] of [['agent-macos-universal',UNIX_AGENTS[0]],['agent-linux-x64',UNIX_AGENTS[1]],['agent-linux-arm64',UNIX_AGENTS[2]]]){
 const dir=path.join(cache,artifact);
 run('gh',['run','download',String(build.databaseId),'--repo','nanio-dev/Tug-Web','--name',artifact,'--dir',dir]);
 const bytes=await readFile(path.join(dir,file));
 if(!bytes.length||(file.endsWith('.zip')?bytes.readUInt16LE(0)!==0x4b50:bytes.readUInt16BE(0)!==0x1f8b))throw Error('Invalid native Agent archive: '+file);
 await mkdir(path.join(root,'out'),{recursive:true});await copyFile(path.join(dir,file),path.join(root,'out',file));
 console.log(`Downloaded ${file} from tested native build ${build.databaseId}`);
}
await import('node:fs/promises').then(fs=>fs.writeFile(path.join(root,'out/agent-build.json'),JSON.stringify({sourceCommit:commit,runId:build.databaseId})+'\n'));
