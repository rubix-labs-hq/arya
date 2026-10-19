import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { registerHooks } from 'node:module'
import test from 'node:test'

const editor = process.env.ARYA_CREATION_EDITOR_ROOT ? new URL(`file://${process.env.ARYA_CREATION_EDITOR_ROOT}/`) : new URL('../', import.meta.url)
const coreURL = new URL('core/project.js', editor).href
registerHooks({ resolve(s, c, n) { return n(s.startsWith('/core/') ? new URL('.' + s, editor).href : s, c) } })
const { applyOps, newProject } = await import(coreURL)
const run = (p, ops) => applyOps(p, ops).project
const kinds = ['add_color', 'adjustment', 'add_shape', 'add_null', 'comp_clip']
const local = (p, comp) => comp ? p.comps[comp] : p
const operation = (kind, comp, fields = {}) => ({ op: kind, comp, start: 1, dur: 2, ...(kind === 'comp_clip' ? { target: 'k2' } : {}), ...fields })
function fixture() {
  const p = newProject('Creation admission', { fps: 30 })
  p.comps = {
    k1: { id: 'k1', name: 'Nested', fps: 25, tracks: structuredClone(p.tracks) },
    k2: { id: 'k2', name: 'Source comp', fps: 24, duration: 2, tracks: [{ id: 'V1', kind: 'video', clips: [] }] },
  }
  return p
}
function refuse(p, op, pattern) {
  const before = structuredClone(p)
  assert.throws(() => applyOps(p, [op]), pattern)
  assert.deepEqual(p, before, 'Refusal must leave the source and every other composition exact')
}
for (const comp of [null, 'k1']) for (const kind of kinds) {
  const name = `${kind} in ${comp ?? 'main'}`
  test(`${name} retains valid default track ordering and scoped placement`, () => {
    const p = fixture(), result = applyOps(p, [operation(kind, comp)]), scope = local(result.project, comp)
    const expected = kind === 'add_color' ? 'V1' : 'V3'
    assert.equal(scope.tracks.find(t => t.clips.length)?.id, expected)
    assert.equal(result.created.length, 1)
    assert.equal(scope.tracks.find(t => t.clips.length).clips[0].start, 1)
    assert.deepEqual(comp ? result.project.tracks : result.project.comps.k1, comp ? p.tracks : p.comps.k1)
    assert.deepEqual(result.project.comps.k2, p.comps.k2)
  })
  test(`${name} skips a locked default and selects the next unlocked video track`, () => {
    const p = fixture(), scope = local(p, comp)
    scope.tracks.find(t => t.id === (kind === 'add_color' ? 'V1' : 'V3')).locked = true
    const q = run(p, [operation(kind, comp)]), target = local(q, comp)
    assert.equal(target.tracks.find(t => t.clips.length)?.id, 'V2')
    assert.equal(target.tracks.filter(t => t.locked).flatMap(t => t.clips).length, 0)
  })
  test(`${name} refuses an explicit locked track`, () => {
    const p = fixture(); local(p, comp).tracks[0].locked = true
    refuse(p, operation(kind, comp, { track: 'V1' }), /track V1 is locked/)
  })
  test(`${name} refuses an explicit audio track`, () => refuse(fixture(), operation(kind, comp, { track: 'A1' }), /require a video track/))
  test(`${name} refuses an explicit missing track`, () => refuse(fixture(), operation(kind, comp, { track: 'missing' }), /no track missing/))
  test(`${name} refuses when every video track is locked`, () => {
    const p = fixture(); local(p, comp).tracks.filter(t => t.kind === 'video').forEach(t => { t.locked = true })
    refuse(p, operation(kind, comp), /Add an unlocked video track/)
  })
  test(`${name} refuses a scope containing only audio tracks`, () => {
    const p = fixture(); local(p, comp).tracks = local(p, comp).tracks.filter(t => t.kind === 'audio')
    refuse(p, operation(kind, comp), /Add an unlocked video track/)
  })
  test(`${name} keeps the entire batch atomic when a later destination is locked`, () => {
    const p = fixture(); local(p, comp).tracks.find(t => t.id === 'V3').locked = true
    const before = structuredClone(p)
    assert.throws(() => run(p, [operation(kind, comp, { track: 'V2' }), operation(kind, comp, { track: 'V3' })]), /locked/)
    assert.deepEqual(p, before)
  })
}

