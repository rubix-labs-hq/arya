import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { applyOps, newProject, valueAt } from '../core/project.js'
import { cleanRecipe, cleanSettings } from '../core/audio-cleanup.js'

const coreURL = new URL('../core/project.js', import.meta.url).href
registerHooks({ resolve(specifier, context, next) { return next(specifier.startsWith('/core/') ? new URL(`../core/${specifier.slice(6)}`, import.meta.url).href : specifier, context) } })
const { sounds, AudioEngine } = await import('../web/engine/audio.js')
const moduleURL = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const key = Symbol.for('arya.audio-workflow.test')
const hostURL = moduleURL(`export const host={events:()=>()=>{},kind:'browser'};export const api=(...args)=>globalThis[Symbol.for('arya.audio-workflow.test')].api(...args);`)
let source = await fs.readFile(new URL('../web/ui/store.js', import.meta.url), 'utf8')
source = source.replace("'preact/hooks'", JSON.stringify(import.meta.resolve('preact/hooks'))).replace("'/core/project.js'", JSON.stringify(coreURL)).replace("'../host.js'", JSON.stringify(hostURL)).replace("'./change-receipt.js'", JSON.stringify(new URL('../web/ui/change-receipt.js', import.meta.url).href))
const oldWidth = globalThis.innerWidth; globalThis.innerWidth = 1440
const storeURL = moduleURL(source)
const { set, store, viewProject } = await import(storeURL)
if (oldWidth === undefined) delete globalThis.innerWidth; else globalThis.innerWidth = oldWidth
const facade = moduleURL(`export {api,edit,set,store,viewProject} from ${JSON.stringify(storeURL)};import {store} from ${JSON.stringify(storeURL)};export const useStore=()=>store;export const useTime=()=>0;export const toast=(...args)=>globalThis[Symbol.for('arya.audio-workflow.test')].notices.push(args);`)
const hooks = moduleURL("export const useEffect=()=>{};export const useRef=v=>({current:v});export const useState=v=>globalThis[Symbol.for('arya.audio-workflow.test')].useState?.(v)??[v,()=>{}];")
const engine = moduleURL(`export const sounds=globalThis[Symbol.for('arya.audio-workflow.test')].sounds;export const AudioEngine=globalThis[Symbol.for('arya.audio-workflow.test')].AudioEngine;`)
const audioHost = moduleURL(`export const audio={measure:(...args)=>globalThis[Symbol.for('arya.audio-workflow.test')].measure(...args)};`)
const nulls = moduleURL('export const Num=()=>null;export const Viewer=()=>null;export const Timeline=()=>null;export const Toolbar=()=>null;export const Divider=()=>null;export const useLayout=()=>({showTimeline:true});export const registerClipMenu=()=>{};export const registerInspector=()=>{};')
globalThis[key] = { sounds, AudioEngine }
const readAudioSource = relative => fs.readFile(process.env.ARYA_AUDIO_FIXTURE_SOURCE ? `${process.env.ARYA_AUDIO_FIXTURE_SOURCE}/editor/web/ui/${relative}` : new URL(`../web/ui/${relative}`, import.meta.url), 'utf8')
let fx = await readAudioSource('plugins/audio-fx.js')
for (const [from,to] of [['preact',import.meta.resolve('preact')],['preact/hooks',hooks],['htm',import.meta.resolve('htm')],['/core/project.js',coreURL],['../../engine/audio-worklets/dsp.js',new URL('../web/engine/audio-worklets/dsp.js',import.meta.url).href],['../../engine/audio-worklets/fx.js',new URL('../web/engine/audio-worklets/fx.js',import.meta.url).href],['../../engine/audio.js',engine],['../engine-host.js',audioHost],['../inspector.js',nulls],['../registry.js',nulls],['../store.js',facade]]) fx=fx.replaceAll(`'${from}'`,JSON.stringify(to))
const fxURL=moduleURL(fx)
const {AudioCleanupControls,cleanClip,normalizeClips,matchLoudness,applyMasterPreset,measureMix}=await import(fxURL)
let mixer=await readAudioSource('mixer.js')
for(const [from,to] of [['preact',import.meta.resolve('preact')],['preact/hooks',hooks],['htm',import.meta.resolve('htm')],['/core/project.js',coreURL],['../engine/audio.js',engine],['../engine/audio-worklets/fx.js',new URL('../web/engine/audio-worklets/fx.js',import.meta.url).href],['./engine-host.js',audioHost],['./inspector.js',nulls],['./layout.js',nulls],['./plugins/audio-fx.js',fxURL],['./store.js',facade],['./timeline.js',nulls],['./timeline-toolbar.js',nulls],['./viewer.js',nulls]])mixer=mixer.replaceAll(`'${from}'`,JSON.stringify(to))
const {AudioPage}=await import(moduleURL(mixer))
function fixture(){let p=newProject('Audio capture');p.assets={'main.wav':{duration:20,hasAudio:true,hasVideo:false},'nested.wav':{duration:20,hasAudio:true,hasVideo:false},'video.mp4':{duration:20,hasAudio:true,hasVideo:true}};p=applyOps(p,[{op:'add_clip',kind:'audio',src:'main.wav',track:'A1',start:0,dur:8},{op:'add_comp',name:'Nested',duration:6},{op:'add_clip',comp:'k1',kind:'audio',src:'nested.wav',track:'A1',start:1,in:2,dur:3},{op:'add_clip',kind:'video',src:'video.mp4',track:'V1',start:0,in:1,dur:3,audio:false}]).project;return p}
function editor(t){let backend=fixture(),version=1;const env={sounds,AudioEngine,notices:[],calls:[],measured:[],measure:async(p,from,to)=>{env.measured.push({p,from,to});return{integrated:-14,truePeak:-2,lra:2,shortTermMax:-13}},api:async(route,body)=>{env.calls.push({route,body});if(route==='/api/ops'){if(body.expectedVersion!==undefined&&body.expectedVersion!==version)throw Error('stale fixture');backend=applyOps(backend,body.ops).project;return{project:backend,version:++version}}if(route==='/api/project')return{project:backend,version};if(route==='/api/audio/clean'){assert.equal(body.expectedVersion,version);const path='media/cleaned/result.wav',recipe=cleanRecipe(body.src,path,body.mode,cleanSettings(body),'ffmpeg-afftdn-cpu'),asset={duration:20,hasAudio:true,hasVideo:false,processing:{kind:'audio-cleanup',...recipe,compute:'cpu'}};if(JSON.stringify(backend.assets[path])!==JSON.stringify(asset)){backend=applyOps(backend,[{op:'import',assets:{[path]:asset}}]).project;version++}return{path,asset,recipe,engine:recipe.engine,assetRegistered:true,applied:false,admissionVersion:version,version}};throw Error(route)}};globalThis[key]=env;set({project:backend,version,root:'/owned/audio',openComp:null,selection:[],caps:{processing:{audioClean:true}},toasts:[]});t.after(()=>{globalThis[key]={sounds,AudioEngine}});env.external=ops=>{backend=applyOps(backend,ops).project;set({project:backend,version:++version})};return env}
function nodes(node,out=[]){if(Array.isArray(node))node.forEach(v=>nodes(v,out));else if(node&&typeof node==='object'){out.push(node);nodes(node.props?.children,out)}return out}
const clip=p=>p.tracks.find(t=>t.id==='A1').clips[0]
const opCalls=env=>env.calls.filter(c=>c.route==='/api/ops')
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}}
const tick=()=>new Promise(r=>setImmediate(r))

