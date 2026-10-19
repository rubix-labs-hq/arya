import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOps, newProject } from '../../editor/core/project.js';
import { framePlan } from '../../editor/core/render-plan.js';
const directory=path.dirname(fileURLToPath(import.meta.url)), sourceDirectory=path.join(directory,'../App/Shared/NativeEditor');
const swift=fs.readFileSync(path.join(sourceDirectory,'NativeVectorEditingOverlay.swift'),'utf8');
let checks=0;
const check=(test,message)=>{assert.ok(test,message);checks++};
const equal=(a,b)=>{assert.deepEqual(a,b);checks++};
const near=(a,b)=>check(Number.isFinite(a)&&Math.abs(a-b)<1e-7,`${a} is not near ${b}`);
const props=['x','y','scale','scaleX','scaleY','rotation','anchorX','anchorY'];
function valid(point) {return Array.isArray(point)&&point.length===2&&point.every(n=>Number.isFinite(n)&&Math.abs(n)<=1e6)}
function pathData(clip) {
 const p=clip.shape?.path;
 if(!p||!Array.isArray(p.vertices)||p.vertices.length<2||p.vertices.length>512||!p.vertices.every(valid)||p.closed!==undefined&&typeof p.closed!=='boolean'||Object.keys(p).some(k=>!['vertices','in','out','closed'].includes(k)))throw Error('path');
 for(const key of ['in','out'])if(p[key]!==undefined&&(!Array.isArray(p[key])||p[key].length>p.vertices.length||!p[key].every(valid)))throw Error('tangent');
 return structuredClone(p);
}
function validate(clip,tracks,anchor) {
 if(clip.locked||['audio','null'].includes(clip.kind))throw Error('locked');
 if(clip.kind==='title'&&(clip.title?.anim??'none')!=='none')throw Error('title');
 const seen=new Set();let current=clip;
 while(true) {
  if(seen.has(current.id)||seen.size>=32)throw Error('parent');seen.add(current.id);
  if(props.some(p=>current.expr?.[p]!==undefined))throw Error('expression');
  if(anchor&&current.id===clip.id&&props.some(p=>current.anim?.[p]!==undefined))throw Error('animation');
  if(!current.parent)break;
  const found=tracks.flatMap(t=>t.clips).filter(c=>c.id===current.parent);if(found.length!==1)throw Error('parent');current=found[0];
 }
 if(!anchor) {if(Object.keys(clip.nodes??{}).length||clip.effects?.some(e=>e.type==='mirror'&&e.enabled!==false))throw Error('post transform');if(clip.kind!=='shape'||clip.shape.type!=='path'||Object.keys(clip.anim??{}).some(p=>p.startsWith('shape.'))||Object.keys(clip.expr??{}).some(p=>p.startsWith('shape.')))throw Error('shape');pathData(clip)}
}
const samePoint=(a,b)=>Math.abs(a[0]-b[0])+Math.abs(a[1]-b[1])<1e-8;
function operation(clip,draw,target,local) {
 if(!valid(local))throw Error('point');
 if(target.kind==='anchor') {
  const p=draw.editTransform,dx=local[0]-p.anchorX,dy=local[1]-p.anchorY;
  if(Math.abs(dx)+Math.abs(dy)<1e-8)return [];
  const r=p.rotation*Math.PI/180,sx=p.scale*(p.scaleX??1),sy=p.scale*(p.scaleY??1);
  if(![r,sx,sy].every(Number.isFinite)||Math.abs(sx*sy)<=1e-9)throw Error('transform');
  const x=p.x+Math.cos(r)*sx*dx-Math.sin(r)*sy*dy,y=p.y+Math.sin(r)*sx*dx+Math.cos(r)*sy*dy;
  if(!valid([x,y]))throw Error('position');
  return [{op:'update',id:clip.id,set:{anchorX:local[0],anchorY:local[1],x,y}}];
 }
 const p=pathData(clip),i=target.index;
 if(i<0||i>=p.vertices.length)throw Error('index');
 if(target.kind==='vertex') {if(samePoint(local,p.vertices[i]))return [];p.vertices[i]=local;}
 else {
  const key=target.kind==='incoming'?'in':'out',next=local.map((n,j)=>n-p.vertices[i][j]);
  if(samePoint(next,p[key]?.[i]??[0,0]))return [];
  p[key]??=[];while(p[key].length<p.vertices.length)p[key].push([0,0]);if(!valid(next))throw Error('tangent');p[key][i]=next;
 }
 if(JSON.stringify(p)===JSON.stringify(clip.shape.path))return [];
 return [{op:'update',id:clip.id,set:{shape:{path:p}}}];
}
const scope=(p,comp)=>comp?p.comps[comp]:p;
const selected=(p,comp)=>scope(p,comp).tracks.flatMap(t=>t.clips).find(c=>c.id==='c1');
const draw=(p,comp,t=1)=>framePlan(p,t,comp).layers.find(l=>l.clip?.id==='c1').clip;
const fixtures=[];
for(const comp of [null,'k1'])for(const sign of [1,-1])for(const rotation of [0,31,127]) {
 let p=applyOps(newProject('Anchor and path',{width:1080,height:1920}),[{op:'add_comp',width:1080,height:1920}]).project;
 p=applyOps(p,[{op:'add_shape',comp,track:'V1',dur:4,shape:{type:'path',path:{closed:true,vertices:[[-100,-80],[120,-80],[0,130]],in:[[0,0],[-30,20],[0,-25]],out:[[25,0],[30,15],[0,0]]},fill:{color:'#00ff00'},stroke:{color:'#ff0000',width:6,join:'round'},trim:{start:0,end:0.8,offset:0.1}},set:{x:300,y:420,rotation,scale:sign*1.2,scaleX:1.7,scaleY:0.6,anchorX:5,anchorY:-7,crop:{l:0.15,r:0.1,t:0.05,b:0.08}}},{op:'add_null',comp,track:'V2',dur:4,set:{x:400,y:500}},{op:'parent',comp,id:'c1',parent:'c2'},{op:'update',comp,id:'c2',set:{rotation:28,scaleX:2,scaleY:0.55}}]).project;
 const before=draw(p,comp),clip=selected(p,comp),snapshot=JSON.stringify(p);
 validate(clip,scope(p,comp).tracks,true);checks++;
 const anchor=[clip.anchorX+24,clip.anchorY-19],ops=operation(clip,before,{kind:'anchor'},anchor).map(o=>({...o,comp}));
 check(ops.length===1&&Object.keys(ops[0].set).length===4);
 const after=applyOps(p,ops).project;
 for(const t of [0.1,1,2.8])for(let i=0;i<6;i++)near(draw(after,comp,t).matrix[i],draw(p,comp,t).matrix[i]);
 equal(selected(after,comp).crop,clip.crop);equal(selected(after,comp).shape,clip.shape);
 equal(framePlan(after,1,comp?null:'k1'),framePlan(p,1,comp?null:'k1'));
 check(JSON.stringify(p)===snapshot);
 equal(operation(clip,before,{kind:'anchor'},[clip.anchorX,clip.anchorY]),[]);
 for(const target of [{kind:'vertex',index:1},{kind:'incoming',index:1},{kind:'outgoing',index:1}]) {
  validate(clip,scope(p,comp).tracks,false);checks++;
  const local=[145,-30],pathOps=operation(clip,before,target,local).map(o=>({...o,comp}));
  const next=applyOps(p,pathOps).project,c=selected(next,comp),actual=draw(next,comp);
  check(c.kind==='shape'&&c.shape.type==='path'&&pathOps.length===1);
  equal(c.shape.fill,clip.shape.fill);equal(c.shape.stroke,clip.shape.stroke);equal(c.shape.trim,clip.shape.trim);equal(c.crop,clip.crop);
  equal(actual.matrix,before.matrix);equal(framePlan(next,1,comp?null:'k1'),framePlan(p,1,comp?null:'k1'));
  if(target.kind==='vertex') {equal(c.shape.path.vertices[1],local);equal(c.shape.path.in,clip.shape.path.in);equal(c.shape.path.out,clip.shape.path.out)}
  else {const key=target.kind==='incoming'?'in':'out';equal(c.shape.path[key][1],local.map((n,j)=>n-clip.shape.path.vertices[1][j]));equal(c.shape.path.vertices,clip.shape.path.vertices)}
  fixtures.push({project:p,comp,clip,draw:before,target,local,ops:pathOps});
 }
 fixtures.push({project:p,comp,clip,draw:before,target:{kind:'anchor'},local:anchor,ops});
}
const base=fixtures[0];

