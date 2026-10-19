import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const root = path.resolve(process.env.ARYA_LUT_CACHE_REPO ?? fileURLToPath(new URL('../../', import.meta.url)))
const engine = path.resolve(process.env.ARYA_LUT_CACHE_ENGINE ?? path.join(root, 'editor/web/engine'))
const asModule = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
const file = name => pathToFileURL(path.join(root, name)).href
const compositorSource = (await fs.readFile(path.join(engine, 'compositor.js'), 'utf8'))
  .replace("'/core/project.js'", JSON.stringify(file('editor/core/project.js')))
  .replace("'./grade.js'", JSON.stringify(file('editor/core/render-grade.js')))
  .replace("'./render-resolution.js'", JSON.stringify(pathToFileURL(path.join(engine, 'render-resolution.js')).href))
const { Compositor } = await import(asModule(compositorSource))
const workerSource = (await fs.readFile(path.join(engine, 'worker.js'), 'utf8')).replace(/^import .*$/gm, '')
const { loadLuts, lutPaths } = await import(asModule(`import {parseCube} from ${JSON.stringify(file('editor/core/cube-lut.js'))}; import {framePlan} from ${JSON.stringify(file('editor/core/render-plan.js'))};\n${workerSource}`))
const { parseCube } = await import(file('editor/core/cube-lut.js'))
const playerSource = (await fs.readFile(path.join(engine, 'player.js'), 'utf8'))
  .replace("'/core/project.js'", JSON.stringify(file('editor/core/project.js')))
  .replace("'./frame.js'", JSON.stringify(asModule('export const neededVideos=()=>[{key:"video",url:"source",srcTime:1,fps:30}]; export const neededImages=()=>new Set(); export const resolveTracks=()=>[]; export const drawFrame=(comp,media,p,t)=>comp.draws.push({p,t,hash:comp.luts.get("look.cube")?.sourceHash});')))
  .replace("'./media.js'", JSON.stringify(asModule('export const mediaUrl=()=>"source";')))
const { Player } = await import(asModule(playerSource))
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto })
const turn = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const cube = value => `LUT_3D_SIZE 2\n${Array(8).fill(`${value} ${value} ${value}`).join('\n')}\n`
const hash = text => createHash('sha256').update(text).digest('hex')
const project = (...paths) => ({ width: 160, height: 90, fps: 30, assets: {}, tracks: paths.map((lut,i)=>({id:'track'+i,kind:'video',clips:[{id:'clip'+i,kind:'color',color:'#ffffff',start:0,dur:10,grade:{lut}}]})) })

function fixture() {
  let serial = 0, error = 0
  const uploads = [], deleted = [], stores = []
  const gl = new Proxy({
    MAX_3D_TEXTURE_SIZE: 'MAX_3D_TEXTURE_SIZE', NO_ERROR: 0,
    createTexture: () => ({ id: ++serial }), getParameter: () => 128,
    getError: () => { const result = error; error = 0; return result },
    deleteTexture: tex => deleted.push(tex),
    texImage3D: (...args) => uploads.push(args), pixelStorei: (...args) => stores.push(args),
  }, { get: (object, key) => object[key] ?? (() => {}) })
  const comp = Object.assign(Object.create(Compositor.prototype), { gl, luts: new Map(), lutGeneration: 0, lutBytes: 0, lutExpected: null, size: [160,90], blankCurves: {}, blankLut: {tex:{}}, programs: {layer:{p:{},u:{}}}, draws: [] })
  const sources = new Map([['look.cube', cube(0)]])
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({url,options})
    const value = sources.get(new URL(url, 'http://fixture.invalid').searchParams.get('path'))
    if (typeof value === 'function') return value()
    if (value instanceof Response) return value
    return value === undefined ? new Response('', {status:404}) : new Response(value)
  }
  return {comp,gl,sources,requests,uploads,deleted,stores,uploadError:()=>{error=1285}}
}