test('Audio mixer shows selected composition and scopes track preview and commit with duplicate A1 IDs',async t=>{const env=editor(t);set({openComp:'k1'});const page=nodes(AudioPage());const strip=page.find(n=>typeof n.type==='function'&&n.type.name==='Strip'&&n.props.track.id==='A1');assert.equal(strip.props.track.clips[0].src,'nested.wav');const contents=nodes(strip.type(strip.props));const fader=contents.find(n=>n.type==='input'&&n.props.class==='fader');fader.props.onInput({target:{value:'-9'}});assert.equal(store.project.tracks.find(t=>t.id==='A1').volume,0);assert.equal(viewProject().tracks.find(t=>t.id==='A1').volume,-9);await fader.props.onChange({target:{value:'-9'}});assert.equal(opCalls(env)[0].body.ops[0].comp,'k1');assert.equal(store.project.tracks.find(t=>t.id==='A1').volume,0);assert.equal(viewProject().tracks.find(t=>t.id==='A1').volume,-9)})
test('Normalize selected nested clip measures its composition and commits one version guarded batch',async t=>{const env=editor(t);set({openComp:'k1'});const c=clip(viewProject());set({selection:[c.id]});env.measure=async(p,from,to)=>{env.measured.push({p,from,to});return{integrated:-20}};const page=nodes(AudioPage());const button=page.find(n=>n.type==='button'&&n.props.children==='Normalize to −14 LUFS');await button.props.onClick();assert.equal(env.measured.length,1);assert.equal(env.measured[0].p.tracks[0].clips[0].src,'nested.wav');assert.equal(env.measured[0].p.fps,viewProject().fps);assert.equal(clip(viewProject()).volume,6);assert.equal(clip(store.project).volume,undefined);assert.equal(opCalls(env)[0].body.expectedVersion,1)})
test('Normalization aborts after an external clip edit instead of overwriting its gain',async t=>{const env=editor(t),c=clip(store.project),wait=deferred();env.measure=()=>wait.promise;const work=normalizeClips([{clip:c,track:store.project.tracks.find(t=>t.id==='A1')}],-14);await tick();env.external([{op:'update',id:c.id,set:{volume:7}}]);wait.resolve({integrated:-20});await work;assert.equal(clip(store.project).volume,7);assert.equal(opCalls(env).length,0);assert(env.notices.some(([m])=>/changed|out of date/i.test(m)))})
for(const change of ['root','composition','selection','optimistic'])test(`Cleanup rejects ${change} drift after processing`,async t=>{const env=editor(t),c=clip(store.project),wait=deferred();const originalAPI=env.api;env.api=(route,body)=>route==='/api/audio/clean'?(env.calls.push({route,body}),wait.promise):originalAPI(route,body);set({selection:[c.id]});const work=cleanClip(c);await tick();if(change==='root')set({root:'/owned/other'});if(change==='composition')set({openComp:'k1'});if(change==='selection')set({selection:[]});if(change==='optimistic')set({project:applyOps(store.project,[{op:'update',id:c.id,set:{volume:8}}]).project});wait.resolve({path:'media/cleaned/result.wav',asset:{duration:20,hasAudio:true,hasVideo:false}});await work;assert.equal(opCalls(env).length,0);assert.equal(clip(store.project).src,'main.wav');assert(!env.notices.some(([m])=>m.startsWith('Voice cleaned:')))})
test('Cleanup valid completion preserves original asset and commits undoable source replacement with version',async t=>{const env=editor(t),c=clip(store.project);await cleanClip(c,'denoise');assert.equal(clip(store.project).src,'media/cleaned/result.wav');assert(store.project.assets['main.wav']);assert.equal(opCalls(env).length,1);assert.equal(opCalls(env)[0].body.expectedVersion,2);assert.deepEqual(opCalls(env)[0].body.ops.map(o=>o.op),['update','update'])})
test('Cleanup does not report success when the edit is refused by the server',async t=>{const env=editor(t),c=clip(store.project),originalAPI=env.api;env.api=(route,body)=>route==='/api/ops'?Promise.reject(Error('fixture refused')):originalAPI(route,body);await cleanClip(c);assert.equal(clip(store.project).src,'main.wav');assert(!env.notices.some(([m])=>m.startsWith('Voice cleaned:')))})
test('Mix matching rejects changed master while measurement awaits',async t=>{const env=editor(t),wait=deferred();env.measure=()=>wait.promise;const work=matchLoudness(-14);await tick();env.external([{op:'project',set:{master:{volume:7}}}]);wait.resolve({integrated:-14,truePeak:-2,lra:2});await assert.rejects(work,/changed|out of date/i);assert.equal(store.project.master.volume,7);assert.equal(opCalls(env).length,0)})
test('Mix measurement honors open composition range and matching guards its commit',async t=>{const env=editor(t);set({openComp:'k1'});await measureMix();assert.equal(env.measured[0].p.compId,'k1');assert.deepEqual([env.measured[0].from,env.measured[0].to],[0,6]);await matchLoudness(-14);assert.equal(opCalls(env)[0].body.expectedVersion,1)})
test('Master preset does not start matching after the preset edit fails',async t=>{const env=editor(t),originalAPI=env.api;env.api=(route,body)=>route==='/api/ops'?Promise.reject(Error('fixture refused')):originalAPI(route,body);await applyMasterPreset('social');assert.equal(env.measured.length,0)})


