import './fixtures/browser-host-imports.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { applyOps, compView, newProject } from '../core/project.js'

const moduleURL = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const coreURL = new URL('../core/project.js', import.meta.url).href
const key = Symbol.for('arya.composition-range.test')
function fixture() {
  return applyOps(newProject('Main', { fps:30 }), [{op:'add_title',text:'Main',dur:20},{op:'range',in:1,out:7},{op:'add_comp',name:'Five seconds',duration:5,fps:25},{op:'add_comp',name:'Other scene',duration:8,fps:24}]).project
}
test('views expose only selected composition marks, never inherited main marks', () => {
  const p=fixture(); assert.equal(compView(p,'k1').range,null)
  p.comps.k2.range={in:2,out:4}; assert.deepEqual(compView(compView(p,'k1'),'k2').range,{in:2,out:4})
  assert.deepEqual(compView(p,null).range,{in:1,out:7}); assert.deepEqual(p.range,{in:1,out:7})
})
test('scoped marks preserve main/sibling/source state and use selected frame rate', () => {
  const p=fixture(),before=structuredClone(p)
  const q=applyOps(p,[{op:'range',comp:'k1',in:1.021,out:3.021},{op:'range',comp:'k2',in:2,out:4}]).project
  assert.deepEqual(q.comps.k1.range,{in:1.04,out:3.04});assert.deepEqual(q.comps.k2.range,{in:2,out:4});assert.deepEqual(q.range,{in:1,out:7});assert.deepEqual(p,before)
  assert.equal(q.fps,30);assert.equal(q.compId,undefined);assert.equal(q.__rootTracks,undefined)
})
test('partial marks and clear use composition endpoints and declared empty-tail duration', () => {
  let p=applyOps(fixture(),[{op:'range',comp:'k1',in:2}]).project;assert.deepEqual(p.comps.k1.range,{in:2,out:5})
  p=applyOps(p,[{op:'range',comp:'k1',out:4},{op:'range',comp:'k1',in:1}]).project;assert.deepEqual(p.comps.k1.range,{in:1,out:4})
  p=applyOps(p,[{op:'range',comp:'k1',in:null}]).project;assert.equal(p.comps.k1.range,null);assert.deepEqual(p.range,{in:1,out:7})
  p=applyOps(p,[{op:'range',comp:'k1',out:3}]).project;assert.deepEqual(p.comps.k1.range,{in:0,out:3})
})
test('main defaults/rounding/clear and explicit null scope remain independent; invalid batch stays atomic', () => {
  let p=applyOps(fixture(),[{op:'range',comp:'k1',in:2,out:3},{op:'range',in:2.01}]).project
  assert.deepEqual(p.range,{in:2,out:7}); const before=structuredClone(p)
  assert.throws(()=>applyOps(p,[{op:'range',comp:'k1',in:1},{op:'range',comp:'gone',in:null}]),/no composition gone/);assert.deepEqual(p,before)
  p=applyOps(p,[{op:'range',comp:null,in:null},{op:'range',in:2}]).project
  assert.deepEqual(p.range,{in:2,out:20});assert.deepEqual(p.comps.k1.range,{in:2,out:3})
})

