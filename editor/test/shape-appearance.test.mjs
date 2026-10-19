import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { applyOps, compView, newProject } from '../core/project.js'
import { nativeFigmaImport } from '../core/figma-native.js'
const coreURL = new URL('../core/project.js', import.meta.url).href
registerHooks({ resolve(specifier, context, next) { return next(specifier === '/core/project.js' ? coreURL : specifier, context) } })
const moduleURL = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
const key = Symbol.for('arya.shape-appearance.test')
const hostURL = moduleURL(`export const host={events:()=>()=>{},kind:'browser'};export const api=(...args)=>globalThis[Symbol.for('arya.shape-appearance.test')].api(...args);`)
let text = await fs.readFile(new URL('../web/ui/store.js', import.meta.url), 'utf8')
for (const [from, to] of [['preact/hooks', import.meta.resolve('preact/hooks')], ['/core/project.js', coreURL], ['../host.js', hostURL], ['./change-receipt.js', new URL('../web/ui/change-receipt.js', import.meta.url).href]]) text = text.replaceAll("'" + from + "'", JSON.stringify(to))
const oldWidth = globalThis.innerWidth; globalThis.innerWidth = 1440
const storeURL = moduleURL(text), { set, store, viewProject } = await import(storeURL)
if (oldWidth === undefined) delete globalThis.innerWidth; else globalThis.innerWidth = oldWidth
const facade = moduleURL(`export {edit,set,store,viewProject} from ${JSON.stringify(storeURL)};import {store} from ${JSON.stringify(storeURL)};export const useStore=()=>store;export const useTime=()=>0;export const addRef=()=>{};export const time={t:0};export const toast=(...args)=>globalThis[Symbol.for('arya.shape-appearance.test')].notices.push(args);`)
const hooks = moduleURL('export const useRef=value=>({current:value});export const useState=value=>[value,()=>{}];export const useEffect=()=>{};')
const nulls = moduleURL('export const player={};export const openMenu=()=>{};export const registry={inspectors:[],inspectorActions:[]};export const ScrollTabs=()=>null;')
async function load(relative, mappings) {
 let source = await fs.readFile(new URL('../web/ui/' + relative, import.meta.url), 'utf8')
 for (const [from,to] of Object.entries(mappings)) source=source.replaceAll("'"+from+"'",JSON.stringify(to))
 return moduleURL(source)
}
const common = { preact:import.meta.resolve('preact'), 'preact/hooks':hooks, htm:import.meta.resolve('htm'), './store.js':facade }
const shapeURL=await load('shape-appearance.js',common)
const { ShapeAppearance, captureShapeAppearance, shapeAppearanceMatches, shapeAppearanceOps, shapeColor } = await import(shapeURL)
const inspectorURL=await load('inspector.js',{...common,'/core/project.js':coreURL,'./shape-appearance.js':shapeURL,'./menu.js':nulls,'./engine-host.js':nulls,'./registry.js':nulls,'./scroll-tabs.js':nulls,'./icons.js':new URL('../web/ui/icons.js',import.meta.url).href})
const { Inspector } = await import(inspectorURL)
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value,...nodes(value.props?.children)] : []
const control=(tree,label)=>nodes(tree).find(node=>node.type==='input'&&node.props['aria-label']===label)
let paintSource=await fs.readFile(new URL('../web/engine/shapes.js',import.meta.url),'utf8');paintSource=paintSource.replaceAll("'/core/project.js'",JSON.stringify(coreURL)).replace("'./render-resolution.js'",JSON.stringify(new URL('../web/engine/render-resolution.js',import.meta.url).href))+'\nexport { paint as actualPaint }\n';const { actualPaint }=await import(moduleURL(paintSource))
const paintWitness=paint=>actualPaint({createLinearGradient:()=>({gradient:true,addColorStop:()=>{}}),createRadialGradient:()=>({gradient:true,addColorStop:()=>{}})},paint,160,35)
function project({gradient=false,gradientStroke=true}={}) {
 const frame={id:'qa',type:'FRAME',name:'Editable artwork',absoluteBoundingBox:{x:0,y:0,width:640,height:360},fills:[],children:[{id:'qa:plate',type:'RECTANGLE',name:'Plate',absoluteBoundingBox:{x:32,y:174,width:320,height:70},cornerRadius:12,fills:[{type:'SOLID',color:{r:.04,g:.23,b:.55},opacity:.8}]}]}
 if(gradient){const paint={type:'GRADIENT_LINEAR',gradientHandlePositions:[{x:0,y:0},{x:1,y:0},{x:0,y:1}],gradientStops:[{position:0,color:{r:0,g:0,b:0,a:1}},{position:1,color:{r:1,g:1,b:1,a:1}}],opacity:.8};frame.children[0].fills=[paint]}
 let p=newProject('Shape controls' ,{width:640,height:360,fps:30})
 p=applyOps(p,[{op:'add_title',text:'Main unchanged',start:0,dur:12,track:'V1'}]).project
 const imported=nativeFigmaImport(p,frame,{duration:4,placeOnTimeline:true,start:4,track:'V2'})
 p=applyOps(p,imported.ops).project
 const c=p.comps[imported.comp].tracks.flatMap(t=>t.clips).find(c=>c.kind==='shape')
 if(gradient&&gradientStroke)p=applyOps(p,[{op:'update',comp:imported.comp,id:c.id,set:{shape:{stroke:{width:3,gradient:structuredClone(c.shape.fill.gradient)}}}}]).project
 p=applyOps(p,[{op:'keyframe',comp:imported.comp,id:c.id,prop:'x',at:0,value:100,local:true},{op:'keyframe',comp:imported.comp,id:c.id,prop:'x',at:1,value:116,local:true}]).project
 return {p,scope:imported.comp,id:c.id}
}
function fixture(t,options={}) {
 const f=project(options);let backend=f.p,version=7;const history=[],redo=[]
 const env={notices:[],calls:[],api:async(route,body)=>{
  env.calls.push({route,body})
  if(route==='/api/project')return{project:backend,version}
  if(route==='/api/undo'){redo.push(backend);backend=history.pop();return{project:backend,version:++version}}
  if(route==='/api/redo'){history.push(backend);backend=redo.pop();return{project:backend,version:++version}}
  assert.equal(route,'/api/ops');assert.equal(body.expectedVersion,version)
  const changed=applyOps(backend,body.ops).project;history.push(backend);backend=changed;return{project:backend,version:++version}
 }}
 globalThis[key]=env;set({project:backend,version,root:'/owned/shape',openComp:f.scope,selection:[f.id],inspectorTab:'shape'})
 t.after(()=>delete globalThis[key]);env.id=f.id;env.scope=f.scope;env.history=history;env.tree=()=>ShapeAppearance({clip:viewProject().tracks.flatMap(t=>t.clips).find(c=>c.id===env.id)})
 env.clip=()=>viewProject().tracks.flatMap(t=>t.clips).find(c=>c.id===env.id);return env
}
const opCalls=e=>e.calls.filter(c=>c.route==='/api/ops')
test('Actual Edit and Motion shared inspector exposes selected-shape appearance tab', t=>{
 const e=fixture(t),tree=nodes(Inspector());assert(tree.some(n=>n.props?.tabs?.some?.(([id,label])=>id==='shape'&&label==='Shape')))
 const pane=tree.find(n=>n.type===ShapeAppearance);assert(pane);assert.equal(pane.props.clip.id,e.id)
})
test('Actual fill callback makes the imported nested plate orange, preserves metadata/keys/main and supports Undo/Redo',async t=>{
 const e=fixture(t),before=structuredClone(store.project),original=structuredClone(e.clip()),tree=e.tree(),field=control(tree,'Fill hex color')
 field.props.onFocus();await field.props.onChange({target:{value:'#d95d18'}})
 assert.equal(e.clip().shape.fill.color,'#d95d18');assert.equal(e.clip().note,original.note);assert.deepEqual(e.clip().anim,original.anim);assert.deepEqual(store.project.tracks,before.tracks)
 assert.equal(e.clip().shape.radius,original.shape.radius);assert.equal(e.clip().shape.fill.opacity,original.shape.fill.opacity)
 const req=opCalls(e)[0].body;assert.equal(req.expectedVersion,7);assert.equal(req.ops[0].comp,e.scope);assert.equal(e.history.length,1)
 set(await e.api('/api/undo',{}));assert.deepEqual(e.clip(),original)
 set(await e.api('/api/redo',{}));assert.equal(e.clip().shape.fill.color,'#d95d18')
})
test('Actual stroke color, enable and width callbacks preserve existing fill and keys',async t=>{
 const e=fixture(t),fill=structuredClone(e.clip().shape.fill),anim=structuredClone(e.clip().anim)
 await control(e.tree(),'Stroke color').props.onChange({target:{value:'#00ff88'}})
 await control(e.tree(),'Stroke enabled').props.onChange({target:{checked:true}})
 await control(e.tree(),'Stroke width').props.onChange({target:{value:'6.5'}})
 assert.equal(e.clip().shape.stroke.color,'#00ff88');assert.equal(e.clip().shape.stroke.width,6.5);assert.deepEqual(e.clip().shape.fill,fill);assert.deepEqual(e.clip().anim,anim)
 await control(e.tree(),'Stroke enabled').props.onChange({target:{checked:false}})
 assert.equal(e.clip().shape.stroke.width,0);assert.equal(e.clip().shape.stroke.color,'#00ff88')
})
for(const drift of ['root','version','scope','selection','optimistic','locked','metadata'])test('Open shape control rejects '+drift+' drift before an API edit',async t=>{
 const e=fixture(t),field=control(e.tree(),'Fill color');field.props.onFocus()
 if(drift==='root')set({root:'/owned/other'})
 if(drift==='version')set({version:8})
 if(drift==='scope')set({openComp:null})
 if(drift==='selection')set({selection:[]})
 if(drift==='optimistic')set({project:structuredClone(store.project)})
 if(drift==='locked')store.project.comps[e.scope].tracks.find(t=>t.clips.some(c=>c.id===e.id)).locked=true
 if(drift==='metadata')e.clip().note='changed import record'
 await field.props.onChange({target:{value:'#d95d18'}});assert.equal(opCalls(e).length,0);assert.equal(e.notices.length,1)
})
for(const [label,value] of [['Fill hex color','url(bad)'],['Stroke width','NaN'],['Stroke width','-1'],['Stroke width','101']])test('Appearance refuses invalid '+label+' '+value,async t=>{
 const e=fixture(t);await control(e.tree(),label).props.onChange({target:{value}});assert.equal(opCalls(e).length,0);assert.equal(e.notices.length,1)
})
test('Mixed selections and locked tracks disable actual shape controls',t=>{
 const e=fixture(t),shape=e.clip();set({openComp:null,selection:[store.project.tracks[0].clips[0].id]});assert.throws(()=>captureShapeAppearance(store,viewProject(),shape),/shape/i)
 set({openComp:e.scope,selection:[e.id]});store.project.comps[e.scope].tracks.find(t=>t.clips.some(c=>c.id===e.id)).locked=true
 assert.equal(control(e.tree(),'Fill color').props.disabled,true)
})
for(const [field,key] of [['Fill hex color','fill'],['Stroke hex color','stroke']])test('Actual '+field+' callback replaces Figma gradient data and Undo restores it',async t=>{
 const e=fixture(t,{gradient:true}),before=structuredClone(e.clip()),paint=before.shape[key];assert(paint.gradient);assert.equal(paintWitness(paint).gradient,true);assert(nodes(e.tree()).some(n=>String(n.props?.children??'').includes('Choosing a color changes')))
 const input=control(e.tree(),field);input.props.onFocus();await input.props.onChange({target:{value:'#d95d18ff'}})
 const updated=e.clip().shape[key];assert.equal(updated.gradient,undefined);assert.equal(updated.color,'#d95d18ff');assert.equal(paintWitness(updated),'#d95d18ff');assert.equal(e.clip().note,before.note);assert.deepEqual(e.clip().anim,before.anim);assert.equal(e.clip().shape.radius,before.shape.radius);assert.deepEqual(e.clip().shape[key==='fill'?'stroke':'fill'],before.shape[key==='fill'?'stroke':'fill'])
 set(await e.api('/api/undo',{}));assert.deepEqual(e.clip(),before);assert.equal(paintWitness(e.clip().shape[key]).gradient,true)
})