test('Video cleanup in a full nested audio track creates and fills a nested track only', async t => {
  const env = editor(t)
  env.external([{ op: 'add_clip', comp: 'k1', kind: 'video', src: 'video.mp4', track: 'V1', start: 1, in: 4, dur: 2, audio: false, set: { speed: 1.5 } }])
  set({ openComp: 'k1' })
  const before = structuredClone(store.project), video = viewProject().tracks.find(t => t.id === 'V1').clips[0]
  set({ selection: [video.id] })
  await cleanClip(video)
  const after = viewProject(), cleaned = after.tracks.flatMap(t => t.clips).find(c => c.src === 'media/cleaned/result.wav')
  assert.deepEqual(store.project.tracks, before.tracks)
  assert.equal(after.tracks.length, before.comps.k1.tracks.length + 1)
  assert.equal(after.tracks.find(t => t.id === 'V1').clips[0].mute, true)
  assert.equal(cleaned.kind, 'audio')
  assert.deepEqual([cleaned.start, cleaned.in, cleaned.dur, cleaned.speed], [1, 4, 2, 1.5])
  assert(opCalls(env)[0].body.ops.filter(op => op.op !== 'import').every(op => op.comp === 'k1'))
  assert.equal(opCalls(env)[0].body.expectedVersion, 3)
})

