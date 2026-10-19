import assert from 'node:assert/strict'
import test from 'node:test'
import {applyOps,findClip,newProject} from '../core/project.js'
import {framePlan} from '../core/render-plan.js'

const project = ops => applyOps(newProject('Frame plan',160,90,30),ops).project

test('frame plan resolves node windows, masks and shapes at clip-local time',()=>{
 const p=project([
  {op:'add_shape',track:'V1',start:2,dur:5,shape:{type:'rect',width:40}},
  {op:'node_add',id:'c1',node:{type:'corrector',window:{type:'rect',x:.2,y:.5,w:.4,h:.6},grade:{saturation:0},enabled:false}},
  {op:'add_mask',id:'c1',mask:{id:'m1',type:'rect',x:0,y:0,w:40,h:30}},
  {op:'expression',id:'c1',prop:'node.n4.window.x',expr:'value + time * .1'},
  {op:'expression',id:'c1',prop:'mask.m1.x',expr:'value + time * 10'},
  {op:'expression',id:'c1',prop:'shape.width',expr:'value + time * 5'},
 ])
 const c=framePlan(p,4).layers[0].clip
 assert.deepEqual(c.nodes.list.map(n=>n.id),['n1','n2','n4','n3'])
 assert.equal(c.nodes.list[2].enabled,false)
 assert.equal(c.nodes.list[2].window.x,.4)
 assert.equal(c.masks[0].x,20); assert.equal(c.shape.width,50)
 assert.doesNotThrow(()=>JSON.stringify(c))
})

test('parent motion and expression transforms use the same timeline time',()=>{
 const p=project([
  {op:'add_shape',track:'V1',dur:3,set:{x:40,y:45}},
  {op:'add_null',track:'V2',dur:3,set:{x:80,y:45}},
  {op:'parent',id:'c1',parent:'c2'},
  {op:'keyframe',id:'c2',prop:'x',at:0,value:80,local:true},
  {op:'keyframe',id:'c2',prop:'x',at:2,value:120,local:true},
  {op:'expression',id:'c1',prop:'y',expr:'value + time * 2'},
 ])
 assert.deepEqual(framePlan(p,1).layers[0].clip.matrix,[1,0,0,1,60,47])
})

test('nested composition time follows in, speed and reverse with confined media names',()=>{
 let p=project([
  {op:'add_comp',name:'Nested',width:80,height:45,duration:6},
  {op:'add_color',comp:'k1',track:'V1',dur:6,color:'#ff0000'},
  {op:'comp_clip',target:'k1',track:'V1',start:2,in:1,dur:2,set:{speed:2,reverse:true}},
 ])
 // Timing fields are clip properties even when a host uses the update operation.
 p=applyOps(p,[{op:'update',id:'c2',set:{in:1,speed:2,reverse:true}}]).project
 const child=framePlan(p,3).layers[0].clip.composition
 assert.equal(child.width,80);assert.equal(child.height,45);assert.equal(child.time,3)
})

test('multicam plan resolves a cut and its angle source offset',()=>{
 let p=newProject('Multicam',160,90,30)
 p.assets={'media/a.mp4':{duration:10,width:160,height:90,fps:30,hasVideo:true},'media/b.mp4':{duration:10,width:160,height:90,fps:30,hasVideo:true}}
 p=applyOps(p,[{op:'make_multicam',srcs:['media/a.mp4','media/b.mp4'],offsets:[0,.25],track:'V1',dur:5},{op:'multicam_cut',id:'c1',at:2,angle:1}]).project
 assert.equal(framePlan(p,1).layers[0].clip.src,'media/a.mp4')
 const c=framePlan(p,2).layers[0].clip
 assert.equal(c.src,'media/b.mp4');assert.equal(c.srcTime,2.25)
})

test('transitions, title animation and hidden layers remain resolved instructions',()=>{
 const p=project([
  {op:'add_color',track:'V1',dur:2,color:'#ff0000'},
  {op:'add_color',track:'V1',start:2,dur:2,color:'#0000ff'},
  {op:'transition',id:'c2',type:'dipBlack',dur:1},
  {op:'add_title',track:'V2',start:0,dur:4,text:'Words',title:{anim:'typewriter'}},
 ])
 const plan=framePlan(p,2)
 assert.equal(plan.layers[0].transition,'dipBlack');assert.equal(plan.layers[0].progress,.5)
 assert.equal(plan.layers[1].clip.titleState.chars,5)
 p.tracks[1].hidden=true
 assert.equal(framePlan(p,2).layers.length,1)
 findClip(p,'c2').clip.enabled=false
 assert.equal(framePlan(p,3).layers.length,0)
})