test('A selected group of shapes changes in one request and one Undo entry',async t=>{
 const e=fixture(t),scope=store.project.comps[e.scope],track=scope.tracks.find(t=>t.clips.some(c=>c.id===e.id)),second=structuredClone(e.clip());second.id='second-shape';second.shape.fill.color='#112233';track.clips.push(second);set({selection:[e.id,second.id]})
 const original=structuredClone(track.clips),field=control(e.tree(),'Fill color');field.props.onFocus();await field.props.onChange({target:{value:'#d95d18'}})
 const current=store.project.comps[e.scope].tracks.find(t=>t.id===track.id).clips;assert(current.every(c=>c.shape.fill.color==='#d95d18'));assert.equal(opCalls(e).length,1);assert.equal(opCalls(e)[0].body.ops.length,2);assert.equal(e.history.length,1)
 set(await e.api('/api/undo',{}));assert.deepEqual(store.project.comps[e.scope].tracks.find(t=>t.id===track.id).clips,original)
})
test('Fill disable and enable preserve other properties and Undo restores the imported paint',async t=>{
 const e=fixture(t),original=structuredClone(e.clip());await control(e.tree(),'Fill enabled').props.onChange({target:{checked:false}});assert.equal(e.clip().shape.fill,undefined);assert.deepEqual(e.clip().anim,original.anim)
 set(await e.api('/api/undo',{}));assert.deepEqual(e.clip(),original)
 await control(e.tree(),'Fill enabled').props.onChange({target:{checked:false}});await control(e.tree(),'Fill enabled').props.onChange({target:{checked:true}});assert.equal(e.clip().shape.fill.color,'#f5b942');assert.deepEqual(e.clip().anim,original.anim)
})
test('Actual store refuses another captured appearance edit while its first edit is pending',async t=>{
 const e=fixture(t),api=e.api;let release;const gate=new Promise(resolve=>{release=resolve});e.api=(...args)=>args[0]==='/api/ops'?gate.then(()=>api(...args)):api(...args)
 const first=control(e.tree(),'Fill color').props.onChange({target:{value:'#d95d18'}});await Promise.resolve();assert.equal(e.clip().shape.fill.color,'#d95d18')
 await control(e.tree(),'Stroke color').props.onChange({target:{value:'#00ff88'}});assert.equal(e.clip().shape.stroke?.color,undefined);assert.equal(opCalls(e).length,0)
 release();await first;assert.equal(opCalls(e).length,1);assert.equal(e.history.length,1)
})
test('Missing selected shape yields an actionable capture refusal',t=>{fixture(t);assert.throws(()=>captureShapeAppearance(store,viewProject(),undefined),/Select the shape again/)})