test('Normalization keeps volume keys and easing while rejecting stale entry objects before measurement', async t => {
  const env = editor(t), id = clip(store.project).id
  env.external([{ op: 'update', id, set: { anim: { volume: [[0, -4, 'linear'], [2, 2, 'smooth']] } } }])
  const current = clip(store.project)
  env.measure = async () => ({ integrated: -20 })
  await normalizeClips([{ clip: current }], -14)
  assert.deepEqual(clip(store.project).anim.volume, [[0, 2, 'linear'], [2, 8, 'smooth']])
  const calls = opCalls(env).length
  await normalizeClips([{ clip: current }], -14)
  assert.equal(opCalls(env).length, calls)
  assert(env.notices.some(([message]) => /clip changed/.test(message)))
})

test('Normalization stops at the -1 dBTP true-peak ceiling and says so', async t => {
  const env = editor(t), id = clip(store.project).id
  // -21 LUFS dialogue with peaks at -2 dBTP: reaching -16 LUFS needs +5 dB, the ceiling allows +1.
  env.measure = async () => ({ integrated: -21, truePeak: -2 })
  await normalizeClips([{ clip: clip(store.project) }], -16)
  assert.equal(clip(store.project).volume, 1)
  assert(env.notices.some(([message]) => /stopped below -16 LUFS to keep true peak under -1 dBTP/.test(message)))
  // Room under the ceiling: the full gain applies.
  env.measure = async () => ({ integrated: -20, truePeak: -12 })
  await normalizeClips([{ clip: clip(store.project) }], -14)
  assert.equal(clip(store.project).volume, 7)
  assert.equal(store.project.tracks.flatMap(t => t.clips).find(c => c.id === id).volume, 7)
})

test('Successful master preset measures the new effects and matches as two guarded edits', async t => {
  const env = editor(t)
  const result = await applyMasterPreset('social')
  assert.equal(result.integrated, -14)
  assert.equal(opCalls(env).length, 2)
  assert.deepEqual(opCalls(env).map(call => call.body.expectedVersion), [1, 2])
  assert(env.measured[0].p.master.fx.length > 0)
  assert(env.measured[0].p.master.limiter)
})

