import { compileFixtureWriters } from './support/compile-project-writer.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const { testBinary: binary } = compileFixtureWriters(test)
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b }
function fixture(t) {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-c-save-')), root = path.join(outer, 'project')
  fs.mkdirSync(root, { mode: 0o700 }); const file = path.join(root, 'reel.project.json'); fs.writeFileSync(file, '{"name":"old"}\n', { mode: 0o640 })
  t.after(() => fs.rmSync(outer, { recursive: true, force: true })); return { outer, root, file }
}
function invoke(root, text, previous, fault, extra = {}, command = 'write') {
  const selected = fs.statSync(root, { bigint: true }), data = Buffer.from(text), old = previous === null ? null : Buffer.from(previous)
  let target; try { target=fs.lstatSync(path.join(root,'reel.project.json'),{bigint:true}) } catch {}
  const targetIdentity=old ? [u64(target?.dev ?? 0),u64(target?.ino ?? 0)] : [u64(0xffffffffffffffffn),u64(0xffffffffffffffffn)]
  const input = command === 'write' ? Buffer.concat([u64(selected.dev),u64(selected.ino),u64(data.length),u64(old ? old.length : 0xffffffffffffffffn),...targetIdentity,data,...(old ? [old] : [])]) : Buffer.concat([u64(selected.dev),u64(selected.ino)])
  const fd = fs.openSync(binary, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  const stdio = ['pipe','pipe','pipe']; for (let i=3;i<=fd;i++) stdio.push(i===fd?fd:'ignore')
  try {
    const result = spawnSync(binary, [command, fs.realpathSync(root)], { input, encoding:'utf8',stdio,maxBuffer:4096,timeout:10000,
      env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C', ...(fault ? {ARYA_TEST_FAULT:fault} : {}),...extra} })
    let receipt; try { receipt=JSON.parse(result.stdout) } catch {}
    return {...result,receipt}
  } finally { fs.closeSync(fd) }
}
const read = file => fs.readFileSync(file,'utf8')
const acl = file => execFileSync('/bin/ls',['-le',file],{encoding:'utf8'}).split('\n').slice(1).join('\n')
const addACL = file => execFileSync('/bin/chmod',['+a','daemon deny execute',file])
const setAttr = file => execFileSync('/usr/bin/xattr',['-w','arya.fixture','preserve-this',file])
const attr = file => execFileSync('/usr/bin/xattr',['-p','arya.fixture',file],{encoding:'utf8'})

test('prepared helper runs, publishes full JSON and preserves modes',t=>{
  const {root,file}=fixture(t), before=read(file), result=invoke(root,'{"name":"new"}\n',before)
  assert.equal(result.status,0,result.stderr);assert.equal(result.receipt?.ok,true,JSON.stringify(result.receipt ?? { error: result.error?.code, stderr: result.stderr }));assert.equal(result.receipt.testHooks,true)
  assert.equal(JSON.parse(read(file)).name,'new');assert.equal(fs.statSync(file).mode & 0o777,0o640)
})
test('preserves restrictive ACL and extended attribute exactly',t=>{
  const {root,file}=fixture(t);addACL(file);setAttr(file);const before=read(file), metadata=acl(file), value=attr(file)
  const result=invoke(root,'{"name":"new"}\n',before);assert.equal(result.receipt?.ok,true,JSON.stringify(result.receipt ?? { error: result.error?.code, stderr: result.stderr }))
  assert.equal(acl(file),metadata);assert.equal(attr(file),value);assert.equal(JSON.parse(read(file)).name,'new')
})
test('inherited directory ACL is removed from private staging and restored on final file',t=>{
  const {root,file}=fixture(t);execFileSync('/bin/chmod',['+a','everyone allow read,file_inherit',root])
  fs.unlinkSync(file);fs.writeFileSync(file,'{"name":"old"}\n',{mode:0o640});const before=read(file),metadata=acl(file)
  const exited=invoke(root,'{"name":"new"}\n',before,'partial-write');assert.equal(exited.status,73)
  const temporary=fs.readdirSync(root).find(name=>name.endsWith('.tmp'));assert.ok(temporary)
  assert.equal(acl(path.join(root,temporary)).trim(),'');assert.equal(fs.statSync(path.join(root,temporary)).mode & 0o777,0o600)
  fs.unlinkSync(path.join(root,temporary));const result=invoke(root,'{"name":"new"}\n',before)
  assert.equal(result.receipt?.ok,true,JSON.stringify(result.receipt ?? { error: result.error?.code, stderr: result.stderr }));assert.equal(acl(file),metadata)
})
test('a new stage quarantine marker survives publication with original access metadata',t=>{
  const {root,file}=fixture(t);addACL(file);setAttr(file)
  const before=read(file),metadata=acl(file),value=attr(file),mode=fs.statSync(file).mode & 0o7777
  assert.ok(!execFileSync('/usr/bin/xattr',[file],{encoding:'utf8'}).split('\n').includes('com.apple.quarantine'))
  const result=invoke(root,'{"name":"new"}\n',before,'stage-quarantine')
  assert.equal(result.receipt?.ok,true,JSON.stringify(result.receipt))
  assert.equal(execFileSync('/usr/bin/xattr',['-px','com.apple.quarantine',file],{encoding:'utf8'}).replace(/\s/g,''),Buffer.from('0081;00000000;Arya;').toString('hex').toUpperCase())
  assert.equal(acl(file),metadata);assert.equal(attr(file),value);assert.equal(fs.statSync(file).mode & 0o7777,mode)
  assert.equal(read(file),'{"name":"new"}\n')
})
test('a refreshed quarantine timestamp permits repeated publication without changing restrictions',t=>{
  const {root,file}=fixture(t);addACL(file);setAttr(file)
  execFileSync('/usr/bin/xattr',['-w','com.apple.quarantine','0082;6ad1b39b;Arya;',file])
  const metadata=acl(file),value=attr(file),mode=fs.statSync(file).mode & 0o7777
  for(const name of ['first','second']) {
    const result=invoke(root,JSON.stringify({name})+'\n',read(file),'stage-quarantine-later')
    assert.equal(result.receipt?.ok,true,JSON.stringify(result.receipt))
    assert.equal(JSON.parse(read(file)).name,name)
    const marker=execFileSync('/usr/bin/xattr',['-p','com.apple.quarantine',file],{encoding:'utf8'}).trim().split(';')
    assert.equal(marker[0],'0082');assert.ok(parseInt(marker[1],16)>=0x6ad1b39b);assert.equal(marker.slice(3).join(';'),'')
    assert.equal(acl(file),metadata);assert.equal(attr(file),value);assert.equal(fs.statSync(file).mode & 0o7777,mode)
  }
})
for(const quarantine of ['0083;6ad1b39b;Arya;','0082;6ad1b39b;Arya;event','0082;6ad1b4b8;Arya;','0082;6ad1b39g;Arya;'])
  test(`quarantine verification rejects restrictions changed after metadata copy ${quarantine}`,t=>{
    const {root,file}=fixture(t);addACL(file);setAttr(file)
    execFileSync('/usr/bin/xattr',['-w','com.apple.quarantine',quarantine,file])
    const before=read(file),metadata=acl(file),value=attr(file),mode=fs.statSync(file).mode & 0o7777
    const result=invoke(root,'{"name":"new"}\n',before,'quarantine-after-copy')
    assert.equal(result.receipt?.ok,false,JSON.stringify(result.receipt))
    assert.equal(read(file),before);assert.equal(acl(file),metadata);assert.equal(attr(file),value);assert.equal(fs.statSync(file).mode & 0o7777,mode)
    assert.equal(execFileSync('/usr/bin/xattr',['-p','com.apple.quarantine',file],{encoding:'utf8'}).trim(),quarantine)
  })
test('existing quarantine flags survive the platform metadata copy',t=>{
  const {root,file}=fixture(t),quarantine='0083;00000000;Original;'
  execFileSync('/usr/bin/xattr',['-w','com.apple.quarantine',quarantine,file])
  const before=read(file),metadata=acl(file),mode=fs.statSync(file).mode & 0o7777
  const result=invoke(root,'{"name":"new"}\n',before,'stage-quarantine')
  assert.equal(result.receipt?.ok,true,JSON.stringify(result.receipt))
  assert.equal(execFileSync('/usr/bin/xattr',['-p','com.apple.quarantine',file],{encoding:'utf8'}).trim().split(';')[0],'0083')
  assert.equal(read(file),'{"name":"new"}\n');assert.equal(acl(file),metadata);assert.equal(fs.statSync(file).mode & 0o7777,mode)
})
test('metadata-copy failure leaves original bytes, ACL, xattr and mode intact',t=>{
  const {root,file}=fixture(t);addACL(file);setAttr(file);const before=read(file),metadata=acl(file),value=attr(file)
  const result=invoke(root,'{"name":"new"}\n',before,'metadata-failure');assert.equal(result.status,1)
  assert.equal(result.receipt.stage,'metadata');assert.equal(read(file),before);assert.equal(acl(file),metadata);assert.equal(attr(file),value)
  assert.deepEqual(fs.readdirSync(root).sort(),['.reel','reel.project.json'])
})
test('ancestor substitution inside final rename hook cannot redirect publication outside selected directory',t=>{
  const {outer,root,file}=fixture(t),moved=path.join(outer,'moved'),outside=path.join(outer,'outside');fs.mkdirSync(outside)
  const sentinel=path.join(outside,'reel.project.json');fs.writeFileSync(sentinel,'{"name":"outside"}')
  const result=invoke(root,'{"name":"new"}\n',read(file),'ancestor-swap',{ARYA_TEST_ROOT:root,ARYA_TEST_MOVED:moved,ARYA_TEST_OUTSIDE:outside})
  assert.equal(result.receipt?.ok,true,JSON.stringify(result.receipt ?? { error: result.error?.code, stderr: result.stderr }));assert.equal(JSON.parse(read(sentinel)).name,'outside')
  assert.equal(JSON.parse(read(path.join(moved,'reel.project.json'))).name,'new');assert.ok(fs.lstatSync(root).isSymbolicLink())
})
for(const point of ['partial-write','file-flush','replacement'])test(`helper exit at ${point} preserves complete live JSON`,t=>{
  const {root,file}=fixture(t),result=invoke(root,'{"name":"new"}\n',read(file),point);assert.equal(result.status,73)
  assert.equal(JSON.parse(read(file)).name,point==='replacement'?'new':'old')
})
for(const kind of ['symlink','hard-link','directory'])test(`rejects ${kind} target without modifying its destination`,t=>{
  const {root,file}=fixture(t),previous=read(file),other=path.join(root,'other.json');fs.writeFileSync(other,'{"name":"outside"}')
  if(kind==='symlink'){fs.unlinkSync(file);fs.symlinkSync(other,file)}
  if(kind==='hard-link')fs.linkSync(file,path.join(root,'linked.json'))
  if(kind==='directory'){fs.unlinkSync(file);fs.mkdirSync(file)}
  const result=invoke(root,'{"name":"new"}\n',previous);assert.equal(result.receipt?.ok,false);assert.equal(JSON.parse(read(other)).name,'outside')
})
test('rejects stale expected text without replacing an external edit',t=>{
  const {root,file}=fixture(t),before=read(file);fs.writeFileSync(file,'{"name":"external"}')
  const result=invoke(root,'{"name":"new"}\n',before);assert.equal(result.receipt?.ok,false);assert.equal(JSON.parse(read(file)).name,'external')
})
test('new file inherits intended directory ACL and mode after private staging',t=>{
  const {root,file}=fixture(t);fs.unlinkSync(file);execFileSync('/bin/chmod',['+a','everyone allow read,file_inherit',root])
  const expected=path.join(root,'reference.json');fs.writeFileSync(expected,'reference',{mode:0o666});const metadata=acl(expected)
  const result=invoke(root,'{"name":"new"}\n',null);assert.equal(result.receipt?.ok,true,JSON.stringify(result.receipt ?? { error: result.error?.code, stderr: result.stderr }))
  assert.equal(acl(file),metadata);assert.equal(fs.statSync(file).mode & 0o777,0o666 & ~process.umask())
})


test('failure after ancestor substitution cleans only retained-directory temporary file',t=>{
  const {outer,root,file}=fixture(t),moved=path.join(outer,'moved'),outside=path.join(outer,'outside');fs.mkdirSync(outside)
  const sentinel=path.join(outside,'reel.project.json');fs.writeFileSync(sentinel,'{"name":"outside"}')
  const result=invoke(root,'{"name":"new"}\n',read(file),'ancestor-swap-failure',{ARYA_TEST_ROOT:root,ARYA_TEST_MOVED:moved,ARYA_TEST_OUTSIDE:outside})
  assert.equal(result.receipt?.ok,false);assert.equal(JSON.parse(read(sentinel)).name,'outside')
  assert.equal(JSON.parse(read(path.join(moved,'reel.project.json'))).name,'old');assert.deepEqual(fs.readdirSync(moved).sort(),['.reel','reel.project.json'])
  const outsideTemporary=fs.readdirSync(outside).find(name=>name.endsWith('.tmp'));assert.ok(outsideTemporary)
  assert.equal(read(path.join(outside,outsideTemporary)),'outside-temp')
})
test('unsupported file flags fail closed without removing metadata',t=>{
  const {root,file}=fixture(t),before=read(file);execFileSync('/usr/bin/chflags',['hidden',file])
  const result=invoke(root,'{"name":"new"}\n',before);assert.equal(result.receipt?.ok,false);assert.equal(read(file),before)
  assert.match(execFileSync('/bin/ls',['-lO',file],{encoding:'utf8'}),/hidden/)
})
// macOS marks documents in iCloud-synced folders with UF_TRACKED (0x40); chflags(1) has no name for it.
const setFlags = (file, flags) => execFileSync('/usr/bin/python3',['-I','-S','-c','import os,sys; os.chflags(sys.argv[1], int(sys.argv[2]))',file,String(flags)],{env:{PATH:'/usr/bin:/bin'}})
test('the document tracking flag does not block a save, and other flags still fail closed beside it',t=>{
  const {root,file}=fixture(t),before=read(file);setFlags(file,0x40)
  const result=invoke(root,'{"name":"new"}\n',before);assert.equal(result.receipt?.ok,true,JSON.stringify(result.receipt ?? { stderr: result.stderr }))
  assert.equal(JSON.parse(read(file)).name,'new');assert.equal(fs.statSync(file).mode & 0o777,0o640)
  const saved=read(file);setFlags(file,0x40|0x8000)
  const hidden=invoke(root,'{"name":"newer"}\n',saved);assert.equal(hidden.receipt?.ok,false);assert.equal(read(file),saved)
  setFlags(file,0)
})

for (const kind of ['existing file', 'new inherited file']) test(`final mode never exposes data without the restrictive ACL for ${kind}`, t => {
  const {root,file}=fixture(t)
  fs.chmodSync(root,0o755)
  if(kind==='existing file') {
    fs.chmodSync(file,0o644)
    execFileSync('/bin/chmod',['+a','daemon deny read',file])
  } else {
    fs.unlinkSync(file)
    execFileSync('/bin/chmod',['+a','daemon deny read,file_inherit',root])
  }
  const reference=path.join(root,'reference.json')
  if(kind==='new inherited file')fs.writeFileSync(reference,'reference',{mode:0o666})
  const metadata=acl(kind==='existing file'?file:reference)
  const before=kind==='existing file'?read(file):null
  const result=invoke(root,'{"name":"confidential new value"}\n',before,'final-mode')
  assert.equal(result.status,73)
  const temporary=fs.readdirSync(root).find(name=>name.endsWith('.tmp'));assert.ok(temporary)
  const staged=path.join(root,temporary)
  assert.equal(read(staged),'{"name":"confidential new value"}\n')
  assert.equal(fs.statSync(staged).mode & 0o777,kind==='existing file'?0o644:0o666 & ~process.umask())
  assert.equal(acl(staged),metadata,'Final mode must never precede the restrictive ACL')
  if(before===null)assert.equal(fs.existsSync(file),false)
  else assert.equal(read(file),before)
})