// Execute the actual browser generator callbacks and optimistic store. No browser opens.
const moduleURL = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
const key = Symbol.for('arya.visual-creation.fixture')
const host = moduleURL("export const host={kind:'browser',events:()=>()=>{}};export const api=(...args)=>globalThis[Symbol.for('arya.visual-creation.fixture')].api(...args);")
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
const {EffectsTab}=await import(moduleURL(source+'\nexport {EffectsTab};\n'))
const nodes=v=>Array.isArray(v)?v.flatMap(nodes):v&&typeof v==='object'?[v,...nodes(v.props?.children)]:[]
const text=v=>Array.isArray(v)?v.map(text).join(''):v&&typeof v==='object'?text(v.props?.children):String(v??'')
function browser(t, comp, locked=false) {
  let backend=fixture(),version=7;const calls=[],history=[]
  local(backend,comp).tracks.filter(t=>t.kind==='video').forEach(t=>{t.locked=locked||t.id!=='V2'})
  globalThis[key]={api:async(route,body)=>{if(route==='/api/project')return{project:backend,version};calls.push({route,body});assert.equal(route,'/api/ops');assert.equal(body.expectedVersion,undefined);const result=applyOps(backend,body.ops);history.push(backend);backend=result.project;return{...result,version:++version}}}
  set({project:backend,version,root:'/owned-creation',openComp:comp,selection:[],jobs:[],toasts:[]})
  assert.equal(viewProject().tracks,local(store.project,comp).tracks,'The real store active view must use the current composition')
  t.after(()=>delete globalThis[key]);return{calls,history,before:structuredClone(backend),tree:()=>EffectsTab()}
}
for(const comp of [null,'k1']) for(const label of ['Adjustment layer','Solid #000000']) {
  test(`actual browser ${label} callback uses an unlocked destination in ${comp??'main'}`,async t=>{
    const e=browser(t,comp),button=nodes(e.tree()).find(n=>n.props?.onClick&&text(n)===label)
    assert(button);await button.props.onClick()
    assert.equal(e.calls.length,1);assert.equal(e.calls[0].body.ops[0].comp??null,comp);assert.equal(e.history.length,1)
    assert.equal(local(store.project,comp).tracks.find(t=>t.clips.length)?.id,'V2')
    assert.deepEqual(local(store.project,comp).tracks.filter(t=>t.locked),local(e.before,comp).tracks.filter(t=>t.locked))
  })
  test(`actual browser ${label} callback refuses all-locked destinations in ${comp??'main'}`,async t=>{
    const e=browser(t,comp,true),button=nodes(e.tree()).find(n=>n.props?.onClick&&text(n)===label)
    await button.props.onClick();assert.equal(e.calls.length,0);assert.equal(e.history.length,0);assert.deepEqual(store.project,e.before)
    assert(store.toasts.some(t=>t.text.includes('unlocked video track')))
  })
}
test('a fresh custom effect can still save and apply to a created shape without changing its saved template',()=>{
  let p=run(fixture(),[{op:'add_shape',track:'V2',start:0,dur:2},{op:'add_shape',track:'V2',start:3,dur:2}])
  const [a,b]=p.tracks.find(t=>t.id==='V2').clips
  p=run(p,[{op:'effect',id:a.id,type:'glow',params:{amount:.35,radius:7}},{op:'library_save',category:'effect',name:'Warm glow',source:{clip:a.id}}])
  const template=structuredClone(p.library.items[0]),before=structuredClone(p.tracks.find(t=>t.id==='V2').clips[0])
  const q=run(p,[{op:'library_apply',item:template.id,id:b.id}])
  assert.deepEqual(q.library.items[0],template);assert.deepEqual(q.tracks.find(t=>t.id==='V2').clips[0],before)
  assert.deepEqual(q.tracks.find(t=>t.id==='V2').clips[1].effects[0].params,{amount:.35,threshold:.7,radius:7})
})
