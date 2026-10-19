import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { newProject, compView, sourceTime } from '../core/project.js'

function project() {
 const p=newProject('Match Frame oracle')
 p.assets={'media/source.mov':{duration:60,fps:30,hasVideo:true,hasAudio:true}}
 p.tracks=[{id:'V1',kind:'video',clips:[{id:'v',kind:'video',src:'media/source.mov',start:0,dur:20,in:9,speed:0.5}]}]
 p.comps={k1:{id:'k1',name:'Nested',width:640,height:360,fps:30,tracks:[{id:'V1',kind:'video',locked:true,clips:[{id:'v',kind:'video',src:'media/source.mov',start:3,dur:8,in:12,speed:2,link:'family'}]},{id:'A1',kind:'audio',clips:[{id:'a',kind:'audio',src:'media/source.mov',start:3,dur:8,in:12,speed:2,link:'family'}]}]}}
 return p
}
const cases=[
 {name:'opened nested composition with duplicate clip ID',comp:'k1',primary:'v',selected:['v'],at:5,expected:16},
 {name:'same ID on main timeline stays in main scope',comp:null,primary:'v',selected:['v'],at:5,expected:11.5},
 {name:'linked multi-selection uses stable video primary',comp:'k1',primary:'v',selected:['v','a'],at:5,expected:16},
 {name:'linked multi-selection uses stable audio primary',comp:'k1',primary:'a',selected:['v','a'],at:5,expected:16},
 {name:'quarter speed keeps source in point',comp:'k1',primary:'v',selected:['v'],at:5,set:{speed:0.25},expected:12.5},
 {name:'reverse playback maps from source span end',comp:'k1',primary:'v',selected:['v'],at:5,set:{reverse:true},expected:24},
 {name:'freeze overrides reverse and scalar timing',comp:'k1',primary:'v',selected:['v'],at:5,set:{reverse:true,freeze:17.25},expected:17.25},
 {name:'source tail clamps before media duration',comp:'k1',primary:'v',selected:['v'],at:5,set:{in:59},expected:59.999},
 {name:'negative freeze clamps to source zero',comp:'k1',primary:'v',selected:['v'],at:5,set:{freeze:-2},expected:0},
 {name:'freeze beyond source clamps to last source time',comp:'k1',primary:'v',selected:['v'],at:5,set:{freeze:999},expected:59.999},
 {name:'locked scope remains available for read-only navigation',comp:'k1',primary:'v',selected:['v'],at:3,expected:12},
 {name:'fractional source frame rate stays separate from timeline fps',comp:'k1',primary:'v',selected:['v'],at:5,set:{freeze:12.34},fps:23.976,expected:12.34},
 {name:'23.976 fractional tail retains readable partial final source frame',comp:'k1',primary:'v',selected:['v'],at:5,set:{freeze:999},fps:23.976,expected:59.999},
 {name:'30000/1001 fractional tail retains readable partial final source frame',comp:'k1',primary:'v',selected:['v'],at:5,set:{freeze:999},fps:30000/1001,expected:59.999},
]
const receipts=[]
for(const spec of cases)test(`real shared sourceTime: ${spec.name}`,()=>{
 const p=project();if(spec.fps)p.assets['media/source.mov'].fps=spec.fps
 const view=compView(p,spec.comp),found=view.tracks.flatMap(t=>t.clips).filter(c=>c.id===spec.primary);assert.equal(found.length,1)
 const clip=found[0];Object.assign(clip,spec.set)
 const before=JSON.stringify(p),seconds=sourceTime(p,clip,spec.at)
 assert.ok(Math.abs(seconds-spec.expected)<1e-10);assert.equal(JSON.stringify(p),before,'matching source timing must not edit project or comp references')
 const asset=p.assets[clip.src],duration=Math.floor(asset.duration*asset.fps+1e-7)/asset.fps
 const lastReadableFrame=(Math.ceil(asset.duration*asset.fps)-1)/asset.fps
 const viewerSeconds=Math.min(lastReadableFrame,Math.max(0,Math.round(seconds*asset.fps)/asset.fps))
 assert.ok(viewerSeconds>=0&&viewerSeconds<asset.duration)
 if(spec.name.includes('fractional tail'))assert.equal(viewerSeconds,Math.floor(asset.duration*asset.fps)/asset.fps)
 receipts.push({name:spec.name,project:p,composition:spec.comp,primary:spec.primary,selection:spec.selected,time:spec.at,source:clip.src,seconds,viewerSeconds})
})
test.after(()=>{if(process.env.ARYA_MATCH_FRAME_RECEIPT)fs.writeFileSync(process.env.ARYA_MATCH_FRAME_RECEIPT,JSON.stringify({scope:'Actual shared project sourceTime oracle; native fixture must compare actual NativeMatchFrame target/controller after compilation',cases:receipts},null,2)+'\n')})
