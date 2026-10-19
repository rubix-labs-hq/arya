import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { newProject, applyOps, findClip } from '../core/project.js'
import { buildShortsOps, proposeShorts } from '../core/shorts.js'
const here=path.dirname(fileURLToPath(import.meta.url))
const words=Array.from({length:80},(_,i)=>({t:i,end:i+.8,text:i%10===9?'sentence.':`word${i}`}))
function fixture() {
 let p=newProject('Preserved original')
 p.assets['media/talk.mov']={duration:120,hasVideo:true,hasAudio:true,width:1920,height:1080}
 return applyOps(p,[{op:'add_comp',name:'Authored original',width:640,height:480},{op:'add_clip',comp:'k1',src:'media/talk.mov',in:10,start:3,dur:8,set:{speed:2}},{op:'comp_clip',target:'k1',start:2,dur:4}]).project
}
const body=(captions=false)=>({src:'media/talk.mov',locale:'en-US',ranges:[{from:20.25,to:38.75,name:'Edited opening'}],width:1080,height:1920,captionStyle:'karaoke',captions,words:captions?words:[],apply:false,expectedVersion:12,expectedSourceFingerprint:'source-v1',expectedTranscriptRevision:3})
test('real proposal ranges can be renamed and trimmed before a nonmutating preflight',()=>{
 const p=fixture(),original=structuredClone(p),result=proposeShorts(words,{minDur:15,maxDur:25,count:2})
 assert.ok(result.candidates.length)
 const proposed=result.candidates[0],edited={from:proposed.from+.5,to:proposed.to-.5,name:'Edited speech range'}
 const plan=buildShortsOps(p,{...body(),ranges:[edited]})
 assert.deepEqual(p,original);assert.equal(plan.comps[0].name,edited.name)
 assert.equal(plan.comps[0].from,edited.from);assert.equal(plan.comps[0].to,edited.to)
})
test('captions omitted creates linked native media with edited name/range and preserves all original timings and refs',()=>{
 const p=fixture(),original=structuredClone(p),request=body(),plan=buildShortsOps(p,request),q=applyOps(p,plan.ops).project
 assert.deepEqual(p,original);assert.deepEqual(q.tracks,original.tracks);assert.deepEqual(q.comps.k1,original.comps.k1)
 const c=q.comps[plan.comps[0].id],v=c.tracks.find(t=>t.kind==='video').clips[0],a=c.tracks.find(t=>t.kind==='audio').clips[0]
 assert.equal(c.name,'Edited opening');assert.equal(c.width,1080);assert.equal(c.height,1920);assert.equal(v.in,20.25);assert.equal(v.dur,18.5);assert.equal(a.link,v.link)
 assert.equal(c.tracks.some(t=>t.kind==='caption'),false)
 assert.equal(findClip(q,original.tracks.flatMap(t=>t.clips)[0].id).clip.comp,'k1')
})
test('caption choice creates editable caption words inside the reviewed source range only',()=>{
 const p=fixture(),plan=buildShortsOps(p,body(true)),q=applyOps(p,plan.ops).project,c=q.comps[plan.comps[0].id],captions=c.tracks.find(t=>t.kind==='caption')
 assert.equal(captions.style.preset,'karaoke');assert.equal(captions.burnIn,true)
 const retained=captions.clips.flatMap(c=>c.words.map(w=>({...w,t:c.start+w.t,end:c.start+w.end})))
 assert.ok(retained.length);assert.ok(retained.every(w=>w.sourceT>=20&&w.sourceEnd<=39));assert.ok(retained.every(w=>w.t>=-1/30&&w.end<=18.5+1/30))
})
test('exact reviewed inputs return the same plan and existing nested composition allocation remains untouched',()=>{
 const p=fixture(),b=body(true),review=buildShortsOps(p,b),create=buildShortsOps(p,{...b,apply:true})
 assert.deepEqual(create,review)
 const q=applyOps(p,create.ops).project
 assert.deepEqual(q.comps.k1,p.comps.k1);assert.ok(q.comps.k2)
})
test('invalid edited source ranges reject before producing operations or mutating source project',()=>{
 const p=fixture(),original=structuredClone(p)
 for(const range of [{from:-1,to:5},{from:5,to:5},{from:5,to:4},{from:119,to:121},{from:NaN,to:6},{from:5,to:Infinity},{from:0,to:601}]) assert.throws(()=>buildShortsOps(p,{...body(),ranges:[range]}),/inside/)
 assert.throws(()=>buildShortsOps(p,{...body(),ranges:Array(21).fill({from:1,to:3})}),/1 to 20/)
 assert.deepEqual(p,original)
})
test('audio-only source remains audio-only and square/landscape plans retain requested dimensions',()=>{
 const p=fixture();p.assets['media/talk.mov'].hasVideo=false
 for(const [width,height] of [[1080,1080],[1920,1080]]) {
  const plan=buildShortsOps(p,{...body(),width,height}),q=applyOps(p,plan.ops).project,c=q.comps[plan.comps[0].id]
  assert.equal(c.width,width);assert.equal(c.height,height);assert.equal(c.tracks.flatMap(t=>t.clips).filter(x=>x.kind==='video').length,0)
  assert.equal(c.tracks.find(t=>t.kind==='audio').clips[0].in,20.25)
 }
})
const unicodeNames=[
 {input:'😀'.repeat(120),normalized:'😀'.repeat(100)},
 {input:'a'+'😀'.repeat(120),normalized:'a'+'😀'.repeat(99)},
 {input:'x'+'\u0301'.repeat(250),normalized:'x'+'\u0301'.repeat(199)},
 {input:'a'.repeat(198)+'😀',normalized:'a'.repeat(198)+'😀'},
 {input:'a'.repeat(199)+'😀',normalized:'a'.repeat(199)},
 {input:'a'.repeat(200)+'😀',normalized:'a'.repeat(200)},
]
test('native review receipts preserve UTF-16 bounded names and witness the prior grapheme/JS truncation mismatch',()=>{
 const p=fixture()
 const prior='😀'.repeat(120),truncated=buildShortsOps(p,{...body(),ranges:[{...body().ranges[0],name:prior}]}).comps[0].name
 assert.notEqual(truncated,prior);assert.equal(truncated,'😀'.repeat(100))
 for(const name of unicodeNames) {
  assert.ok(name.normalized.length<=200)
  assert.equal(buildShortsOps(p,{...body(),ranges:[{...body().ranges[0],name:name.normalized}]}).comps[0].name,name.normalized)
 }
})
// These real planner receipts are consumed by the prepared Swift controller harness.
const project=fixture(),request=body(false),plan=buildShortsOps(project,request)
const context={src:request.src,locale:'en-US',folder:'/owned-project',backend:'backend-a',version:12,comp:'k1',project,file:{path:'/owned-project/media/talk.mov',size:123,stamp:'v1'},revision:3,fingerprint:'source-v1',status:'complete',dirty:false,current:true,words}
if (process.env.ARYA_SHORTS_RECEIPT) fs.writeFileSync(process.env.ARYA_SHORTS_RECEIPT,JSON.stringify({unicodeNames:unicodeNames.map(name=>({...name,response:{...buildShortsOps(project,{...request,ranges:[{...request.ranges[0],name:name.normalized}]}),version:12,sourceFingerprint:'source-v1',transcriptRevision:3}})),context,request,response:{...plan,version:12,sourceFingerprint:'source-v1',transcriptRevision:3},created:{...plan,applied:true,version:13,project:applyOps(project,plan.ops).project},saved:{src:request.src,locale:'en-US',revision:3,fingerprint:'source-v1',status:'complete',words:words.map(w=>({...w,confidence:.9}))}},null,2)+'\n')