// Actual production store and core; only browser URL loading and API host replaced.
const hostURL=moduleURL("export const host={events:()=>()=>{},kind:'browser'};export const api=(...args)=>globalThis[Symbol.for('arya.composition-range.test')].api(...args);")
let source=await fs.readFile(new URL('../web/ui/store.js',import.meta.url),'utf8')
source=source.replace("'preact/hooks'",JSON.stringify(import.meta.resolve('preact/hooks'))).replace("'/core/project.js'",JSON.stringify(coreURL)).replace("'../host.js'",JSON.stringify(hostURL)).replace("'./change-receipt.js'",JSON.stringify(new URL('../web/ui/change-receipt.js',import.meta.url).href))
const initialWidth=globalThis.innerWidth;globalThis.innerWidth=1440
const storeURL=moduleURL(source);const {edit,set,store,setTime,viewProject}=await import(storeURL)
if(initialWidth===undefined)delete globalThis.innerWidth;else globalThis.innerWidth=initialWidth
function editor(t) {
  const previous=globalThis[key];let backend=fixture(),version=1;const calls=[]
  globalThis[key]={api:async(route,body)=>{calls.push({route,body});if(route==='/api/ops'){backend=applyOps(backend,body.ops).project;return{project:backend,version:++version}}return{path:'fixture/frame.png'}}}
  set({project:backend,version,openComp:'k1',jobs:[],caps:{},root:'/owned-fixture',selection:[],settingsOpen:false})
  t.after(()=>{if(previous===undefined)delete globalThis[key];else globalThis[key]=previous});return{calls}
}
test('actual optimistic store/API scopes mark and clear, preserves explicit root overrides and switching',async t=>{
  const {calls}=editor(t);await edit({op:'range',in:2,out:4})
  assert.equal(calls[0].body.ops[0].comp,'k1');assert.deepEqual(viewProject().range,{in:2,out:4});assert.deepEqual(store.project.range,{in:1,out:7})
  await edit({op:'range',in:null});assert.equal(viewProject().range,null)
  await edit({op:'range',comp:null,in:3,out:6});assert.equal(calls[2].body.ops[0].comp,null);assert.deepEqual(store.project.range,{in:3,out:6});assert.equal(store.project.comps.k1.range,null)
  set({openComp:'k2'});await edit({op:'range',out:5});assert.deepEqual(viewProject().range,{in:0,out:5})
  set({openComp:null});await edit({op:'range',in:null});assert.equal(store.project.range,null);assert.deepEqual(store.project.comps.k2.range,{in:0,out:5})
})
const playerSource=(await fs.readFile(new URL('../web/engine/player.js',import.meta.url),'utf8')).replace("'/core/project.js'",JSON.stringify(coreURL)).replace("'./frame.js'",JSON.stringify(moduleURL('export const neededImages=()=>new Set(); export const neededVideos=()=>[];export const resolveTracks=()=>[];export const drawFrame=()=>{};'))).replace("'./media.js'",JSON.stringify(moduleURL('export const mediaUrl=()=>"unused";')))
const {Player}=await import(moduleURL(playerSource))
function transport(t){const before={requestAnimationFrame:globalThis.requestAnimationFrame,cancelAnimationFrame:globalThis.cancelAnimationFrame};globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{};t.after(()=>{for(const[k,v]of Object.entries(before)){if(v===undefined)delete globalThis[k];else globalThis[k]=v}});const clock={currentTime:0};return new Player({comp:{},media:{videos:new Map(),gc(){},cancelSeeks(){}},audio:{ctx:clock,play:async()=>clock.currentTime,stop(){}},getProject:viewProject,getProjectIdentity:()=>store.project})}
test('actual looping Player follows selected marks and ignores root marks in unmarked compositions',async t=>{
  editor(t);const player=transport(t);player.loop=true;assert.equal(player.range(),null);assert.equal(player.end(),5)
  await edit({op:'range',in:2,out:4});assert.deepEqual(player.range(),{in:2,out:4});player.t=4.5;await player.play();assert.equal(player.t,2);player.pause()
  set({openComp:'k2'});assert.equal(player.range(),null);assert.equal(player.end(),8)
  set({openComp:null});assert.deepEqual(player.range(),{in:1,out:7});assert.equal(player.end(),20)
})
test('actual I/O/clear shortcuts flow through optimistic store and core without main-range leak',async t=>{
  const {calls}=editor(t);globalThis[key].player=transport(t);const before={window:globalThis.window,Element:globalThis.Element};let handler
  globalThis.Element=class{};globalThis.window={addEventListener:(_kind,fn)=>{handler=fn}};t.after(()=>{for(const[k,v]of Object.entries(before)){if(v===undefined)delete globalThis[k];else globalThis[k]=v}})
  const source=(await fs.readFile(new URL('../web/ui/keys.js',import.meta.url),'utf8')).replace("'/core/project.js'",JSON.stringify(coreURL)).replace("'./store.js'",JSON.stringify(storeURL)).replace("'./engine-host.js'",JSON.stringify(moduleURL("export const player=globalThis[Symbol.for('arya.composition-range.test')].player;"))).replace("'./timeline.js'",JSON.stringify(moduleURL('export const copySelection=()=>{};'))).replace("'./source-media.js'",JSON.stringify(new URL('../web/ui/source-media.js',import.meta.url).href))
  const {installKeys}=await import(moduleURL(source));installKeys();const press=async(key,extra={})=>{handler({key,target:{closest:()=>null},preventDefault(){},...extra});await new Promise(r=>setImmediate(r))}
  setTime(2);await press('i');assert.deepEqual(viewProject().range,{in:2,out:5})
  setTime(4);await press('o');assert.deepEqual(viewProject().range,{in:2,out:4})
  await press('x',{altKey:true});assert.equal(viewProject().range,null);assert.deepEqual(store.project.range,{in:1,out:7});assert.ok(calls.every(c=>c.body.ops[0].comp==='k1'))
})
// Actual Deliver component + htm/preact nodes; hook state initialized without mounting DOM.
const hooks=moduleURL('export const useEffect=()=>{};export const useRef=v=>({current:v});export const useState=v=>[v,()=>{}];')
const ds=moduleURL(`export {api,set,toast,viewProject,store} from ${JSON.stringify(storeURL)};import {store} from ${JSON.stringify(storeURL)};export const useStore=()=>store;`)
const deliverSource=(await fs.readFile(new URL('../web/ui/deliver.js',import.meta.url),'utf8')).replace("'preact'",JSON.stringify(import.meta.resolve('preact'))).replace("'preact/hooks'",JSON.stringify(hooks)).replace("'htm'",JSON.stringify(import.meta.resolve('htm'))).replace("'/core/project.js'",JSON.stringify(coreURL)).replace("'./store.js'",JSON.stringify(ds)).replace("'./viewer.js'",JSON.stringify(moduleURL('export const Viewer=()=>null;'))).replace("'./registry.js'",JSON.stringify(moduleURL('export const registry={deliver:[]};'))).replace("'../host.js'",JSON.stringify(hostURL)).replace("'./deliver-request.js'",JSON.stringify(new URL('../web/ui/deliver-request.js',import.meta.url).href))
const {DeliverPage}=await import(moduleURL(deliverSource))
function buttons(node,out=[]){if(Array.isArray(node))node.forEach(v=>buttons(v,out));else if(node&&typeof node==='object'){if(node.type==='button')out.push(node);buttons(node.props?.children,out)}return out}
const label=n=>(Array.isArray(n.props.children)?n.props.children.flat(Infinity):[n.props.children]).filter(v=>typeof v==='string').join('')
test('actual Deliver render and still requests carry selected marks/duration/composition only',async t=>{
  const {calls}=editor(t),before=globalThis.window;globalThis.window={reel:{player:{t:3}}};t.after(()=>{if(before===undefined)delete globalThis.window;else globalThis.window=before})
  const click=async text=>{const button=buttons(DeliverPage()).find(v=>label(v)===text);assert.ok(button,text);await button.props.onClick()}
  await click('⇪ Render');assert.deepEqual(calls.at(-1),{route:'/api/export',body:{preset:'h264-high',name:'Five seconds',width:1920,height:1080,fps:25,range:{in:0,out:5},comp:'k1'}})
  await edit({op:'range',in:2,out:4});await click('⇪ Render');assert.deepEqual(calls.at(-1).body.range,{in:2,out:4})
  await click('Save still frame');assert.deepEqual(calls.at(-1).body,{at:3,width:1920,comp:'k1'})
  set({openComp:null});await click('⇪ Render');assert.deepEqual(calls.at(-1).body.range,{in:1,out:7});assert.equal(Object.hasOwn(calls.at(-1).body,'comp'),false)
})
test('actual native bundle bridge applies scoped ops equivalently to ES modules',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'arya-comp-core-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));const output=path.join(temp,'reel-core.js')
  const run=spawnSync(process.execPath,[fileURLToPath(new URL('../../native/scripts/bundle-core.mjs',import.meta.url)),'--out',output],{encoding:'utf8'});assert.equal(run.status,0,run.stderr)
  const context=vm.createContext({});vm.runInContext(await fs.readFile(output,'utf8'),context)
  const project=fixture(),ops=[{op:'range',comp:'k1',in:2,out:4},{op:'range',comp:null,out:6}]
  const result=JSON.parse(context.ReelCore.bridge.applyOpsJSON(JSON.stringify(project),JSON.stringify(ops)))
  assert.deepEqual(result,JSON.parse(JSON.stringify(applyOps(project,ops))));assert.deepEqual(result.project.range,{in:1,out:6});assert.deepEqual(result.project.comps.k1.range,{in:2,out:4})
})