test('same path and same length replacement uploads fresh exact content, then reuses unchanged content', async () => {
  const f=fixture(),p=project('look.cube')
  const first=await loadLuts(f.comp,p),old=f.comp.luts.get('look.cube').tex
  assert.equal(first.hashes.get('look.cube'),hash(cube(0)))
  f.sources.set('look.cube',cube(1))
  await loadLuts(f.comp,p)
  assert.equal(f.comp.luts.get('look.cube').sourceHash,hash(cube(1)))
  assert.notEqual(f.comp.luts.get('look.cube').tex,old)
  assert.deepEqual(f.deleted,[old]);assert.equal(f.uploads.length,2)
  await loadLuts(f.comp,p)
  assert.equal(f.uploads.length,2)
  assert.ok(f.requests.every(r=>r.options.cache==='no-store'))
})

test('BOM and CRLF are part of exact raw-byte identity', async () => {
  const f=fixture(),text='\uFEFF'+cube(0).replaceAll('\n','\r\n')
  f.sources.set('look.cube',text)
  const receipt=await loadLuts(f.comp,project('look.cube'))
  assert.equal(receipt.hashes.get('look.cube'),hash(text))
  assert.notEqual(receipt.hashes.get('look.cube'),hash(cube(0)))
  await receipt.validate()
})

for (const [label,replacement] of [['deleted',undefined],['malformed','LUT_3D_SIZE 2\n0 0 0'],['invalid UTF-8',new Uint8Array([0xff])]]) {
  test(`${label} replacement refuses rendering and releases the stale texture`,async()=>{
    const f=fixture();await loadLuts(f.comp,project('look.cube'))
    const tex=f.comp.luts.get('look.cube').tex;f.sources.set('look.cube',replacement)
    await assert.rejects(loadLuts(f.comp,project('look.cube')))
    assert.equal(f.comp.luts.size,0);assert.equal(f.comp.lutBytes,0);assert.deepEqual(f.deleted,[tex])
  })
}

test('late successful load cannot replace a newer same-path load',async()=>{
  const f=fixture(),slow=deferred();f.sources.set('look.cube',()=>slow.promise)
  const old=loadLuts(f.comp,project('look.cube'));const rejected=assert.rejects(old,/superseded/)
  f.sources.set('look.cube',cube(1));await loadLuts(f.comp,project('look.cube'))
  slow.resolve(new Response(cube(0)));await rejected
  assert.equal(f.comp.luts.get('look.cube').sourceHash,hash(cube(1)));assert.equal(f.uploads.length,1)
})

test('late failed load does not evict a newer successful texture',async()=>{
  const f=fixture(),slow=deferred();f.sources.set('look.cube',()=>slow.promise)
  const old=loadLuts(f.comp,project('look.cube'));const rejected=assert.rejects(old,/HTTP 404|superseded/)
  f.sources.set('look.cube',cube(1));await loadLuts(f.comp,project('look.cube'))
  slow.resolve(new Response('',{status:404}));await rejected
  assert.equal(f.comp.luts.get('look.cube').sourceHash,hash(cube(1)));assert.equal(f.deleted.length,0)
})

test('cache release invalidates an in-flight load and its final render receipt',async()=>{
  const f=fixture(),receipt=await loadLuts(f.comp,project('look.cube'))
  f.comp.clearLuts();await assert.rejects(receipt.validate(),/superseded/)
  const slow=deferred();f.sources.set('look.cube',()=>slow.promise)
  const pending=loadLuts(f.comp,project('look.cube'));const rejected=assert.rejects(pending,/superseded/)
  f.comp.clearLuts();slow.resolve(new Response(cube(1)));await rejected
  assert.equal(f.comp.luts.size,0)
})

test('pinned export keeps its initial transform and refuses a changed source at completion',async()=>{
  const f=fixture(),receipt=await loadLuts(f.comp,project('look.cube'),{pin:true})
  const initial=f.comp.luts.get('look.cube').sourceHash
  f.sources.set('look.cube',cube(1))
  assert.equal(f.comp.luts.get('look.cube').sourceHash,initial)
  await assert.rejects(receipt.validate(),/changed during/)
  assert.equal(f.comp.luts.size,0)
  await assert.rejects(loadLuts(f.comp,project('look.cube')),/changed during/)
  f.comp.clearLuts();await loadLuts(f.comp,project('look.cube'))
  assert.equal(f.comp.luts.get('look.cube').sourceHash,hash(cube(1)))
})