for(const target of [{kind:'vertex',index:0},{kind:'incoming',index:0},{kind:'outgoing',index:0}]) {
 const p=base.clip.shape.path,vertex=p.vertices[0],v=target.kind==='vertex'?[0,0]:(p[target.kind==='incoming'?'in':'out']?.[0]??[0,0]);
 const original=vertex.map((n,i)=>n+v[i]);
 equal(operation(base.clip,base.draw,target,[original[0]+1e-12,original[1]-1e-12]),[]);
 check(operation(base.clip,base.draw,target,[original[0]+1e-6,original[1]]).length===1);
}

for(const property of props) {
 for(const mode of ['expr','anim']) {
  const clip=structuredClone(base.clip);clip[mode]={[property]:mode==='expr'?'value + time':[[0,0],[1,10]]};
  assert.throws(()=>validate(clip,scope(base.project,base.comp).tracks,true));checks++;
 }
}
for(const property of ['shape.path.vertices.0.0','shape.path.in.0.0','shape.stroke.width'])for(const mode of ['expr','anim']) {
 const clip=structuredClone(base.clip);clip[mode]={[property]:mode==='expr'?'value + time':[[0,0],[1,10]]};
 assert.throws(()=>validate(clip,scope(base.project,base.comp).tracks,false));checks++;
}
for(const bad of [[[0]],[[NaN,0]],Array(513).fill([0,0]),[[Infinity,0]]]) {
 const clip=structuredClone(base.clip);clip.shape.path.vertices=bad;assert.throws(()=>pathData(clip));checks++;
}
for(const tangents of [[[0]],[[NaN,0]],Array(4).fill([0,0])]) {
 const clip=structuredClone(base.clip);clip.shape.path.in=tangents;assert.throws(()=>pathData(clip));checks++;
}
const missing=structuredClone(base.clip);delete missing.shape.path.in;delete missing.shape.path.out;
equal(operation(missing,base.draw,{kind:'incoming',index:1},missing.shape.path.vertices[1]),[]);
const opened=structuredClone(missing);opened.shape.path.closed=false;
const openOps=operation(opened,base.draw,{kind:'outgoing',index:0},[-70,-60]);check(openOps[0].set.shape.path.closed===false);
const parentExpr=structuredClone(scope(base.project,base.comp).tracks);parentExpr.flatMap(t=>t.clips).find(c=>c.id==='c2').expr={rotation:'time * 3'};assert.throws(()=>validate(base.clip,parentExpr,true));checks++;
for(const mutation of [{effects:[{type:'mirror',params:{axis:'x'}}]},{nodes:{list:[{id:'n1',type:'source'}],links:[]}}]) {const clip={...structuredClone(base.clip),...mutation};assert.throws(()=>validate(clip,scope(base.project,base.comp).tracks,false));checks++}
const title={...structuredClone(base.clip),kind:'title',title:{anim:'rise'}};assert.throws(()=>validate(title,scope(base.project,base.comp).tracks,true));checks++;
for(const contract of ['source.viewport.project(screen)','source.layer.inverse','model.beginRenderPreview','model.preview(operations, capture: source.capture)','pointerChanged(start: $0.startLocation, location: $0.location)','pointerEnded(location: $0.location)','model.renderPreviewCommitMatches','queued?.capture.id == source.capture.id','queued = nil','operation["comp"] = source.capture.composition as Any? ?? NSNull()','"expectedVersion": source.capture.version','model.call("/api/ops", body)','model.renderPreviewBackendID == source.backendID','source.viewport.layout == viewport.layout','model.selectedID == source.clip.id','NSDictionary(dictionary: track.fields).isEqual(to: source.track.fields)','.onDisappear { cancel() }','.onChange(of: viewport.layout) { _, next in updateLayout(next) }','.onChange(of: ObjectIdentifier(model))','layer.localRect.contains','Anchor compensation requires a layer without transform keyframes.'])check(swift.includes(contract),contract);
const viewer=fs.readFileSync(path.join(sourceDirectory,'NativeViewer.swift'),'utf8');check(viewer.includes('.id("\\(vectorMode):\\(canvasZoom)")'));check(viewer.indexOf('if let controller = model.viewerColorWindow')<viewer.indexOf('else if dispatch == .vector, let vectorMode'));check(viewer.includes('model.viewerColorWindow?.invalidateIfChanged()'));
const fixtureFile=path.join(directory,'../ReelKit/Tests/ReelKitTests/Fixtures/vector-editing-requests.json');
if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify(fixtures,null,2)+'\n');
else equal(JSON.parse(fs.readFileSync(fixtureFile,'utf8')),JSON.parse(JSON.stringify(fixtures)));
console.log(`Passed ${checks} actual shared-core/reference assertions and source-contract checks. Swift planner, native gestures and renderer pixels did not execute.`);
