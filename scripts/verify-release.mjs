import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,verify} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'out');
const release=JSON.parse(await readFile(path.join(out,'release.json'),'utf8'));
for(const file of release.files){const bytes=await readFile(path.join(out,file.name));assert.equal(bytes.length,file.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);}
const crx=await readFile(path.join(out,'tug-web.crx'));assert.equal(crx.toString('ascii',0,4),'Cr24');assert.equal(crx.readUInt32LE(4),3);
// Chromium components/crx_file/crx3.proto: length-delimited protobuf fields.
function fields(bytes){let offset=0;const result=new Map();function varint(){let value=0,shift=0,byte;do{byte=bytes[offset++];assert.ok(offset<=bytes.length&&shift<35);value+=(byte&127)*2**shift;shift+=7;}while(byte&128);return value;}while(offset<bytes.length){const key=varint();assert.equal(key&7,2);const size=varint();assert.ok(offset+size<=bytes.length);const list=result.get(key>>3)||[];list.push(bytes.subarray(offset,offset+size));result.set(key>>3,list);offset+=size;}return result;}
const headerSize=crx.readUInt32LE(8),header=fields(crx.subarray(12,12+headerSize));
const proof=fields(header.get(2)[0]),pub=proof.get(1)[0],signature=proof.get(2)[0],signed=header.get(10000)[0];
const size=Buffer.alloc(4);size.writeUInt32LE(signed.length);
assert.ok(verify('sha256',Buffer.concat([Buffer.from('CRX3 SignedData\0'),size,signed,crx.subarray(12+headerSize)]),{key:pub,type:'spki',format:'der'},signature),'CRX3 signature must verify');
const id=fields(signed).get(1)[0];assert.deepEqual(id,createHash('sha256').update(pub).digest().subarray(0,16));
assert.equal([...id].map(b=>String.fromCharCode(97+(b>>4),97+(b&15))).join(''),release.extensionId);
const entries=execFileSync('tar.exe',['-tf',path.join(out,'tug-web.crx')],{encoding:'utf8'}).trim().split(/\r?\n/);
assert.ok(entries.includes('manifest.json'));
assert.ok(entries.every(name=>!/(^|\/)(docs|screenshots|tests|web|extension)(\/|$)|\.pem$|push\.(bat|ps1)$/.test(name)),'Internal files and signing keys must not be packaged');
console.log(`PASS: CRX3 signature, stable extension ID ${release.extensionId}, artifact hashes and runtime-only archive.`);
