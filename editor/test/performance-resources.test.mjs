import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { newProject } from '../core/project.js'

const moduleURL = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
const coreURL = new URL('../core/project.js', import.meta.url).href
const mediaModule = moduleURL(`export function mediaUrl(project, src) { const asset=project.assets[src]; const path=asset?.proxy??src; return '/media?path='+encodeURIComponent(path) }`)
const frameSource = (await fs.readFile(new URL('../web/engine/frame.js', import.meta.url), 'utf8'))
  .replace("'/core/project.js'", JSON.stringify(coreURL))
  .replace("'./media.js'", JSON.stringify(mediaModule))
  .replace("'./compositor.js'", JSON.stringify(moduleURL('export const hexToRgb=()=>[0,0,0]')))
  .replace("'./shapes.js'", JSON.stringify(moduleURL('export const maskCanvas=()=>null; export const resolvedShape=()=>null; export const shapeCanvas=()=>null;')))
  .replace("'/core/caption-render.js'", JSON.stringify(new URL('../core/caption-render.js', import.meta.url).href))
  .replace("'./render-resolution.js'", JSON.stringify(new URL('../web/engine/render-resolution.js', import.meta.url).href))
const frameURL = moduleURL(frameSource)
const { neededImages, neededVideos } = await import(frameURL)
const playerFrameURL = moduleURL(`export { neededImages, neededVideos, resolveTracks } from ${JSON.stringify(frameURL)}; export function drawFrame(comp,media,p,t) {comp.draws.push({p,t}); for (const need of comp.needs(p,t)) comp.textures.set('vid:'+need.key, {source:need.key})}`)
const playerSource = (await fs.readFile(new URL('../web/engine/player.js', import.meta.url), 'utf8'))
  .replace("'/core/project.js'", JSON.stringify(coreURL))
  .replace("'./frame.js'", JSON.stringify(playerFrameURL))
  .replace("'./media.js'", JSON.stringify(mediaModule))
const { Player } = await import(moduleURL(playerSource))
const turn = () => new Promise(resolve => setImmediate(resolve))
const image = (id, src, start = 0, dur = 10, extra = {}) => ({id,kind:'image',src,start,dur,...extra})
const track = (id, clips, extra = {}) => ({id,kind:'video',clips,...extra})
function project(tracks, comps = {}) { return {...newProject('Performance fixture'),tracks,comps,assets:{}} }

function transport(p) {
  let current = p
  const seeks = [], images = [], collections = [], removed = []
  const comp = {draws:[],textures:new Map(),needs:neededVideos,dropTexture(key) {removed.push(key);this.textures.delete(key)}}
  const media = {
    videos:new Map(),frames:new Map(),
    seek(key,url,t) {this.videos.set(key,{url});return new Promise(resolve=>seeks.push({key,url,t,resolve}))},
    image(url) {images.push(url);return {promise:Promise.resolve()}},
    gc(keep) {collections.push([...keep]);for(const key of this.videos.keys())if(!keep.has(key))this.videos.delete(key)},
    cancelSeeks() {},
  }
  const player = new Player({comp,media,audio:{stop(){}},getProject:()=>current})
  return {player,media,comp,seeks,images,collections,removed,setProject:value=>{current=value}}
}

test('visible image planner excludes future, hidden, disabled and unused compositions, deduplicates proxies', () => {
  const p = project([
    track('active',[image('a','a.png'),image('future','future.png',30)]),
    track('duplicate',[image('same','a.png')]),
    track('disabled',[image('off','off.png',0,10,{enabled:false})]),
    track('hidden',[image('hidden','hidden.png')],{hidden:true}),
  ],{unused:{width:1920,height:1080,fps:30,tracks:[track('unreferenced',[image('unused','huge.png')])]}})
  p.assets['a.png']={proxy:'.reel/proxies/a.png'}
  assert.deepEqual([...neededImages(p,1)],['/media?path=.reel%2Fproxies%2Fa.png'])
  assert.deepEqual([...neededImages(p,20)],[])
})