if (process.env.ARYA_SHAPE_RECEIPT) {
 const f=project(),actions=[['fillColor','#abcd'],['fillColor','#d95d18'],['strokeColor','#00ff88'],['strokeWidth',6.5],['fillEnabled',false],['fillEnabled',true],['strokeEnabled',false],['strokeEnabled',true]]
 const cases=actions.map(([action,value])=>{const project=structuredClone(f.p),selection=[f.id],capture=captureShapeAppearance({project,version:7,root:'/owned/shape',openComp:f.scope,selection},compView(project,f.scope),compView(project,f.scope).tracks.flatMap(t=>t.clips).find(c=>c.id===f.id)),ops=shapeAppearanceOps(capture,action,value);return {project,composition:f.scope,selection,primary:f.id,action,value,ops}})
 for(const action of ['fillColor','strokeColor']){const g=project({gradient:true}),gradProject=g.p,selection=[g.id],view=compView(gradProject,g.scope),capture=captureShapeAppearance({project:gradProject,version:7,root:'/owned/shape',openComp:g.scope,selection},view,view.tracks.flatMap(t=>t.clips).find(c=>c.id===g.id)),value='#d95d18ff';cases.push({project:gradProject,composition:g.scope,selection,primary:g.id,action,value,ops:shapeAppearanceOps(capture,action,value)})}
 const multi=structuredClone(f.p),track=multi.comps[f.scope].tracks.find(t=>t.clips.some(c=>c.id===f.id)),second=structuredClone(track.clips[0]);second.id='second-shape';track.clips.push(second);const selection=[f.id,second.id].sort(),capture=captureShapeAppearance({project:multi,version:7,root:'/owned/shape',openComp:f.scope,selection},compView(multi,f.scope),track.clips.find(c=>c.id===selection[0]));cases.push({project:multi,composition:f.scope,selection,primary:selection[0],action:'fillColor',value:'#d95d18',ops:shapeAppearanceOps(capture,'fillColor','#d95d18')})
 await fs.writeFile(process.env.ARYA_SHAPE_RECEIPT,JSON.stringify({evidence:'Actual browser appearance planner and shared core fixture. Native assertions prepared separately.',cases},null,2)+'\n')
}

