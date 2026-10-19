import { compileFixtureWriters } from './support/compile-project-writer.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createProjectWriter } from '../core/project-persistence.mjs'
import { createProcessingAdmission } from '../core/processing-admission.mjs'
import { recoveryDouble } from './support/recovery-double.mjs'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const source=fs.readFileSync(path.join(HERE,'../server.mjs'),'utf8')
const { productionBinary: binary, testBinary } = compileFixtureWriters(test)
const writer=createProjectWriter({binary,sha256:createHash('sha256').update(fs.readFileSync(binary)).digest('hex')})
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'arya-c-browser-')),file=path.join(root,'reel.project.json')
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.writeFileSync(file,JSON.stringify({name:'old',assets:{'clip.mp4':{duration:2}}}))
  const context=vm.createContext({ROOT:root,FILE:file,fs,recoveryProject:JSON.parse,recovery:recoveryDouble(root,fs),recoveryState:null,assistantReview:{commitBy(){}},project:null,lastText:'',projectEpoch:0,version:0,past:[],future:[],clients:new Set(),structuredClone,migrate:v=>v,writeProjectAtomic:writer,processing:createProcessingAdmission(),assistantCalls:{getStore:()=>undefined},probe:async()=>({codec:'fixture'}),log(){},pushActivity(){}})
  const functions=['loadFromDisk','rememberProject','persist','assertAssistantPublication','commit','broadcast'].map(name=>source.match(new RegExp(`function ${name}\\([^]*?\\n}\\n`))[0]).join('\n')
  const routes=['undo','redo'].map(name=>`function ${name}(){${source.match(new RegExp(`'POST /api/${name}': \\(\\) => \\{([^]*?)\\n  \\},`))[1]}\n}`).join('\n')
  const refresh='async '+source.match(/function refreshAssets\([^]*?\n}\n/)[0]
  vm.runInContext(functions+'\n'+routes+'\n'+refresh,context);context.loadFromDisk();return {state:context,root,file}
}
test('exact browser commit and asset refresh use the real compiled production-mode helper',async t=>{
  const {state,file}=fixture(t);await state.refreshAssets();assert.equal(state.version,2);assert.equal(JSON.parse(fs.readFileSync(file)).assets['clip.mp4'].codec,'fixture')
  state.commit({name:'new',assets:{}},'you',[]);assert.equal(state.version,3);state.undo();assert.equal(state.project.name,'old');state.redo();assert.equal(state.project.name,'new')
  assert.equal(state.lastText,fs.readFileSync(file,'utf8'));assert.equal(state.past.length,1)
})
test('real helper rejects stale on-disk edit and browser memory/history remain unchanged',t=>{
  const {state,file}=fixture(t),before=state.lastText;fs.writeFileSync(file,JSON.stringify({name:'external',assets:{}}))
  assert.throws(()=>state.commit({name:'new',assets:{}},'you',[]));assert.equal(state.version,1);assert.equal(state.lastText,before);assert.equal(state.past.length,0)
  assert.equal(JSON.parse(fs.readFileSync(file)).name,'external');state.loadFromDisk();assert.equal(state.project.name,'external')
})
test('compiled helper and exact browser history commit survive a dead SSE subscriber',t=>{
  const {state,file}=fixture(t);state.commit({name:'new',assets:{}},'you',[])
  const dead={res:{write(){throw Error('fixture EPIPE')}}};state.clients.add(dead);state.undo()
  assert.equal(state.version,3);assert.equal(state.past.length,0);assert.equal(state.future.length,1);assert.equal(state.project.name,'old')
  assert.equal(JSON.parse(fs.readFileSync(file)).name,'old');assert.equal(state.clients.has(dead),false)
})


test('real receipt recovery after a helper exits immediately following rename keeps browser state aligned', t => {
  const {state,file}=fixture(t)
  state.writeProjectAtomic=createProjectWriter({binary,sha256:createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),run(command,args,options) {
    if(args[0]==='write')return spawnSync(testBinary,args,{...options,env:{...options.env,ARYA_TEST_FAULT:'replacement'}})
    return spawnSync(command,args,options)
  }})
  state.commit({name:'recovered',assets:{}},'you',[])
  assert.equal(state.version,2);assert.equal(state.project.name,'recovered');assert.equal(state.lastText,fs.readFileSync(file,'utf8'));assert.equal(state.past.length,1)
})