test('All nested track channel controls and effects carry their rendered composition', async t => {
  const env = editor(t)
  set({ openComp: 'k1' })
  const stripNode = () => nodes(AudioPage()).find(n => typeof n.type === 'function' && n.type.name === 'Strip' && n.props.track.id === 'A1')
  let vnode = stripNode(), controls = nodes(vnode.type(vnode.props))
  await controls.find(n => n.type === 'input' && n.props['aria-label']?.endsWith(' pan')).props.onChange({ target: { value: '0.4' } })
  for (const label of ['Mute', 'Solo']) {
    vnode = stripNode(); controls = nodes(vnode.type(vnode.props))
    await controls.find(n => n.type === 'button' && n.props['aria-label']?.startsWith(label)).props.onClick()
  }
  assert(opCalls(env).every(call => call.body.ops[0].comp === 'k1'))
  const main = store.project.tracks.find(track => track.id === 'A1')
  assert.deepEqual([main.pan, main.muted, main.solo], [0, undefined, undefined])
  const nested = viewProject().tracks.find(track => track.id === 'A1')
  assert.deepEqual([nested.pan, nested.muted, nested.solo], [0.4, true, true])
  // A delayed channel callback keeps the scope it displayed, rather than selecting a same-ID root track.
  vnode = stripNode(); controls = nodes(vnode.type(vnode.props))
  set({ openComp: null })
  await controls.find(n => n.type === 'input' && n.props['aria-label']?.endsWith(' pan')).props.onChange({ target: { value: '-0.2' } })
  assert.equal(store.project.comps.k1.tracks.find(track => track.id === 'A1').pan, -0.2)
  assert.equal(store.project.tracks.find(track => track.id === 'A1').pan, 0)
})

function duckFixture(t, { speechStart = 0, speechDur = 4, musicStart = 0, musicDur = 4, nested = false, unrelated = false } = {}) {
  const env = editor(t)
  const comp = nested ? 'k1' : null
  set({ openComp: comp })
  env.external(viewProject().tracks.flatMap(track => track.clips.map(clip => ({ op: 'delete', id: clip.id, comp }))))
  if (!viewProject().tracks.some(track => track.name === 'Music')) env.external([{ op: 'add_track', comp, kind: 'audio', name: 'Music' }])
  const musicTrack = viewProject().tracks.find(track => track.name === 'Music')
  env.external([
    { op: 'add_clip', comp, kind: 'audio', src: 'main.wav', track: 'A1', start: speechStart, dur: speechDur },
    { op: 'add_clip', comp, kind: 'audio', src: 'main.wav', track: musicTrack.id, start: musicStart, dur: musicDur },
    ...(unrelated ? [{ op: 'add_clip', comp, kind: 'audio', src: 'main.wav', track: musicTrack.id, start: 10, dur: 4, set: { anim: { volume: [[0, -3], [4, -8, 'smooth']] } } }] : []),
  ])
  return { env, musicTrack: musicTrack.id, comp }
}

async function clickDuck(label = 'Duck music under dialogue') {
  const button = nodes(AudioPage()).find(node => node.type === 'button' && node.props.children === label)
  assert(button, `The mixer must expose ${label}`)
  await button.props.onClick()
}

const musicClip = track => viewProject().tracks.find(candidate => candidate.id === track).clips[0]

for (const scenario of [
  { name: 'dialogue and music start together', speechStart: 0, speechDur: 4, musicStart: 0, musicDur: 4 },
  { name: 'music starts during dialogue', speechStart: 0, speechDur: 8, musicStart: 2, musicDur: 4 },
  { name: 'the nested composition starts with dialogue', speechStart: 0, speechDur: 4, musicStart: 0, musicDur: 4, nested: true },
]) test(`Ducking keeps music lowered while ${scenario.name}`, async t => {
  const { env, musicTrack, comp } = duckFixture(t, scenario)
  const rootBefore = comp ? structuredClone(store.project.tracks) : null
  await clickDuck()
  const music = musicClip(musicTrack)
  for (const local of [0, 0.25, 1, 2, 3.75]) assert.equal(valueAt(viewProject(), music, 'volume', local), -12)
  assert.equal(opCalls(env).length, 1)
  assert(opCalls(env)[0].body.ops.every(op => op.id === music.id))
  if (comp) assert.deepEqual(store.project.tracks, rootBefore)
})

