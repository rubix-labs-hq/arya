import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { registerHooks } from 'node:module'
import test from 'node:test'

const editor = process.env.ARYA_CREATION_EDITOR_ROOT ? new URL(`file://${process.env.ARYA_CREATION_EDITOR_ROOT}/`) : new URL('../', import.meta.url)
const coreURL = new URL('core/project.js', editor).href
registerHooks({ resolve(s, c, n) { return n(s.startsWith('/core/') ? new URL('.' + s, editor).href : s, c) } })
const { applyOps, newProject } = await import(coreURL)
const run = (p, ops) => applyOps(p, ops).project
const local = (p, comp) => comp ? p.comps[comp] : p
const operation = (comp, fields = {}) => ({ op:'add_title',comp,start:1,dur:2,text:'Scoped title',title:{font:'Inter',size:96,anim:'none'},...fields })
function fixture() {
 const p=newProject('Title creation admission',{fps:30})
 p.comps={k1:{id:'k1',name:'Nested',fps:25,tracks:structuredClone(p.tracks)}}
 return p
}
function refuse(p,op,pattern) {
 const before=structuredClone(p);assert.throws(()=>applyOps(p,[op]),pattern);assert.deepEqual(p,before)
}
for(const comp of [null,'k1']) {
 const name=`add_title in ${comp??'main'}`
 test(`${name} retains its valid last-video default and scoped typography`,()=>{
  const p=fixture(),q=run(p,[operation(comp)]),scope=local(q,comp),track=scope.tracks.find(t=>t.clips.length)
  assert.equal(track.id,'V3');assert.equal(track.clips[0].start,1);assert.equal(track.clips[0].title.font,'Inter');assert.equal(track.clips[0].title.text,'Scoped title')
  assert.deepEqual(comp?q.tracks:q.comps.k1,comp?p.tracks:p.comps.k1)
 })
 test(`${name} skips a locked last-video default`,()=>{
  const p=fixture();local(p,comp).tracks.find(t=>t.id==='V3').locked=true
  const q=run(p,[operation(comp)]);assert.equal(local(q,comp).tracks.find(t=>t.clips.length).id,'V2');assert.deepEqual(local(q,comp).tracks.find(t=>t.id==='V3'),local(p,comp).tracks.find(t=>t.id==='V3'))
 })
 test(`${name} refuses an explicit locked destination`,()=>{const p=fixture();local(p,comp).tracks[0].locked=true;refuse(p,operation(comp,{track:'V1'}),/track V1 is locked/)})
 test(`${name} refuses an explicit audio destination`,()=>refuse(fixture(),operation(comp,{track:'A1'}),/require a video track/))
 test(`${name} refuses an explicit missing destination`,()=>refuse(fixture(),operation(comp,{track:'missing'}),/no track missing/))
 test(`${name} refuses an all-locked scope`,()=>{const p=fixture();local(p,comp).tracks.filter(t=>t.kind==='video').forEach(t=>t.locked=true);refuse(p,operation(comp),/Add an unlocked video track/)})
 test(`${name} refuses a scope without video tracks`,()=>{const p=fixture();local(p,comp).tracks=local(p,comp).tracks.filter(t=>t.kind==='audio');refuse(p,operation(comp),/Add an unlocked video track/)})
 test(`${name} refuses a later invalid destination without partially applying the batch`,()=>{
  const p=fixture(),before=structuredClone(p);assert.throws(()=>run(p,[operation(comp,{track:'V2'}),operation(comp,{track:'A1'})]),/require a video track/);assert.deepEqual(p,before)
 })
}
// Execute the actual browser generator callbacks and optimistic store. No browser opens.
const moduleURL = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
const key = Symbol.for('arya.title-creation.fixture')
const host = moduleURL("export const host={kind:'browser',events:()=>()=>{}};export const api=(...args)=>globalThis[Symbol.for('arya.title-creation.fixture')].api(...args);")
const hooks = moduleURL('export const useEffect=()=>{};export const useLayoutEffect=()=>{};export const useState=v=>[v,()=>{}];export const useReducer=()=>[0,()=>{}];export const useRef=v=>({current:v});')
let source = await fs.readFile(new URL('web/ui/store.js', editor), 'utf8')
for (const [from,to] of [['preact/hooks',hooks],['/core/project.js',coreURL],['../host.js',host],['./change-receipt.js',new URL('web/ui/change-receipt.js',editor).href]]) source=source.replaceAll("'"+from+"'",JSON.stringify(to))
const width=globalThis.innerWidth;globalThis.innerWidth=1440
const storeURL=moduleURL(source),{set,store,viewProject}=await import(storeURL)
if(width===undefined)delete globalThis.innerWidth;else globalThis.innerWidth=width
const facade=moduleURL(`export {api,addRef,edit,set,store,subscribe,time,viewProject} from ${JSON.stringify(storeURL)};import {store} from ${JSON.stringify(storeURL)};export const useStore=()=>store;export const toast=()=>{};`)
const empty=moduleURL('export const ScrollTabs=()=>null;export const openMenu=()=>{};export const registry={browserSections:[],browserTabs:[]};export const runTranscriptJob=()=>{};export const importMediaPaths=()=>{};export const uploadMediaFiles=()=>{};export const mediaDisplayModel=()=>({});export const mediaDisplayName=()=>"";export const mediaMatchesQuery=()=>true;')
source=await fs.readFile(new URL('web/ui/browser.js',editor),'utf8')
for(const[from,to]of Object.entries({'preact':import.meta.resolve('preact'),'htm':import.meta.resolve('htm'),'preact/hooks':hooks,'/core/project.js':coreURL,'./store.js':facade,'../host.js':host,'./scroll-tabs.js':empty,'./menu.js':empty,'./registry.js':empty,'./transcript-jobs.js':empty,'./media-import.js':empty,'./media-label.js':empty,'./title-presets.js':new URL('web/ui/title-presets.js',editor).href}))source=source.replaceAll("'"+from+"'",JSON.stringify(to))
const {TitlesTab}=await import(moduleURL(source+'\nexport {TitlesTab};\n'))
const nodes=v=>Array.isArray(v)?v.flatMap(nodes):v&&typeof v==='object'?[v,...nodes(v.props?.children)]:[]
const text=v=>Array.isArray(v)?v.map(text).join(''):v&&typeof v==='object'?text(v.props?.children):String(v??'')
function browser(t, comp, locked=false) {
  let backend=fixture(),version=7;const calls=[],history=[]
  local(backend,comp).tracks.filter(t=>t.kind==='video').forEach(t=>{t.locked=locked||t.id!=='V2'})
  globalThis[key]={api:async(route,body)=>{if(route==='/api/project')return{project:backend,version};calls.push({route,body});assert.equal(route,'/api/ops');assert.equal(body.expectedVersion,undefined);const result=applyOps(backend,body.ops);history.push(backend);backend=result.project;return{...result,version:++version}}}
  set({project:backend,version,root:'/owned-creation',openComp:comp,selection:[],jobs:[],toasts:[]})
  assert.equal(viewProject().tracks,local(store.project,comp).tracks,'The real store active view must use the current composition')
  t.after(()=>delete globalThis[key]);return{calls,history,before:structuredClone(backend),tree:()=>TitlesTab()}
}
for(const comp of [null,'k1']) {
  const button = tree => nodes(tree).find(n=>n.props?.onClick&&n.props.class==='preset title-preset')
  test(`actual browser title preset uses an unlocked destination in ${comp??'main'}`,async t=>{
    const e=browser(t,comp),control=button(e.tree());assert(control);await control.props.onClick()
    assert.equal(e.calls.length,1);assert.equal(e.calls[0].body.ops[0].comp??null,comp);assert.equal(e.history.length,1)
    const created=local(store.project,comp).tracks.find(t=>t.clips.length)
    assert.equal(created.id,'V2');assert.equal(created.clips[0].kind,'title');assert.equal(created.clips[0].title.text,'Your Title')
    assert.deepEqual(local(store.project,comp).tracks.filter(t=>t.locked),local(e.before,comp).tracks.filter(t=>t.locked))
  })
  test(`actual browser title preset refuses all-locked destinations in ${comp??'main'}`,async t=>{
    const e=browser(t,comp,true),control=button(e.tree());await control.props.onClick()
    assert.equal(e.calls.length,0);assert.equal(e.history.length,0);assert.deepEqual(store.project,e.before)
    assert(store.toasts.some(t=>t.text.includes('unlocked video track')))
  })
}
test('a newly created nested title still saves and places an independent reusable title',()=>{
 const p=fixture();p.comps.k1.tracks.find(t=>t.id==='V3').locked=true
 const made=applyOps(p,[operation('k1')]),id=made.created[0]
 const saved=run(made.project,[{op:'library_save',comp:'k1',category:'title',name:'Reusable nested title',source:{clip:id}}]),item=saved.library.items[0]
 const placed=run(saved,[{op:'library_apply',comp:null,item:item.id,start:5}]),copy=placed.tracks.flatMap(t=>t.clips).find(c=>c.kind==='title')
 assert(copy);assert.notEqual(copy.id,id);assert.equal(copy.title.text,'Scoped title');assert.deepEqual(placed.library,saved.library);assert.deepEqual(placed.comps.k1,saved.comps.k1)
})
