import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const root = path.resolve(process.argv[2]), out = path.resolve(process.argv[3])
const { chromium } = await import(process.env.ARYA_PLAYWRIGHT_MODULE || 'playwright')
const read = relative => fs.readFile(path.join(root, relative), 'utf8')
const app = await read('web/ui/app.js'), viewer = await read('web/ui/viewer.js')
const prelude = `import {h} from 'preact';import {useState,useEffect,useRef,useReducer} from 'preact/hooks';import htm from 'htm';const html=htm.bind(h);`
const modules = {
 '/web/ui/app.js': `${prelude}import {PhoneEditPage,PhonePanelControls,PhoneGate,usePhoneLayout} from './phone.js';import {useStore,store,set,api} from './store.js';import {Icon} from './icons.js';import {ScrollTabs} from './scroll-tabs.js';import {registry} from './registry.js';import {duration,timecode} from '/core/project.js';import {Viewer} from './viewer.js';import {Inspector} from './inspector.js';import {Browser} from './browser.js';import {Timeline} from './timeline.js';import {Toolbar} from './timeline-toolbar.js';import {Divider,editGridColumns,editPaneSizes,useLayout,useWorkspaceWidth,LayoutMenu} from './layout.js';${app.slice(app.indexOf('const PAGES ='),app.indexOf('function EditPage()'))}${app.slice(app.indexOf('function EditPage()'),app.indexOf('function Welcome()'))}\nexport {EditPage,TopBar};`.replace('PhoneEditPage,PhonePanelControls,PhoneGate', app.includes('PhonePanelControls') ? 'PhonePanelControls,PhoneGate' : 'PhoneEditPage,PhoneGate'),
 '/web/ui/browser.js': `${prelude}export const Browser=()=>html\`<div class="panel">Media fixture</div>\`;`,
 '/web/ui/timeline.js': `${prelude}export const Timeline=()=>html\`<div>Timeline fixture</div>\`;`,
 '/web/ui/timeline-toolbar.js': `export const Toolbar=()=>null;`,
 '/web/ui/registry.js': `export const registry={pages:[],inspectors:[],inspectorActions:[]};`,
 '/web/ui/menu.js': `export const openMenu=()=>{};`,
 '/web/ui/shape-appearance.js': `export const ShapeAppearance=()=>null;`,
 '/web/ui/engine-host.js': `export const player={seek:v=>window.fixture.time.t=v,step:()=>{},toggle:()=>{}};`,
 '/web/ui/viewer.js': `${prelude}import {clipEnd,duration,timecode} from '/core/project.js';import {edit,set,store,time,useTime} from './store.js';import {player} from './engine-host.js';import {Icon} from './icons.js';${viewer.slice(viewer.indexOf('export function Transport('),viewer.indexOf('\nfunction SourceViewer('))}\nexport function Viewer({compact}){useEffect(()=>{window.viewerMounts++;return()=>window.viewerUnmounts++},[]);return html\`<div class=\${'viewer '+(compact?'compact':'')}><div class="viewer-stage">Picture fixture</div><\${Transport} p=\${store.project}/></div>\`;}`,
 '/web/ui/store.js': `${prelude}import {newProject,applyOps,compView} from '/core/project.js';const listeners=new Set();export const store={project:null,selection:[],inspectorTab:'title',chatOpen:false,openComp:null,playing:false,rate:1,loop:false,jobs:[],refs:[],claude:{state:'idle'},connected:true,page:'edit'};export const time={t:2};const history=[];const notify=()=>{for(const f of listeners)f()};export const set=p=>{Object.assign(store,p);notify()};export function useStore(){const[,update]=useReducer(x=>x+1,0);useEffect(()=>{listeners.add(update);return()=>listeners.delete(update)},[]);return store}export const useTime=()=>time.t;export const viewProject=()=>compView(store.project,store.openComp);export function edit(ops){window.edits.push(structuredClone(ops));history.push(structuredClone(store.project));const list=(Array.isArray(ops)?ops:[ops]).map(o=>store.openComp?{...o,comp:store.openComp}:o);set({project:applyOps(store.project,list).project})}export const api=async()=>{throw Error('Unexpected fixture API call')};export const addRef=()=>{};export const toast=()=>{};window.fixture={store,time,refresh:notify,boot(mode){window.edits=[];history.length=0;const p=newProject('Original project');p.tracks[0].clips.push({id:'title-1',kind:'title',start:0,dur:4,title:{text:'Original title',size:96},note:'Original note'});p.comps={k1:{id:'k1',name:'Original composition',width:640,height:360,fps:30,tracks:[{id:'V1',kind:'video',clips:[]}]}};set({project:p,selection:mode==='project'||mode==='composition'?[]:['title-1'],openComp:mode==='composition'?'k1':null,inspectorTab:mode==='note'?'info':'title'});},undo(){set({project:history.pop()})},subscriberCount:()=>listeners.size};`,
 '/fixture.js': `import {h,render} from 'preact';import {EditPage,TopBar} from '/web/ui/app.js';import '/web/ui/store.js';window.viewerMounts=0;window.viewerUnmounts=0;window.fixture.boot('title');render(h('div',{class:'app'},h(TopBar),h('div',{class:'main'},h(EditPage))),document.querySelector('#app'));window.ready=true;`,
}
const browser = await chromium.launch({executablePath:process.env.REEL_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true})
const context = await browser.newContext({viewport:{width:760,height:800},hasTouch:true})
const failures=[];context.on('page',p=>p.on('pageerror',e=>failures.push(e.message)))
await context.route('**/*',async route=>{
 const url=new URL(route.request().url()), file=url.pathname
 try {
  if(file==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><style>html,body,#app{margin:0;height:100%;}</style><link rel="stylesheet" href="/web/styles.css"><link rel="stylesheet" href="/web/ui/icons.css"><link rel="stylesheet" href="/web/ui/phone.css"><script type="importmap">{"imports":{"preact":"/preact.js","preact/hooks":"/hooks.js","htm":"/htm.js"}}</script></head><body><div id="app"></div><script type="module" src="/fixture.js"></script></body></html>`})
  if(modules[file])return route.fulfill({contentType:'text/javascript',body:modules[file]})
  const deps={'/preact.js':'node_modules/preact/dist/preact.module.js','/hooks.js':'node_modules/preact/hooks/dist/hooks.module.js','/htm.js':'node_modules/htm/dist/htm.module.js'}
  const relative=deps[file] || (file.startsWith('/assets/')||file.startsWith('/fonts/')?'web'+file:file.slice(1))
  const resolved=path.resolve(root,relative);assert.ok(resolved.startsWith(root+path.sep))
  return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:await fs.readFile(resolved)})
 } catch(error){return route.fulfill({status:404,body:error.message})}
})
const records=[]
try {
 for(const start of [760,700])for(const mode of ['title','size','note','project','composition']){
  const page=await context.newPage();await page.setViewportSize({width:start,height:800});await page.goto('http://arya-layout.test/');await page.waitForFunction(()=>window.ready)
  await page.evaluate(mode=>window.fixture.boot(mode),mode)
  if(start===700)await page.getByRole('tab',{name:'Inspector',exact:true}).click()
  const input=mode==='title'?page.locator('textarea.title-text'):mode==='note'?page.locator('textarea.note'):mode==='size'?page.locator('.field').filter({has:page.locator('label',{hasText:/^Size$/})}).locator('input'):page.locator('.field').filter({has:page.locator('label',{hasText:/^Name$/})}).locator('input')
  const before=await page.evaluate(()=>structuredClone(window.fixture.store.project));const draft=mode==='size'?'123':`Pending ${mode} draft`
  await input.fill(draft);await input.evaluate(el=>{window.savedInput=el;el.setSelectionRange(2,5);window.savedSelection=[el.selectionStart,el.selectionEnd]})
  for(const width of [start===760?700:760,start]){
   await page.setViewportSize({width,height:800});await page.waitForFunction(width=>Boolean(document.querySelector('.phone-edit')) === (width<=720),width)
   await page.waitForTimeout(50)
   assert.equal(await page.evaluate(()=>window.savedInput.isConnected),true,'Inspector input stays connected')
   assert.equal(await input.inputValue(),draft,mode+' draft survives resize')
   assert.equal(await input.evaluate(el=>el===window.savedInput),true,'same actual Inspector input node')
   assert.equal(await page.evaluate(()=>window.edits.length),0,'resize does not commit')
   assert.deepEqual(await input.evaluate(el=>[el.selectionStart,el.selectionEnd]),await page.evaluate(()=>window.savedSelection),'text selection survives')
   assert.deepEqual(await page.evaluate(()=>window.fixture.store.selection),mode==='project'||mode==='composition'?[]:['title-1'])
  }
  await input.evaluate(el=>el.blur());await page.waitForFunction(()=>window.edits.length===1)
  const after=await page.evaluate(()=>window.fixture.store.project)
  assert.equal(mode==='project'?after.name:mode==='composition'?after.comps.k1.name:mode==='note'?after.tracks[0].clips[0].note:mode==='size'?after.tracks[0].clips[0].title.size:after.tracks[0].clips[0].title.text,mode==='size'?123:draft)
  await page.evaluate(()=>window.fixture.undo());assert.deepEqual(await page.evaluate(()=>window.fixture.store.project),before,'one Undo restores project')
  assert.deepEqual(await page.evaluate(()=>[window.viewerMounts,window.viewerUnmounts,document.querySelectorAll('.viewer').length,document.querySelectorAll('.inspector').length]),[1,0,1,1])
  records.push({start,mode,draft:'PASS',oneEditAndUndo:'PASS',sameInputAndTextSelection:'PASS'});await page.close()
 }
 for(const layout of [{mediaSide:'left'},{mediaSide:'right'},{mediaSide:'left',showMedia:false},{mediaSide:'right',showInspector:false}]){
  const page=await context.newPage();await page.addInitScript(layout=>localStorage.setItem('reel.workspace.v1',JSON.stringify(layout)),layout);await page.setViewportSize({width:900,height:800});await page.goto('http://arya-layout.test/');await page.waitForFunction(()=>window.ready);await page.waitForTimeout(50)
  const bounds=await page.evaluate(()=>Object.fromEntries(['media','inspector','viewer'].map(name=>{const el=document.querySelector(name==='viewer'?'.edit-viewer':'.edit-'+name+'-pane');const r=el.getBoundingClientRect();return[name,{x:r.x,width:r.width,hidden:el.hidden}]})))
  assert.equal(bounds.media.hidden,layout.showMedia===false);assert.equal(bounds.inspector.hidden,layout.showInspector===false)
  for(const name of ['media','inspector'])if(!bounds[name].hidden){const left=layout.mediaSide==='left'?name==='media':name==='inspector';assert.ok(left?bounds[name].x+bounds[name].width<=bounds.viewer.x:bounds[name].x>=bounds.viewer.x+bounds.viewer.width,'desktop preference keeps panels on the requested side')}
  await page.close()
 }
 const short=await context.newPage();await short.setViewportSize({width:390,height:500});await short.goto('http://arya-layout.test/');await short.waitForFunction(()=>window.ready);await short.waitForTimeout(50)
 const dimensions=await short.evaluate(()=>{const h=s=>document.querySelector(s)?.getBoundingClientRect().height??0;return {topbar:h('.topbar'),viewer:h('.edit-viewer'),tabs:h('.phone-switch'),readout:h('.phone-readout'),timelinePanel:h('#edit-panel-timeline')}})
 assert.equal(dimensions.topbar,88);assert.ok(dimensions.timelinePanel>=80,'short portrait timeline keeps usable height: '+JSON.stringify(dimensions))
 await short.getByRole('tab',{name:'Inspector',exact:true}).click();const shortInput=short.locator('textarea.title-text');await shortInput.fill('Short portrait draft')
 const inspectorDimensions=await short.evaluate(()=>({panel:document.querySelector('.edit-inspector-pane').getBoundingClientRect().height,body:document.querySelector('.inspector-body').getBoundingClientRect().height,input:document.querySelector('textarea.title-text').getBoundingClientRect().height}))
 assert.ok(inspectorDimensions.panel>=120);assert.ok(inspectorDimensions.body>=60,'short portrait Inspector body: '+JSON.stringify(inspectorDimensions));assert.equal(await shortInput.inputValue(),'Short portrait draft');await shortInput.evaluate(el=>el.blur());await short.waitForFunction(()=>window.edits.length===1);assert.equal(await short.evaluate(()=>window.fixture.store.project.tracks[0].clips[0].title.text),'Short portrait draft')
 await short.screenshot({path:path.join(out,'short-portrait-inspector-390x500.png')});await short.close()
 const page=await context.newPage();await page.setViewportSize({width:390,height:844});await page.goto('http://arya-layout.test/');await page.waitForFunction(()=>window.ready)
 for(const [name,verify] of [['Mark in',()=>window.fixture.store.project.range?.in===2],['Mark out',()=>window.fixture.store.project.range?.out===3],['Clear range',()=>!window.fixture.store.project.range],['Loop playback',()=>window.fixture.store.loop]]){
  if(name==='Mark out'){await page.evaluate(()=>{window.fixture.time.t=3;window.fixture.refresh()});await page.waitForTimeout(50)}
  const button=page.getByRole('button',{name,exact:true});assert.equal(await button.isVisible(),true,name+' is reachable');const box=await button.boundingBox();assert.ok(box.width>=44&&box.height>=44,name+' touch target');await button.click();assert.equal(await page.evaluate(verify),true,name+' actual action')
 }
 await page.screenshot({path:path.join(out,'phone-controls-390.png')});await page.setViewportSize({width:844,height:390});await page.waitForTimeout(100)
 assert.equal(await page.getByRole('button',{name:'Loop playback',exact:true}).isVisible(),true)
 await page.screenshot({path:path.join(out,'phone-controls-844.png')});await page.close()
 assert.deepEqual(failures,[]);console.log(JSON.stringify({records,touchControls:'4/4 PASS',singleViewerAndInspector:'PASS',desktopSideAndVisibilityPreferences:'4/4 PASS',shortPortrait:{dimensions,inspectorDimensions,edit:'PASS'},pageErrors:failures},null,2))
} finally {await browser.close()}