test('a changed source after decoding refuses an exact-frame draw',async()=>{
  const f=fixture(),decode=deferred(),p=project('look.cube')
  const player=new Player({comp:f.comp,media:{videos:new Map(),seek:()=>decode.promise},audio:{stop(){}},getProject:()=>p,prepareFrame:(_p,at)=>loadLuts(f.comp,p,{at})})
  const pending=player.renderExact(1);const rejected=assert.rejects(pending,/changed during/)
  while(f.uploads.length===0) await turn()
  f.sources.set('look.cube',cube(1));decode.resolve();await rejected
  assert.equal(f.comp.draws.length,0);assert.equal(f.comp.luts.size,0)
})

test('project change during final source validation cannot publish an old exact frame',async()=>{
  const f=fixture();let p=project('look.cube');const validation=deferred();let calls=0
  f.sources.set('look.cube',()=>++calls===1?new Response(cube(0)):validation.promise)
  const player=new Player({comp:f.comp,media:{videos:new Map(),seek:()=>Promise.resolve()},audio:{stop(){}},getProject:()=>p,prepareFrame:(_p,at)=>loadLuts(f.comp,p,{at})})
  const pending=player.renderExact(1)
  while(calls<2) await turn()
  p=project('look.cube');validation.resolve(new Response(cube(0)))
  assert.equal(await pending,false);assert.equal(f.comp.draws.length,0)
})

test('unchanged project exact refresh discovers external replacement without a project edit',async()=>{
  const f=fixture(),p=project('look.cube')
  const player=new Player({comp:f.comp,media:{videos:new Map(),seek:()=>Promise.resolve()},audio:{stop(){}},getProject:()=>p,prepareFrame:(_p,at)=>loadLuts(f.comp,p,{at})})
  assert.equal(await player.renderExact(1),true)
  f.sources.set('look.cube',cube(1));assert.equal(await player.renderExact(2),true)
  assert.deepEqual(f.comp.draws.map(draw=>draw.hash),[hash(cube(0)),hash(cube(1))])
})

test('active-set commits release unused paths and preserve unchanged texture identity',async()=>{
  const f=fixture();f.sources.set('second.cube',cube(1))
  await loadLuts(f.comp,project('look.cube','second.cube'))
  const kept=f.comp.luts.get('second.cube').tex,removed=f.comp.luts.get('look.cube').tex
  await loadLuts(f.comp,project('second.cube'))
  assert.equal(f.comp.luts.get('second.cube').tex,kept);assert.deepEqual(f.deleted,[removed]);assert.equal(f.comp.lutBytes,64)
})

test('active nested composition node LUTs use exact dependencies and skip disabled nodes',()=>{
  const p=project('outer');p.tracks[0].clips[0]={id:'nest',kind:'comp',comp:'scene',start:0,dur:10}
  const inner=project('primary');inner.tracks[0].clips[0].nodes={list:[{id:'src',type:'source'},{id:'primary',type:'primary'},{id:'lut',type:'lut',lut:'node'},{id:'disabled',type:'lut',lut:'missing',enabled:false},{id:'out',type:'output'}],links:[{from:'src',to:'primary',input:0},{from:'primary',to:'lut',input:0},{from:'lut',to:'disabled',input:0},{from:'disabled',to:'out',input:0}]}
  p.comps={scene:inner,unused:project('unrelated')}
  assert.deepEqual([...lutPaths(p,{at:1})],['primary','node'])
})

test('hidden, disabled, inactive clips and unused compositions cannot block a valid exact frame',async()=>{
  const f=fixture(),p=project('look.cube')
  p.tracks.push({...project('hidden-missing').tracks[0],hidden:true})
  p.tracks.push(project('disabled-missing').tracks[0]);p.tracks.at(-1).clips[0].enabled=false
  p.tracks.push(project('future-missing').tracks[0]);p.tracks.at(-1).clips[0].start=20
  p.comps={unused:project('unused-missing')};p.library=[{lut:'library-missing'}]
  await loadLuts(f.comp,p,{at:1})
  assert.equal(f.requests.length,1);assert.equal(f.comp.luts.size,1)
})

test('export captures only actual selected-range dependencies and includes both transition ends',async()=>{
  const f=fixture(),p=project('look.cube');f.sources.set('incoming',cube(1))
  p.tracks[0].clips[0].dur=1
  p.tracks[0].clips.push({id:'incoming',kind:'color',color:'#ffffff',start:1,dur:1,grade:{lut:'incoming'},transitionIn:{type:'crossDissolve',dur:0.4}})
  p.tracks[0].clips.push({id:'unused',kind:'color',start:5,dur:1,grade:{lut:'unused-missing'}})
  const receipt=await loadLuts(f.comp,p,{pin:true,from:0.8,frames:12,fps:30})
  assert.deepEqual(new Set(receipt.hashes.keys()),new Set(['look.cube','incoming']))
  assert.equal(f.requests.length,2)
})

