import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'

// Exercise the actual transport with delayed frames and a recording compositor.
const asModule = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
const source = (await fs.readFile(new URL('../web/engine/player.js', import.meta.url), 'utf8'))
  .replace("'/core/project.js'", JSON.stringify(asModule('export const duration = p => p.duration; export const clipEnd = c => c.start + c.dur; export const sourceTime = () => 0;')))
  .replace("'./frame.js'", JSON.stringify(asModule('export const neededImages=()=>new Set(); export const neededVideos = (p,t) => [{key:"clip",url:"movie",srcTime:t,fps:30}]; export const drawFrame = (comp,media,p,t) => comp.frames.push({p,t}); export const resolveTracks = () => [];')))
  .replace("'./media.js'", JSON.stringify(asModule('export const mediaUrl = () => "image";')))
const { Player } = await import(asModule(source))
const turn = () => new Promise(resolve => setImmediate(resolve))

function fixture() {
  let project = { tracks: [], duration: 20 }
  const comp = { frames: [] }, seeks = []
  const media = { videos: new Map(), seek: (_key, _url, t) => new Promise(resolve => seeks.push({t,resolve})), cancelSeeks: () => {} }
  const player = new Player({comp,media,audio:{stop(){}},getProject:()=>project})
  return {player,comp,seeks,changeProject:()=>{project={tracks:[],duration:20}}}
}

test('rapid paused seeks coalesce and only paint the final requested position', async () => {
  const {player,comp,seeks}=fixture()
  player.seek(1);player.seek(2);player.seek(8)
  assert.equal(seeks.length,1)
  seeks[0].resolve();await turn()
  assert.equal(comp.frames.length,0)
  assert.equal(seeks.length,2)
  assert.equal(seeks[1].t,8)
  seeks[1].resolve();await turn()
  assert.deepEqual(comp.frames.map(frame=>frame.t),[8])
  assert.equal(player.displayedTime,8)
})

test('continuous dragging paints completed previews, then release rejects stale work', async () => {
  const {player,comp,seeks}=fixture()
  player.beginScrub();player.seek(1);player.seek(2)
  seeks[0].resolve();await turn()
  assert.deepEqual(comp.frames.map(frame=>frame.t),[1])
  player.seek(6);player.endScrub()
  seeks[1].resolve();await turn()
  assert.equal(comp.frames.length,1)
  assert.equal(seeks[2].t,6)
  seeks[2].resolve();await turn()
  assert.deepEqual(comp.frames.map(frame=>frame.t),[1,6])
  assert.equal(player.scrubbing,false)
})

test('a late decode from another project cannot paint over the current project', async () => {
  const {player,comp,seeks,changeProject}=fixture()
  player.seek(1);changeProject();player.seek(3)
  seeks[0].resolve();await turn()
  assert.equal(comp.frames.length,0)
  seeks[1].resolve();await turn()
  assert.deepEqual(comp.frames.map(frame=>frame.t),[3])
})

test('a resize refresh cannot interrupt forward playback with a paused seek', () => {
  const {player,seeks}=fixture()
  player.playing=true;player.rate=1;player.requestExact()
  assert.equal(seeks.length,0)
})

test('fresh views of the same nested composition can paint, switching compositions invalidates them', async () => {
  const project = {tracks:[],duration:20}, comp = {frames:[]}, seeks=[]
  let compID='scene1'
  const player = new Player({comp,media:{videos:new Map(),seek:()=>new Promise(resolve=>seeks.push(resolve))},audio:{stop(){}},getProject:()=>({...project,compId:compID}),getProjectIdentity:()=>project})
  player.seek(1);seeks[0]();await turn()
  assert.equal(comp.frames.length,1)
  player.seek(2);compID='scene2';player.seek(3)
  seeks[1]();await turn()
  assert.equal(comp.frames.length,1)
  seeks[2]();await turn()
  assert.equal(comp.frames[1].p.compId,'scene2')
})
