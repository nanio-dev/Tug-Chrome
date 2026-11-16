import {mkdir,copyFile,writeFile,chmod} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const [platform,arch,binary,destination]=process.argv.slice(2);
if(!['macos','linux'].includes(platform)||!['x64','arm64','universal'].includes(arch)||!binary||!destination)throw Error('Usage: package-agent-unix.mjs macos|linux x64|arm64|universal BINARY OUTPUT_DIR');
const out=path.resolve(destination);await mkdir(out,{recursive:true});
const temp=await import('node:fs/promises').then(fs=>fs.mkdtemp(path.join(out,'.agent-package-')));
try{
 if(platform==='macos'){
  if(arch!=='universal')throw Error('macOS releases must include both Intel and Apple Silicon');
  execFileSync('lipo',[path.resolve(binary),'-verify_arch','x86_64','arm64']);
  const app=path.join(temp,'Tug Agent.app'),contents=path.join(app,'Contents');await mkdir(path.join(contents,'MacOS'),{recursive:true});
  await copyFile(path.resolve(binary),path.join(contents,'MacOS/tug-agent'));await chmod(path.join(contents,'MacOS/tug-agent'),0o755);
  await writeFile(path.join(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>cc.nanio.tug.agent</string><key>CFBundleName</key><string>Tug Agent</string><key>CFBundleExecutable</key><string>tug-agent</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1.0.0</string><key>LSUIElement</key><true/><key>LSMinimumSystemVersion</key><string>11.0</string></dict></plist>`);
  execFileSync('codesign',['--force','--sign','-','--timestamp=none',app],{stdio:'inherit'});
  execFileSync('codesign',['--verify','--strict',app],{stdio:'inherit'});
  execFileSync('ditto',['-c','-k','--sequesterRsrc','--keepParent',app,path.join(out,'tug-agent-macos-universal.zip')]);
 }else{
  if(!['x64','arm64'].includes(arch))throw Error('Unsupported Linux architecture');
  const dir=path.join(temp,'tug-agent');await mkdir(dir);await copyFile(path.resolve(binary),path.join(dir,'tug-agent'));await chmod(path.join(dir,'tug-agent'),0o755);
  await copyFile(path.join(root,'agent/install.sh'),path.join(dir,'install.sh'));await chmod(path.join(dir,'install.sh'),0o755);
  await writeFile(path.join(dir,'README.txt'),'Extract this archive, open a terminal in this folder, and run: sh install.sh\nRun as your normal desktop user, without sudo. Return to Tug Web after installation.\nNative .deb/.rpm/AppImage browsers are supported; sandboxed Snap/Flatpak browsers require a host bridge.\n');
  execFileSync('tar',['-czf',path.join(out,`tug-agent-linux-${arch}.tar.gz`),'-C',temp,'tug-agent']);
 }
}finally{await import('node:fs/promises').then(fs=>fs.rm(temp,{recursive:true,force:true}));}