test('Ambiguous clip IDs disable appearance and submit no partial edit',async t=>{
 const e=fixture(t),duplicate=structuredClone(e.clip()),track=store.project.comps[e.scope].tracks.find(t=>t.clips.some(c=>c.id===e.id));duplicate.shape.fill.color='#223344';track.clips.push(duplicate)
 const field=control(e.tree(),'Fill color');assert.equal(field.props.disabled,true);assert.throws(()=>captureShapeAppearance(store,viewProject(),e.clip()),/uniquely identified/);await field.props.onChange({target:{value:'#d95d18'}});assert.equal(opCalls(e).length,0);assert.equal(e.history.length,0);assert.equal(duplicate.shape.fill.color,'#223344')
})

test('Hex shorthand expands to shared native renderer RGB and RGBA formats',async t=>{
 const e=fixture(t);assert.equal(shapeColor('#AbC'),'#aabbcc');assert.equal(shapeColor('#AbCd'),'#aabbccdd');await control(e.tree(),'Fill hex color').props.onChange({target:{value:'#AbCd'}});assert.equal(e.clip().shape.fill.color,'#aabbccdd');assert.equal(paintWitness(e.clip().shape.fill),'#aabbccdd')
})

test('Changed appearance remains valid for saving and placing a reusable composition',t=>{
 const f=project({gradient:true,gradientStroke:false}),view=compView(f.p,f.scope),clip=view.tracks.flatMap(t=>t.clips).find(c=>c.id===f.id),capture=captureShapeAppearance({project:f.p,version:7,root:'/owned/shape',openComp:f.scope,selection:[f.id]},view,clip)
 for(const [action,value] of [['fillColor','#d95d18'],['strokeColor','#00ff88'],['strokeWidth',6.5],['fillEnabled',false],['fillEnabled',true],['strokeEnabled',false],['strokeEnabled',true]]){
  const changed=applyOps(f.p,shapeAppearanceOps(capture,action,value)).project,before=structuredClone(changed.comps[f.scope]),saved=applyOps(changed,[{op:'library_save',category:'composition',name:action,source:{composition:f.scope}}]).project,item=saved.library.items.find(item=>item.name===action);assert(item);assert.deepEqual(saved.comps[f.scope],before)
  const placed=applyOps(saved,[{op:'library_apply',item:item.id,start:8,track:'V3'}]).project;assert.equal(Object.keys(placed.comps).length,2);assert.deepEqual(changed.comps[f.scope],before)
 }
 const solid=project(),solidView=compView(solid.p,solid.scope),solidCapture=captureShapeAppearance({project:solid.p,version:7,root:'/owned/shape',openComp:solid.scope,selection:[solid.id]},solidView,solidView.tracks.flatMap(t=>t.clips).find(c=>c.id===solid.id)),enabled=applyOps(solid.p,shapeAppearanceOps(solidCapture,'strokeEnabled',true)).project
 assert.doesNotThrow(()=>applyOps(enabled,[{op:'library_save',category:'composition',name:'New stroke',source:{composition:solid.scope}}]))
 const missing=applyOps(solid.p,[{op:'update',comp:solid.scope,id:solid.id,set:{shape:{fill:null}}}]).project,missingView=compView(missing,solid.scope),missingCapture=captureShapeAppearance({project:missing,version:7,root:'/owned/shape',openComp:solid.scope,selection:[solid.id]},missingView,missingView.tracks.flatMap(t=>t.clips).find(c=>c.id===solid.id)),restored=applyOps(missing,shapeAppearanceOps(missingCapture,'fillEnabled',true)).project;assert.doesNotThrow(()=>applyOps(restored,[{op:'library_save',category:'composition',name:'New fill',source:{composition:solid.scope}}]))
})