test('cache admission rejects above 16 MiB before texture allocation',()=>{
  const f=fixture(),generation=++f.comp.lutGeneration
  assert.throws(()=>f.comp.commitLuts([{path:'a',sourceHash:'a'.repeat(64),lut:{size:128}},{path:'b',sourceHash:'b'.repeat(64),lut:{size:2}}],generation),/16 MiB/)
  assert.equal(f.uploads.length,0);assert.equal(f.comp.lutBytes,0)
})

test('direct setLut replaces by content, reuses exact input and stays within byte admission',()=>{
  const f=fixture(),zero=parseCube(cube(0)),one=parseCube(cube(1))
  const first=f.comp.setLut('look.cube',zero,hash(cube(0)))
  assert.equal(f.comp.setLut('look.cube',zero,hash(cube(0))),first)
  const next=f.comp.setLut('look.cube',one,hash(cube(1)))
  assert.notEqual(next,first);assert.deepEqual(f.deleted,[first.tex]);assert.equal(f.comp.lutBytes,64)
  assert.throws(()=>f.comp.setLut('other',zero,'path-only'),/SHA256/)
})

test('failed texture upload releases allocation and restores pixel-store state',()=>{
  const f=fixture();f.uploadError()
  assert.throws(()=>f.comp.setLut('look.cube',parseCube(cube(0)),hash(cube(0))),/upload/)
  assert.equal(f.deleted.length,1);assert.equal(f.comp.luts.size,0)
  assert.deepEqual(f.stores.map(entry=>entry[1]),[false,true])
})

test('device 3D texture size admission precedes allocation',()=>{
  const f=fixture();f.gl.getParameter=()=>32
  assert.throws(()=>f.comp.makeLut3d({size:64}),/device/);assert.equal(f.uploads.length,0)
})

test('declared oversize source fails before body allocation and clears stale texture',async()=>{
  const f=fixture();await loadLuts(f.comp,project('look.cube'))
  f.sources.set('look.cube',new Response('',{headers:{'content-length':String(128*1024*1024+1)}}))
  await assert.rejects(loadLuts(f.comp,project('look.cube')),/128 MiB/)
  assert.equal(f.comp.luts.size,0)
})

test('a LUT grade without a verified texture refuses the actual draw method',()=>{
  const f=fixture()
  assert.throws(()=>f.comp.drawLayer(null,{solid:[1,1,1,1]},{w:160,h:90,x:80,y:45,rotation:0,opacity:1,grade:{lut:'missing.cube'}},{width:160,height:90},0),/no verified texture/)
})

async function workerFixture({ mutate = false } = {}) {
  const f=fixture();f.comp.textures=new Map();f.comp.resize=()=>{};f.comp.readPixels=()=>{}
  f.rendered=[];f.media={reset(){},async planDecoders(){}}
  globalThis.__lutWorker=f
  globalThis.document={body:{appendChild(){}},createElement:()=>({toBlob:done=>done(new Blob(['pixels']))})}
  globalThis.EventSource=class{addEventListener(){}}
  const actualFetch=globalThis.fetch;f.posts=[]
  globalThis.fetch=async(url,options)=>url.startsWith('/media')?actualFetch(url,options):(f.posts.push(url),new Response(''))
  f.render=()=>{
    f.rendered.push(f.comp.luts.get('look.cube')?.sourceHash)
    if(mutate&&f.rendered.length===2)f.sources.set('look.cube',cube(1))
  }
  const helper=asModule(`export class Compositor {constructor(){return globalThis.__lutWorker.comp}}
    export class Media {constructor(){return globalThis.__lutWorker.media}}
    export class AudioEngine {constructor(){return {renderWav:async()=>new Blob(["audio"])}}}
    export class Player {async renderExact(){globalThis.__lutWorker.render()}}
    export const neededVideos=()=>[],frameCenter=t=>t;
    export function createRenderQueue(run){globalThis.__lutWorker.run=run;return ()=>{}}
    export {parseCube} from ${JSON.stringify(file('editor/core/cube-lut.js'))};
    export {framePlan} from ${JSON.stringify(file('editor/core/render-plan.js'))};
    export {compView, duration} from ${JSON.stringify(file('editor/core/project.js'))};
    export {buildDecoderPlans, validateExportSpec} from ${JSON.stringify(file('editor/core/processing-export.js'))};`)
  const source=(await fs.readFile(path.join(engine,'worker.js'),'utf8')).replace(/^import .* from .*$/gm,line=>line.replace(/from .*$/,`from ${JSON.stringify(helper)}`))
  const {startWorker}=await import(asModule(source));startWorker()
  return f
}

