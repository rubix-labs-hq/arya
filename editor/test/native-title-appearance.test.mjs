import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { applyOps, compView, newProject, round, ease } from '../core/project.js'
import { framePlan } from '../core/render-plan.js'

// Core receipts are a proposed-operation oracle for the prepared Swift fixture.
// Node runs the real core and draw-plan source; it does not execute Swift controls.
const inspector = fs.readFileSync(new URL('../../native/App/Shared/NativeEditor/NativeInspector.swift', import.meta.url), 'utf8')
const rasterizer = fs.readFileSync(new URL('../../native/ReelKit/Sources/ReelKit/Rendering/NativeRasterizer.swift', import.meta.url), 'utf8')
const receipt = { cases: [] }
const actions = [
 ['color', '#D95D18FF', { color:'#d95d18ff',gradient:null }],
 ['gradientEnabled', true, { gradient:['#ffffff','#7aa8ff'] }],
 ['gradientEnabled', false, { gradient:null }],
 ['gradientStart', '#f60', { gradient:['#ff6600','#7aa8ff'] }],
 ['gradientEnd', '#aBcD', { gradient:['#ffffff','#aabbccdd'] }],
 ['italic', true, { italic:true }], ['italic', false, { italic:null }],
 ['lineHeight',1.4,{lineHeight:1.4}],
 ['strokeEnabled',true,{stroke:{color:'#102030',width:4}}],['strokeEnabled',false,{stroke:null}],
 ['strokeColor','#00ff88',{stroke:{color:'#00ff88'}}],['strokeWidth',6.5,{stroke:{width:6.5}}],
 ['shadowEnabled',true,{shadow:{color:'#123456aa',blur:14,x:2,y:7}}],['shadowEnabled',false,{shadow:null}],
 ['shadowColor','#0009',{shadow:{color:'#00000099'}}], ['shadowBlur',20,{shadow:{blur:20}}],
 ['shadowX',-12,{shadow:{x:-12}}],['shadowY',-8,{shadow:{y:-8}}],
 ['plateEnabled',true,{plate:'#334455b0'}],['plateEnabled',false,{plate:null}],
 ['plateColor','#abcd',{plate:'#aabbccdd'}], ['padding',32,{padding:32}],['radius',18,{radius:18}],
]
function fixture(nested=false, multi=false) {
 let p=newProject('Appearance scope',{width:640,height:360,fps:30})
 p=applyOps(p,[{op:'add_title',text:'Root unchanged',start:0,dur:12,track:'V1',title:{anim:'none'}}]).project
 if(nested)p=applyOps(p,[{op:'add_comp',id:'k1',name:'Imported title',width:640,height:360,fps:30,tracks:[{id:'V1',kind:'video',clips:[]}]}]).project
 const comp=nested?'k1':null, title={text:'Editable title\nSecond line',font:'Inter',weight:800,size:60,color:'#ffffff',gradient:['#ffffff','#7aa8ff'],align:'center',lineHeight:1.15,stroke:{color:'#102030',width:4},shadow:{color:'#123456aa',blur:14,x:2,y:7},plate:'#334455b0',padding:24,radius:10,anim:'none'}
 p=applyOps(p,[{op:'add_title',comp,text:title.text,start:2,dur:5,track:nested?'V1':'V2',title},{op:'add_title',comp,text:'Other title',start:2,dur:5,track:nested?'V2':'V3',title:{anim:'none'}}]).project
 const view=compView(p,comp),clip=view.tracks.flatMap(t=>t.clips).find(c=>c.title?.text===title.text),selection=[clip.id]
 p=applyOps(p,[{op:'update',comp,id:clip.id,set:{note:'Imported source metadata',figma:{nodeId:'12:34'},expr:{opacity:'value * 0.8'}}},{op:'keyframe',comp,id:clip.id,prop:'x',at:0,local:true,value:120},{op:'keyframe',comp,id:clip.id,prop:'x',at:5,local:true,value:160}]).project
 if(multi){const other=compView(p,comp).tracks.flatMap(t=>t.clips).find(c=>c.title?.text==='Other title');p=applyOps(p,[{op:'update',comp,id:other.id,set:{title}}]).project;selection.push(other.id)}
 return {p,comp,id:clip.id,selection:selection.sort(),primary:clip.id,time:4}
}
const clip=(p,f,id=f.id)=>compView(p,f.comp).tracks.flatMap(t=>t.clips).find(c=>c.id===id)
const plannedTitle=(p,f,id=f.id)=>framePlan(p,f.time,f.comp).layers.flatMap(l=>[l.clip,l.a,l.b]).find(c=>c?.id===id)?.title
function retain(before,after,f,ids=f.selection){
 assert.deepEqual(after.assets,before.assets)
 assert.deepEqual(after.library,before.library)
 if(f.comp)assert.deepEqual(after.tracks,before.tracks)
 for(const id of ids){const a=clip(after,f,id),b=clip(before,f,id);for(const key of ['note','figma','start','dur','parent','src','in','speed','expr'])assert.deepEqual(a[key],b[key]);assert.deepEqual(a.anim?.x,b.anim?.x)}
 const others=compView(before,f.comp).tracks.flatMap(t=>t.clips).filter(c=>!ids.includes(c.id))
 for(const c of others)assert.deepEqual(clip(after,f,c.id),c)
}
for(const nested of [false,true])for(const [action,value,patch]of actions)test(`Actual core/draw-plan ${nested?'nested':'main'} ${action} ${value}`,()=>{
 const f=fixture(nested),before=structuredClone(f.p),ops=f.selection.map(id=>({op:'update',id,comp:f.comp,set:{title:patch}})),changed=applyOps(f.p,ops).project
 const t=clip(changed,f).title,resolved=plannedTitle(changed,f)
 for(const[k,v]of Object.entries(patch))if(v===null){assert.equal(t[k],undefined);assert.equal(resolved[k],undefined)}else if(typeof v==='object'&&!Array.isArray(v)){for(const[field,x]of Object.entries(v)){assert.deepEqual(t[k][field],x);assert.deepEqual(resolved[k][field],x)}}else{assert.deepEqual(t[k],v);assert.deepEqual(resolved[k],v)}
 retain(before,changed,f);assert.deepEqual(f.p,before)
 receipt.cases.push({project:before,composition:f.comp,selection:f.selection,primary:f.primary,time:f.time,action,value,ops})
})
test('A title group uses one scoped batch, preserves other tracks, and is one undoable project snapshot',()=>{
 const f=fixture(true,true),before=structuredClone(f.p),ops=f.selection.map(id=>({op:'update',id,comp:f.comp,set:{title:{gradient:null,color:'#d95d18'}}})),changed=applyOps(f.p,ops).project
 for(const id of f.selection)assert.equal(plannedTitle(changed,f,id).color,'#d95d18')
 retain(before,changed,f);assert.deepEqual(f.p,before)
 receipt.cases.push({project:before,composition:f.comp,selection:f.selection,primary:f.primary,time:f.time,action:'color',value:'#d95d18',ops})
})
for(const [action,prop,value]of [['lineHeight','title.lineHeight',1.6],['strokeWidth','title.stroke.width',8],['shadowBlur','title.shadow.blur',24],['shadowX','title.shadow.x',-20],['shadowY','title.shadow.y',-14],['padding','title.padding',40],['radius','title.radius',25]])test(`Existing ${prop} keys retain easing and use captured local playhead`,()=>{
 const f=fixture(true);f.p=applyOps(f.p,[{op:'keyframe',comp:f.comp,id:f.id,prop,local:true,at:0,value:1,ease:'inOut'},{op:'keyframe',comp:f.comp,id:f.id,prop,local:true,at:5,value:3}]).project
 const before=structuredClone(f.p),ops=[{op:'keyframe',id:f.id,comp:f.comp,prop,local:true,at:2,value}],changed=applyOps(f.p,ops).project
 assert.deepEqual(clip(changed,f).anim[prop],[[0,1,'inOut'],[2,value],[5,3]])
 assert.equal(prop.split('.').slice(1).reduce((o,k)=>o[k],plannedTitle(changed,f)),value)
 assert.deepEqual(clip(changed,f).title,clip(before,f).title);retain(before,changed,f)
 receipt.cases.push({project:before,composition:f.comp,selection:f.selection,primary:f.primary,time:f.time,action,value,ops})
})
for(const [action,key,patch]of [['strokeEnabled','stroke',{color:'#000000',width:3}],['shadowEnabled','shadow',{color:'#00000099',blur:18,x:0,y:6}],['plateEnabled','plate','#000000b0']])test(`Missing ${key} enables actual renderer defaults`,()=>{
 const f=fixture(true);f.p=applyOps(f.p,[{op:'update',id:f.id,comp:f.comp,set:{title:{[key]:null}}}]).project
 const before=structuredClone(f.p),ops=[{op:'update',id:f.id,comp:f.comp,set:{title:{[key]:patch}}}],changed=applyOps(f.p,ops).project
 assert.deepEqual(plannedTitle(changed,f)[key],patch);retain(before,changed,f)
 receipt.cases.push({project:before,composition:f.comp,selection:f.selection,primary:f.primary,time:f.time,action,value:true,ops})
})
for(const [time,at]of [[0,0],[10,5]])test(`Animated edit clamps captured timeline time ${time} to local ${at}`,()=>{
 const f=fixture(true);f.time=time;f.p=applyOps(f.p,[{op:'keyframe',id:f.id,comp:f.comp,prop:'title.lineHeight',local:true,at:0,value:1},{op:'keyframe',id:f.id,comp:f.comp,prop:'title.lineHeight',local:true,at:5,value:2}]).project
 const before=structuredClone(f.p),ops=[{op:'keyframe',id:f.id,comp:f.comp,prop:'title.lineHeight',local:true,at,value:1.5}],changed=applyOps(f.p,ops).project
 assert.equal(clip(changed,f).anim['title.lineHeight'].find(k=>k[0]===at)[1],1.5);retain(before,changed,f)
 receipt.cases.push({project:before,composition:f.comp,selection:f.selection,primary:f.primary,time:f.time,action:'lineHeight',value:1.5,ops})
})
for(const [owner,prop]of [['stroke','title.stroke.width'],['shadow','title.shadow.blur']])test(`Actual resolved title recreates deleted animated ${owner}, requiring a toggle refusal`,()=>{
 const f=fixture(true);f.p=applyOps(f.p,[{op:'keyframe',id:f.id,comp:f.comp,prop,local:true,at:0,value:9}]).project
 const changed=applyOps(f.p,[{op:'update',id:f.id,comp:f.comp,set:{title:{[owner]:null}}}]).project
 assert.equal(clip(changed,f).title[owner],undefined);assert.equal(plannedTitle(changed,f)[owner][prop.split('.').at(-1)],9)
})
// This adapter binds the proposed operation shape to the inspected Swift source.
// It witnesses actual core consequences; Swift planner execution remains a separate gate.
function sourceBoundKeyOperation(f,prop,value){
 const original=clip(f.p,f).anim[prop],at=Math.min(clip(f.p,f).dur,Math.max(0,f.time-clip(f.p,f).start)),near=original.filter(k=>Math.abs(k[0]-round(at))<=1e-3)
 if(inspector.includes('guard replaced.count <= 1')&&near.length>1)throw new Error('Ambiguous neighboring keys')
 const operation={op:'keyframe',id:f.id,comp:f.comp,prop,local:true,at,value}
 if(inspector.includes('operation["ease"] = key[2]')&&near.length===1&&near[0].length===3)operation.ease=structuredClone(near[0][2])
 return operation
}
const numericProperties=[['lineHeight','title.lineHeight'],['strokeWidth','title.stroke.width'],['shadowBlur','title.shadow.blur'],['shadowX','title.shadow.x'],['shadowY','title.shadow.y'],['padding','title.padding'],['radius','title.radius']]
for(const nested of [false,true])for(const [action,prop]of numericProperties)for(const interpolation of ['hold','inOut',[0.3,0,0.7,1]])test(`Source-bound ${nested?'nested':'main'} ${prop} retains existing ${JSON.stringify(interpolation)} ease and outgoing draw plan`,()=>{
 const f=fixture(nested);f.time=4.00004
 f.p=applyOps(f.p,[{op:'keyframe',id:f.id,comp:f.comp,prop,local:true,at:0,value:1,ease:'smooth'},{op:'keyframe',id:f.id,comp:f.comp,prop,local:true,at:2,value:1.5,ease:interpolation},{op:'keyframe',id:f.id,comp:f.comp,prop,local:true,at:5,value:3}]).project
 const before=structuredClone(f.p),ops=[sourceBoundKeyOperation(f,prop,2)],changed=applyOps(f.p,ops).project
 assert.deepEqual(clip(changed,f).anim[prop],[[0,1,'smooth'],[2,2,interpolation],[5,3]])
 f.time=4.4;const expected=2+ease(interpolation,0.4/3),resolved=prop.split('.').slice(1).reduce((o,k)=>o[k],plannedTitle(changed,f));assert(Math.abs(resolved-expected)<1e-10)
 retain(before,changed,f);assert.deepEqual(clip(changed,f).title,clip(before,f).title)
 receipt.cases.push({project:before,composition:f.comp,selection:f.selection,primary:f.primary,time:4.00004,action,value:2,ops})
})
for(const [local,keyTime,matched]of [[2.000049,2,true],[2.000051,2.001,true],[2,2.001,true],[2,2.0011,false]])test(`Core rounded local ${local} replacement boundary ${keyTime} matched=${matched}`,()=>{
 const f=fixture(true);f.time=2+local;f.p=applyOps(f.p,[{op:'keyframe',id:f.id,comp:f.comp,prop:'title.lineHeight',local:true,at:keyTime,value:1.5,ease:'hold'},{op:'keyframe',id:f.id,comp:f.comp,prop:'title.lineHeight',local:true,at:5,value:3}]).project
 const before=structuredClone(f.p),ops=[sourceBoundKeyOperation(f,'title.lineHeight',2)],changed=applyOps(f.p,ops).project,keys=clip(changed,f).anim['title.lineHeight']
 const newKey=keys.find(k=>k[0]===round(local));assert.equal(newKey[1],2);assert.equal(newKey[2],matched?'hold':undefined)
 assert.equal(keys.length,matched?2:3);retain(before,changed,f)
 receipt.cases.push({project:before,composition:f.comp,selection:f.selection,primary:f.primary,time:f.time,action:'lineHeight',value:2,ops})
})
test('An existing linear key stays linear and neighboring easing stays unchanged',()=>{
 const f=fixture(true);f.p=applyOps(f.p,[{op:'keyframe',id:f.id,comp:f.comp,prop:'title.lineHeight',local:true,at:2,value:1.5},{op:'keyframe',id:f.id,comp:f.comp,prop:'title.lineHeight',local:true,at:5,value:3,ease:'hold'}]).project
 const before=structuredClone(f.p),ops=[sourceBoundKeyOperation(f,'title.lineHeight',2)],changed=applyOps(f.p,ops).project
 assert.deepEqual(clip(changed,f).anim['title.lineHeight'],[[2,2],[5,3,'hold']]);retain(before,changed,f)
 receipt.cases.push({project:before,composition:f.comp,selection:f.selection,primary:f.primary,time:f.time,action:'lineHeight',value:2,ops})
})
test('Ambiguous legacy neighboring keys are refused instead of dropping either easing owner',()=>{
 const f=fixture(true);clip(f.p,f).anim['title.lineHeight']=[[2,1.5,'hold'],[2.0009,2,'inOut'],[5,3]];const before=structuredClone(f.p)
 const unsafe=applyOps(f.p,[{op:'keyframe',id:f.id,comp:f.comp,prop:'title.lineHeight',local:true,at:2,value:2,ease:'hold'}]).project
 assert.deepEqual(clip(unsafe,f).anim['title.lineHeight'],[[2,2,'hold'],[5,3]])
 assert.throws(()=>sourceBoundKeyOperation(f,'title.lineHeight',2),/Ambiguous/);assert.deepEqual(f.p,before)
})
test('Actual Swift key branch matches core four-place rounding, inclusive tolerance and easing assignment',()=>{
 for(const snippet of ['let rounded = (local * 10_000).rounded(.toNearestOrAwayFromZero) / 10_000','abs(at.doubleValue - rounded) <= 1e-3','guard replaced.count <= 1','operation["ease"] = key[2]'])assert(inspector.includes(snippet),snippet)
})
test('Expression-owned appearance remains computed by the actual native plan',()=>{
 const f=fixture(true);f.p=applyOps(f.p,[{op:'expression',comp:f.comp,id:f.id,prop:'title.lineHeight',expr:'value + time * 0.1'}]).project
 assert(Math.abs(plannedTitle(f.p,f).lineHeight-1.35)<1e-10);assert.equal(clip(f.p,f).expr['title.lineHeight'],'value + time * 0.1')
})
for(const [label,binding]of [['gradient','Toggle("Gradient"'],['outline','Toggle("Outline"'],['shadow','Toggle("Shadow"'],['plate','Toggle("Plate"'],['italic','Toggle("Italic"'],['line height','numeric("Line height"'],['shadow offsets','numeric("Shadow X"'],['plate geometry','numeric("Corner radius"']])test(`Actual NativeInspector has guarded ${label} control`,()=>{assert(inspector.includes(binding));assert(inspector.includes('NativeTitleAppearanceControls(model: model, clip: clip)'));assert(inspector.includes('capture.data == now.data'));assert(inspector.includes('expectedVersion: capture.version'))})
test('The existing native rasterizer reads every exposed appearance schema',()=>{
 for(const snippet of ['t.flag("italic")','t.number("lineHeight", 1.15)','t["gradient"] as? [String]','t["plate"] as? String','stroke.number("width")','t.number("radius", 10)','shadow.number("blur", 12)','shadow.number("x")','shadow.number("y"','t.number("padding"'])assert(rasterizer.includes(snippet),snippet)
})
test('Actual controller gates source mode, busy/read-only and preserves expression/animation ownership',()=>{
 for(const snippet of ['!model.showingSource','model.projectReadOnlyReason == nil','!model.busy','time: model.time','func expressionOwns','if let raw = clip.dictionary("anim")[property] as? [Any], !raw.isEmpty','try requireStatic(clip, ["title.stroke"])','try requireStatic(clip, ["title.shadow"])'])assert(inspector.includes(snippet),snippet)
})
test.after(()=>{
 if(process.env.ARYA_TITLE_RECEIPT)fs.writeFileSync(process.env.ARYA_TITLE_RECEIPT,JSON.stringify(receipt,null,2)+'\n')
})