test('Gentle duck uses its selected amount from the first music frame', async t => {
  const { musicTrack } = duckFixture(t)
  await clickDuck('Gentle duck')
  for (const local of [0, 1, 3]) assert.equal(valueAt(viewProject(), musicClip(musicTrack), 'volume', local), -6)
})

test('Ducking preserves the normal attack and recovery around a later speech span', async t => {
  const { musicTrack } = duckFixture(t, { speechStart: 2, speechDur: 2, musicDur: 8 })
  await clickDuck()
  const music = musicClip(musicTrack)
  assert.deepEqual(music.anim.volume, [[0, 0, 'smooth'], [1.65, 0, 'smooth'], [2, -12, 'smooth'], [4, -12, 'smooth'], [4.5, 0, 'smooth'], [8, 0, 'smooth']])
  assert.equal(valueAt(viewProject(), music, 'volume', 3), -12)
})

test('Ducking preserves existing automation on music outside the dialogue range', async t => {
  const { env, musicTrack } = duckFixture(t, { unrelated: true })
  const unrelated = structuredClone(viewProject().tracks.find(track => track.id === musicTrack).clips[1])
  await clickDuck()
  assert.deepEqual(viewProject().tracks.find(track => track.id === musicTrack).clips[1], unrelated)
  assert(opCalls(env)[0].body.ops.every(op => op.id !== unrelated.id))
})

test('Ducking asks for silences and lets the music back up in a long pause', async t => {
  const { env, musicTrack } = duckFixture(t, { speechStart: 0, speechDur: 8, musicStart: 0, musicDur: 8 })
  const originalAPI = env.api
  env.api = async (route, body) => {
    if (route !== '/api/analyze') return originalAPI(route, body)
    env.calls.push({ route, body })
    return { kind: 'silence', ranges: [[3, 6]] }
  }
  await clickDuck()
  assert.deepEqual(env.calls.find(c => c.route === '/api/analyze').body, { src: 'main.wav', kind: 'silence', noise: -35, min: 1 })
  const music = musicClip(musicTrack)
  assert.equal(valueAt(viewProject(), music, 'volume', 1), -12)
  assert.equal(valueAt(viewProject(), music, 'volume', 4.5), 0)
  assert.equal(valueAt(viewProject(), music, 'volume', 7), -12)
  assert.equal(opCalls(env)[0].body.expectedVersion !== undefined, true)
})

test('Dialogue touching only a music boundary does not clear music automation or add an undo entry', async t => {
  for (const speechStart of [0, 8]) {
    const { env, musicTrack } = duckFixture(t, { speechStart, speechDur: 4, musicStart: 4, musicDur: 4 })
    const music = musicClip(musicTrack)
    env.external([{ op: 'update', id: music.id, set: { anim: { volume: [[0, -3], [4, -8, 'smooth']] } } }])
    const before = structuredClone(musicClip(musicTrack))
    await clickDuck()
    assert.deepEqual(musicClip(musicTrack), before)
    assert.equal(opCalls(env).length, 0)
  }
})


test('cleanup sends edited settings, saves its recipe, and starts a second pass with the original source', async t => {
  const env = editor(t), original = clip(store.project)
  const settings = { strength: 0.4, detail: 0.9, quality: 'high', noiseFrom: 1.25, noiseTo: 1.75 }
  await cleanClip(original, 'denoise', settings)
  assert.deepEqual(env.calls.find(c => c.route === '/api/audio/clean').body, { src: 'main.wav', mode: 'denoise', ...settings, apply: false, expectedVersion: 1 })
  const saved = JSON.parse(JSON.stringify(store.project))
  set({ project: saved })
  const applied = clip(store.project)
  assert.equal(applied.audioCleanup.source, 'main.wav')
  assert.deepEqual(applied.audioCleanup.settings, settings)
  const controls = nodes(AudioCleanupControls({ clip: applied, canClean: true }))
  assert.equal(controls.find(n => n.props?.label === 'Strength').props.value, 0.4)
  assert.equal(controls.find(n => n.props?.label === 'Noise from').props.value, 1.25)
  await cleanClip(applied, 'denoise', { strength: 0.2, detail: 0.9, quality: 'balanced' })
  assert.equal(env.calls.filter(c => c.route === '/api/audio/clean').at(-1).body.src, 'main.wav')
  assert.equal(clip(store.project).audioCleanup.settings.noiseFrom, null)
})