for(const mutate of [false,true])test(`actual server worker pins movie transform and ${mutate?'refuses changed completion':'does not fetch LUTs for each movie frame'}`,async()=>{
  const f=await workerFixture({mutate})
  const run=f.run({job:{id:'lut-export',kind:'export',spec:{width:2,height:2,fps:30,frames:6,range:{in:0,out:0.2},preset:'png-seq'}},project:project('look.cube')})
  if(mutate)await assert.rejects(run,/changed during/);else await run
  assert.equal(f.requests.length,2)
  assert.deepEqual(f.rendered,Array(6).fill(hash(cube(0))))
  assert.equal(f.posts.some(url=>url.endsWith('/done')),!mutate)
  assert.equal(f.comp.luts.size,0);assert.equal(f.comp.lutExpected,null)
})

async function webCodecsFixture({ mutate = false, audioOnly = false } = {}) {
  const f=fixture();f.rendered=[];f.finished=[];f.finalized=0
  f.comp.resize=()=>{};f.media={videos:new Map(),closeDecoders(){},async decodeFrame(){},async seek(){},image(){return {promise:Promise.resolve(null)}}}
  f.audio={ctx:{close:async()=>{}},stop(){},renderBuffer:async()=>[new Float32Array(),new Float32Array()]}
  globalThis.__lutCodec=f
  globalThis.document={createElement:()=>({toBlob:done=>done(new Blob(['pixels']))})}
  f.render=()=>{f.rendered.push(f.comp.luts.get('look.cube')?.sourceHash);if(mutate&&f.rendered.length===2)f.sources.set('look.cube',cube(1))}
  const helper=asModule(`export class Compositor {constructor(){return globalThis.__lutCodec.comp}}
    export class Media {constructor(){return globalThis.__lutCodec.media}}
    export class AudioEngine {constructor(){return globalThis.__lutCodec.audio}}
    export class Player {async renderExact(){globalThis.__lutCodec.render()}}
    export class Quality {constructor(){}}
    export class StreamTarget {constructor(){}}
    export class Mp4OutputFormat {}
    export class CanvasSource {async add(){}}
    export class AudioBufferSource {async add(){}}
    export class Output {constructor(){this.state='pending'}addVideoTrack(){}addAudioTrack(){}async start(){this.state='started'}async finalize(){globalThis.__lutCodec.finalized++;this.state='finalized'}async cancel(){this.state='canceled'}}
    export const canEncodeAudio=async()=>true,canEncodeVideo=async()=>true;
    export const host={save:async()=>({})};
    export async function api(url,body){
      if(url==='/api/export/progress')return {state:'running',queued:false,cancelled:false};
      if(url==='/api/export/finish'){if(body.drained!==true)throw new Error('Export completion did not acknowledge drain');globalThis.__lutCodec.finished.push(body);return {ok:true}}
      throw new Error('Unexpected fixture API: '+url)
    }
    export {NativeExportDrain,waitNativeAdmission} from ${JSON.stringify(file('editor/web/engine/native-export-admission.js'))};
    export {compView} from ${JSON.stringify(file('editor/core/project.js'))};
    export {loadLuts} from ${JSON.stringify(asModule(`import {parseCube} from ${JSON.stringify(file('editor/core/cube-lut.js'))};import {framePlan} from ${JSON.stringify(file('editor/core/render-plan.js'))};\n${workerSource}`))};`)
  const source=(await fs.readFile(path.join(engine,'export-webcodecs.js'),'utf8')).replace(/^import .* from .*$/gm,line=>line.replace(/from .*$/,`from ${JSON.stringify(helper)}`))
  const {runNativeExport}=await import(asModule(source))
  const acceptedProject=project('look.cube')
  // This mock host binds a renderer input and a fixture source receipt. It does
  // not execute native filesystem capture; LUT fetches retain their actual hashes.
  const sourceCohort=[{source:'look.cube',resolvedPath:'fixture:look.cube',identity:`fixture-sha256:${hash(cube(0))}`}]
  const sourceCohortID=hash(JSON.stringify(sourceCohort))
  f.run=()=>runNativeExport(acceptedProject,{id:'lut-native-host',acceptedProject:structuredClone(acceptedProject),sourceCohort,sourceCohortID,spec:{width:2,height:2,fps:30,frames:6,range:{in:0,out:0.2},preset:audioOnly?'audio-m4a':'h264-high'}})
  return f
}

