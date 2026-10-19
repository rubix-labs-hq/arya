import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyOps, newProject } from '../../editor/core/project.js';
import { framePlan } from '../../editor/core/render-plan.js';
let checks = 0;
const ok = value => { assert.ok(value); checks++; };
const eq = (a,b) => { assert.deepEqual(a,b); checks++; };
const near = (a,b) => ok(Math.abs(a-b) < 1e-8);
let project = applyOps(newProject('Window draft', {width:1920,height:1080}), [
 {op:'add_shape',dur:4,shape:{type:'rect',width:100,height:50,fill:{color:'#336699'}}},
 {op:'node_add',id:'c1',node:{id:'window',type:'corrector',window:{type:'rect',x:.5,y:.5,w:.4,h:.3,rotation:32,softness:.15,invert:false,tracking:{retained:true}},qualifier:{hue:[12,40],sat:[.2,.8],lum:[.1,.9],soft:.07},grade:{exposure:-1}}},
 {op:'add_null',track:'V2',dur:4,set:{x:960,y:540}},
 {op:'parent',id:'c1',parent:'c2'},
 {op:'update',id:'c2',set:{x:960,y:540,scaleX:2,scaleY:.5,rotation:23}},
 {op:'update',id:'c1',set:{x:430,y:200,scaleX:1.4,scaleY:.8,rotation:41,crop:{l:.05,r:.1,t:.02,b:.05}}},
 {op:'add_comp',width:900,height:1400,duration:4},
 {op:'add_shape',comp:'k1',dur:4,set:{id:'c1'},shape:{type:'rect',width:100,height:50,fill:{color:'#dd6600'}}},
 {op:'node_add',comp:'k1',id:'c1',node:{id:'window',type:'corrector',window:{type:'circle',x:.5,y:.5,w:.4,h:.3,rotation:32,softness:.15,invert:true},qualifier:{hue:[12,40]},grade:{exposure:1}}}
]).project;
const fixtures = [];
const shader = fs.readFileSync(new URL('../ReelKit/Sources/ReelKit/Rendering/MetalShaders.swift',import.meta.url),'utf8');
ok(shader.includes('d.x *= uAspect;'));
ok(shader.includes('float2x2(float2(cs, -sn), float2(sn, cs)) * d;'));
ok(shader.includes('uWinSize * 0.5 * float2(uAspect, 1.0)'));
const apply = (m,p) => [m[0]*p[0]+m[2]*p[1]+m[4],m[1]*p[0]+m[3]*p[1]+m[5]];
const inv = m => {const d=m[0]*m[3]-m[1]*m[2];return [m[3]/d,-m[1]/d,-m[2]/d,m[0]/d,(m[2]*m[5]-m[3]*m[4])/d,(m[1]*m[4]-m[0]*m[5])/d];};
function localUV(p,m,w,h) {const q=apply(inv(m),p);return [q[0]/w+.5,q[1]/h+.5];}
function boundary(window,aspect,angle) {
 const a=window.rotation*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
 const q=[Math.cos(angle)*window.w*aspect/2,Math.sin(angle)*window.h/2];
 return [window.x+(c*q[0]-s*q[1])/aspect,window.y+s*q[0]+c*q[1]];
}
for (const comp of [null,'k1']) {
 const scope=comp?project.comps[comp]:project;
 const clip=scope.tracks.flatMap(t=>t.clips).find(c=>c.id==='c1');
 const graph=clip.nodes; const node=graph.list.find(n=>n.type==='corrector');
 const draw=framePlan(project,1,comp).layers.find(l=>l.clip?.id==='c1').clip;
 const m=draw.matrix;
 if(comp===null) ok(Math.abs(m[0]*m[2]+m[1]*m[3])>.1);
 // This texture pair models independent renderer clamps. It is deliberately different from the fitted layer aspect.
 const planeWidth=2048,planeHeight=900,layerWidth=3840,layerHeight=900,aspect=planeWidth/planeHeight;
 ok(Math.abs(aspect-layerWidth/layerHeight)>1);
 for (let i=0;i<16;i++) {
   const uv=boundary(node.window,aspect,i*Math.PI/8);
   const world=apply(m,[(uv[0]-.5)*layerWidth,(uv[1]-.5)*layerHeight]);
   const restored=localUV(world,m,layerWidth,layerHeight);near(restored[0],uv[0]);near(restored[1],uv[1]);
   const a=node.window.rotation*Math.PI/180,dx=(uv[0]-node.window.x)*aspect,dy=uv[1]-node.window.y;
   const x=Math.cos(a)*dx+Math.sin(a)*dy,y=-Math.sin(a)*dx+Math.cos(a)*dy;
   near(Math.hypot(x/(node.window.w*aspect/2),y/(node.window.h/2)),1);
 }
 const before=JSON.stringify(project);
 for(const patch of [{x:.56,y:.62},{w:.6,h:.2},{rotation:-70},{softness:.31},{invert:!node.window.invert}]) {
   const operation={op:'node_update',id:'c1',node:node.id,comp,set:{window:patch}};
   const result=applyOps(project,[operation]).project;
   eq(JSON.stringify(project),before);
   const target=(comp?result.comps[comp]:result).tracks.flatMap(t=>t.clips).find(c=>c.id==='c1').nodes.list.find(n=>n.id===node.id);
   eq(target.qualifier,node.qualifier);eq(target.grade,node.grade);eq(target.window,{...node.window,...patch});eq(target.type,node.type);
   eq(comp?result.tracks:result.comps.k1,comp?project.tracks:project.comps.k1);
   eq(target.window.tracking,node.window.tracking);
   const evaluated=framePlan(result,1,comp).layers.find(l=>l.clip?.id==='c1').clip.nodes.list.find(n=>n.id===node.id);
   for(const [key,value] of Object.entries(patch)) eq(evaluated.window[key],value);
 }
 fixtures.push({comp,project,clip,draw,node,nodePlaneWidth:planeWidth,nodePlaneHeight:planeHeight,layerWidth,layerHeight});
}
const ordered = applyOps(newProject('Window adjustment order'), [
 {op:'add_shape',track:'V1',dur:3,shape:{type:'rect',width:20,height:20}},
 {op:'adjustment',track:'V2',dur:3,set:{effects:[{type:'mirror',params:{axis:'x'}}]}}
]).project;
const upper=framePlan(ordered,1).layers.map(l=>l.clip);
eq(upper.map(c=>c.kind),['shape','adjustment']);eq(upper[1].fx,{mirror:'x'});
const moved=applyOps(ordered,[{op:'move',id:'c1',track:'V3',start:0}]).project;
const lower=framePlan(moved,1).layers.map(l=>l.clip);
eq(lower.map(c=>c.kind),['adjustment','shape']);eq(lower[0].fx,{mirror:'x'});
fs.mkdirSync(new URL('../../build/native-wave6-color-window-draft/',import.meta.url),{recursive:true});
fs.writeFileSync(new URL('../../build/native-wave6-color-window-draft/shared-core-fixtures.json',import.meta.url),JSON.stringify(fixtures,null,2));
console.log(`Passed ${checks} shared-core edits and shader-coordinate reference checks. These shared-core checks do not execute Swift or Metal.`);