test('image planner includes both transition ends and visible matte sources', () => {
  const p=project([
    track('transition',[image('out','out.png',0,10),image('in','in.png',10,10,{transitionIn:{type:'crossDissolve',dur:2}})]),
    track('foreground',[image('front','front.png',0,20,{matte:{source:'matte',mode:'alpha'}})]),
    track('matte-track',[image('matte','matte.png',0,20)]),
  ])
  assert.deepEqual(new Set(neededImages(p,9.5)),new Set(['/media?path=out.png','/media?path=in.png','/media?path=front.png','/media?path=matte.png']))
  assert.ok(!neededImages(p,11.5).has('/media?path=out.png'))
})

test('nested images use composition source timing, including reverse, and terminate cyclic nesting', () => {
  const scene={width:1920,height:1080,fps:30,duration:10,tracks:[track('stills',[image('first','first.png',0,5),image('last','last.png',5,5)])]}
  const c={id:'nest',kind:'comp',comp:'scene',start:0,dur:5,in:0,speed:2}
  const p=project([track('main',[c])],{scene})
  assert.deepEqual([...neededImages(p,1)],['/media?path=first.png'])
  assert.deepEqual([...neededImages(p,3)],['/media?path=last.png'])
  c.reverse=true
  assert.deepEqual([...neededImages(p,1)],['/media?path=last.png'])
  assert.deepEqual([...neededImages(p,3)],['/media?path=first.png'])
  const cycle={id:'loop',kind:'comp',comp:'loop',start:0,dur:10}
  const looping=project([track('main',[cycle])],{loop:{width:1920,height:1080,fps:30,tracks:[track('repeat',[cycle])]}})
  assert.deepEqual([...neededImages(looping,1)],[])
})

test('paused exact frames preload only visible images in a 5001-still project', async () => {
  const unused=Array.from({length:5000},(_,i)=>image('future'+i,'8k-'+i+'.png',20+i*10))
  const p=project([track('main',[image('current','current.png'),...unused])])
  const f=transport(p)
  assert.equal(await f.player.renderExact(1),true)
  assert.deepEqual(f.images,['/media?path=current.png'])
  assert.equal(f.comp.draws.length,1)
  assert.deepEqual(f.collections,[[]])
})

test('paused renders release orphan video textures while preserving current, decoded, image and title textures', async () => {
  const p=project([track('main',[{id:'now',kind:'video',src:'now.mp4',start:0,dur:20}])])
  const f=transport(p)
  f.media.videos.set('old',{url:'old.mp4'})
  f.media.frames.set('decoded',{frame:{}})
  for(const key of ['vid:old','vid:now','vid:decoded','img:keep','title:keep'])f.comp.textures.set(key,{})
  const result=f.player.renderExact(1)
  f.seeks[0].resolve();await result
  assert.deepEqual(f.collections,[['now']])
  assert.deepEqual(f.removed,['vid:old'])
  assert.deepEqual(new Set(f.comp.textures.keys()),new Set(['vid:now','vid:decoded','img:keep','title:keep']))
})

test('a stale paused completion cannot collect sources belonging to the replacement project', async () => {
  const old=project([track('old',[{id:'old',kind:'video',src:'old.mp4',start:0,dur:10}])])
  const current=project([track('new',[{id:'new',kind:'video',src:'new.mp4',start:0,dur:10}])])
  const f=transport(old)
  const oldRender=f.player.renderExact(1)
  f.setProject(current)
  const newRender=f.player.renderExact(1)
  f.seeks[0].resolve()
  assert.equal(await oldRender,false)
  assert.deepEqual(f.collections,[])
  assert.ok(f.media.videos.has('new'))
  f.seeks[1].resolve()
  assert.equal(await newRender,true)
  assert.deepEqual(f.collections,[['new']])
})

test('rapid paused traversal runs collection after each settled requested frame', async () => {
  const clips=Array.from({length:200},(_,i)=>({id:'clip'+i,kind:'video',src:'clip'+i+'.mp4',start:i,dur:1}))
  const f=transport(project([track('main',clips)]))
  for(let i=0;i<200;i++) {
    f.player.seek(i+0.25)
    f.seeks.at(-1).resolve();await turn()
    assert.equal(f.player.displayedTime,i+0.25)
    assert.equal(f.media.videos.size,1)
    assert.equal(f.comp.textures.size,1)
  }
  assert.equal(f.collections.length,200)
  assert.equal(f.removed.length,199)
})