for(const mutate of [false,true])test(`actual WebCodecs workflow ${mutate?'fails changed source before finalization':'pins all movie frames without per-frame LUT fetches'}`,async()=>{
  const f=await webCodecsFixture({mutate})
  if(mutate)await assert.rejects(f.run(),/changed during/);else await f.run()
  assert.equal(f.requests.length,mutate?2:3)
  assert.deepEqual(f.rendered,Array(6).fill(hash(cube(0))))
  assert.equal(f.finalized,mutate?0:1)
  assert.equal(Boolean(f.finished.at(-1).error),mutate)
  assert.equal(f.comp.luts.size,0)
})


test('published hash-map copy cannot alter the pinned export identity',async()=>{
  const f=fixture(),receipt=await loadLuts(f.comp,project('look.cube'),{pin:true})
  receipt.hashes.set('look.cube',hash(cube(1)));f.sources.set('look.cube',cube(1))
  await assert.rejects(receipt.validate(),/changed during/)
})

test('actual audio-only server job ignores unrelated missing visual LUTs',async()=>{
  const f=await workerFixture()
  await f.run({job:{id:'audio-only',kind:'export',spec:{width:2,height:2,fps:30,frames:6,range:{in:0,out:0.2},preset:'audio-wav'}},project:project('unrelated-missing.cube')})
  assert.equal(f.requests.length,0);assert.equal(f.rendered.length,0)
  assert.ok(f.posts.some(url=>url.endsWith('/done')))
})

test('actual audio-only WebCodecs job does not validate unused visual LUTs',async()=>{
  const f=await webCodecsFixture({audioOnly:true});f.sources.delete('look.cube');await f.run()
  assert.equal(f.requests.length,0);assert.equal(f.rendered.length,0);assert.equal(f.finalized,1)
})


test('a newer request aborts the older fetch signal and release aborts receipt ownership',async()=>{
  const f=fixture(),slow=deferred();f.sources.set('look.cube',()=>slow.promise)
  const pending=loadLuts(f.comp,project('look.cube'));const rejected=assert.rejects(pending,/superseded/)
  const oldSignal=f.requests[0].options.signal
  f.sources.set('look.cube',cube(1));await loadLuts(f.comp,project('look.cube'))
  assert.equal(oldSignal.aborted,true)
  slow.resolve(new Response(cube(0)));await rejected
  const active=f.requests[1].options.signal;f.comp.clearLuts()
  assert.equal(active.aborted,true)
})

test('generic node edits retain native source and key LUT grades while browser uses its existing narrower passes',async()=>{
  const {newProject,applyOps}=await import(file('editor/core/project.js'))
  const {framePlan}=await import(file('editor/core/render-plan.js'))
  const {project:p}=applyOps(newProject('Source and key LUTs',{width:160,height:90}),[
    {op:'add_color',track:'V1',color:'#ffffff',dur:1},
    {op:'node_add',id:'c1',node:{type:'key'}},
    {op:'node_update',id:'c1',node:'n1',set:{enabled:false,grade:{lut:'source.cube'}}},
    {op:'node_update',id:'c1',node:'n4',set:{grade:{lut:'key.cube'}}},
  ])
  const nodes=framePlan(p,0).layers[0].clip.nodes.list
  assert.equal(nodes.find(n=>n.type==='source').grade.lut,'source.cube')
  assert.equal(nodes.find(n=>n.type==='source').enabled,false)
  assert.equal(nodes.find(n=>n.type==='key').grade.lut,'key.cube')
  assert.deepEqual([...lutPaths(p,{at:0})],[])
})