test('cleanup invalid manual values reject before requesting processing', async t => {
  const env = editor(t)
  await cleanClip(clip(store.project), 'denoise', { strength: '0.7' })
  await cleanClip(clip(store.project), 'denoise', { noiseFrom: 19.8, noiseTo: 20.5 })
  assert.equal(env.calls.filter(c => c.route === '/api/audio/clean').length, 0)
  assert.equal(opCalls(env).length, 0)
})

for (const invalidSource of ['missing asset', 'asset without audio', 'invalid source']) test(`repeated cleanup preserves its recipe and stops when the original has an ${invalidSource}`, async t => {
  const env = editor(t)
  await cleanClip(clip(store.project), 'denoise')
  const unavailable = structuredClone(store.project)
  if (invalidSource === 'missing asset') delete unavailable.assets['main.wav']
  if (invalidSource === 'asset without audio') unavailable.assets['main.wav'].hasAudio = false
  if (invalidSource === 'invalid source') clip(unavailable).audioCleanup.source = null
  set({ project: unavailable })
  const recipe = structuredClone(clip(store.project).audioCleanup), callCount = env.calls.length
  await cleanClip(clip(store.project), 'denoise', { strength: 0.2 })
  assert.equal(env.calls.length, callCount)
  assert.deepEqual(clip(store.project).audioCleanup, recipe)
  assert.equal(clip(store.project).src, 'media/cleaned/result.wav')
  assert(env.notices.some(([message]) => /Restore the original audio asset/.test(message)))
  const controls = nodes(AudioCleanupControls({ clip: clip(store.project), canClean: true }))
  const buttons = controls.filter(node => node.type === 'button')
  assert(buttons.every(button => button.props.disabled))
  await buttons[0].props.onClick()
  assert.equal(env.calls.length, callCount)
})

test('detached cleaned video sound keeps mix settings and audio automation without picture automation', async t => {
  const env = editor(t), video = store.project.tracks.find(t => t.id === 'V1').clips[0]
  env.external([{ op: 'update', id: video.id, set: { volume: -6, pan: 0.2, fadeIn: 0.4, fadeOut: 0.3, eq: { low: 2 }, fx: [{ type: 'gain', params: { gain: 3 } }], anim: { volume: [[0, -8], [1, -6]], 'fx.0.params.gain': [[0, 2], [1, 3]], opacity: [[0, 0], [1, 1]] }, expr: { pan: 'sin(time)', x: 'time' } } }])
  const current = store.project.tracks.find(t => t.id === 'V1').clips[0]
  await cleanClip(current, 'denoise')
  const sound = store.project.tracks.flatMap(t => t.clips).find(c => c.src === 'media/cleaned/result.wav')
  for (const field of ['volume', 'pan', 'fadeIn', 'fadeOut', 'eq', 'fx']) assert.deepEqual(sound[field], current[field])
  assert.deepEqual(sound.anim, { volume: current.anim.volume, 'fx.0.params.gain': current.anim['fx.0.params.gain'] })
  assert.deepEqual(sound.expr, { pan: current.expr.pan })
  assert.equal(sound.audioCleanup.source, 'video.mp4')
})


test('the cleanup controls submit values changed through their rendered handlers', async t => {
  const env = editor(t), values = []; let cursor = 0
  env.useState = initial => { const at = cursor++; if (!(at in values)) values[at] = initial; return [values[at], next => { values[at] = next }] }
  const render = () => { cursor = 0; return nodes(AudioCleanupControls({ clip: clip(store.project), canClean: true })) }
  let controls = render()
  controls.find(n => n.props?.label === 'Strength').props.onCommit(0.35)
  controls.find(n => n.props?.label === 'Preserve detail').props.onCommit(0.8)
  controls.find(n => n.type === 'select').props.onChange({ target: { value: 'high' } })
  controls.find(n => n.type === 'input').props.onChange({ target: { checked: true } })
  controls = render()
  controls.find(n => n.props?.label === 'Noise from').props.onCommit(2)
  controls.find(n => n.props?.label === 'Noise to').props.onCommit(2.5)
  controls = render()
  await controls.find(n => n.type === 'button' && n.props.children === 'Denoise').props.onClick()
  assert.deepEqual(env.calls.find(c => c.route === '/api/audio/clean').body, { src: 'main.wav', mode: 'denoise', strength: 0.35, detail: 0.8, quality: 'high', noiseFrom: 2, noiseTo: 2.5, apply: false, expectedVersion: 1 })
})


for (const composition of [null, 'k1']) test(`cleanup caller accepts independent admission in ${composition ?? 'main'} and places with its new version`, async t => {
  const env = editor(t); set({ openComp: composition })
  const c = clip(viewProject()); set({ selection: [c.id] })
  const r = await cleanClip(c, 'denoise', { strength: 0 })
  assert.equal(r.assetRegistered, true); assert.equal(clip(viewProject()).src, r.path)
  assert.equal(store.project.assets[r.path].processing.source, c.src)
  assert.equal(opCalls(env)[0].body.expectedVersion, r.admissionVersion)
  assert(opCalls(env)[0].body.ops.every(op => op.comp === composition && op.op === 'update'))
})

for (const change of ['selection', 'composition', 'optimistic']) test(`late cleanup response after ${change} drift retains admitted Media without placing`, async t => {
  const env = editor(t), c = clip(store.project), gate = deferred(), api = env.api
  set({ selection: [c.id] }); let receipt
  env.api = async (route, body) => {
    if (route !== '/api/audio/clean') return api(route, body)
    receipt = await api(route, body); await gate.promise; return receipt
  }
  const work = cleanClip(c, 'voice', { strength: 0 }); await tick()
  if (change === 'selection') set({ selection: [] })
  if (change === 'composition') set({ openComp: 'k1' })
  if (change === 'optimistic') set({ project: applyOps(store.project, [{ op: 'update', id: c.id, comp: null, set: { volume: 7 } }]).project })
  gate.resolve(); const r = await work, saved = await api('/api/project')
  assert.equal(r.assetRegistered, true); assert.ok(saved.project.assets[receipt.path]); assert.equal(clip(saved.project).src, c.src)
  assert.equal(opCalls(env).length, 0); assert(!env.notices.some(([message]) => message.startsWith('Voice cleaned:')))
})

test('cleanup caller accepts its admission event before the HTTP response without requiring object identity', async t => {
  const env = editor(t), api = env.api
  env.api = async (route, body) => {
    const result = await api(route, body)
    if (route === '/api/audio/clean') { const snapshot = await api('/api/project'); set({ project: structuredClone(snapshot.project), version: snapshot.version }) }
    return result
  }
  await cleanClip(clip(store.project), 'denoise', { strength: 0 })
  assert.equal(clip(store.project).src, 'media/cleaned/result.wav'); assert.equal(opCalls(env)[0].body.expectedVersion, 2)
})

test('a backend edit after admission blocks placement but leaves the reusable Media record', async t => {
  const env = editor(t), api = env.api, c = clip(store.project)
  env.api = async (route, body) => {
    const result = await api(route, body)
    if (route === '/api/audio/clean') env.external([{ op: 'update', id: c.id, comp: null, set: { volume: 9 } }])
    return result
  }
  const r = await cleanClip(c, 'denoise', { strength: 0 })
  assert.equal(r.assetRegistered, true); assert.ok(store.project.assets[r.path]); assert.equal(clip(store.project).src, c.src); assert.equal(clip(store.project).volume, 9)
  assert.equal(opCalls(env).length, 0)
})
