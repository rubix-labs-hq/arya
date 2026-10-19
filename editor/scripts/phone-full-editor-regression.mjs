import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

const root = path.resolve(process.argv[2]), out = path.resolve(process.argv[3])
await fs.mkdir(out, {recursive: true})
const {chromium} = await import(process.env.ARYA_PLAYWRIGHT_MODULE || 'playwright')
const {newProject, applyOps} = await import(pathToFileURL(path.join(root, 'core/project.js')))
const initial = newProject('Portrait fixture')
initial.tracks[2].clips.push({id:'c1', kind:'title', start:0, dur:4, title:{text:'Original title',size:96}, note:'Original note'})
let project = structuredClone(initial), version = 1
const history = [], operations = [], requests = [], failures = [], missing = []
const plugins = (await fs.readdir(path.join(root, 'web/ui/plugins'))).filter(f=>f.endsWith('.js')).sort()
const fixture = `await import('/ui/plugins-index.js');const {mountApp}=await import('/ui/app.js');await mountApp(document.querySelector('#app'));const {store,set,setTime}=await import('/ui/store.js');set({selection:['c1'],inspectorTab:'title',chatOpen:false});setTime(2);window.fixture={store,set,setTime};window.ready=true;`
const browser = await chromium.launch({executablePath:process.env.REEL_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true})
const context = await browser.newContext({viewport:{width:760,height:800},hasTouch:true})
context.on('page',p=>{p.on('pageerror',e=>failures.push(e.message));p.on('console',m=>{if(m.type()==='error')console.error('Browser console: '+m.text())});p.on('requestfailed',r=>console.error('Request failed: '+r.url()+' '+r.failure()?.errorText))})
await context.route('**/*', async route=>{
  const request=route.request(), url=new URL(request.url()), pathname=url.pathname
  requests.push({method:request.method(),path:pathname})
  const json=data=>route.fulfill({contentType:'application/json',body:JSON.stringify(data)})
  if(pathname.startsWith('/api/')){
    if(pathname==='/api/project')return json({project,version,root:'/disposable/portrait-fixture'})
    if(pathname==='/api/ops'){
      const body=request.postDataJSON();history.push(structuredClone(project));operations.push(body.ops);project=applyOps(project,body.ops).project;version++;return json({project,version})
    }
    if(pathname==='/api/undo'){project=history.pop();version++;return json({project,version})}
    if(pathname==='/api/files')return json({dir:'',files:[]})
    if(pathname==='/api/events')return route.fulfill({contentType:'text/event-stream',body:'event: hello\ndata: {}\n\n'})
    if(pathname==='/api/ui-state')return json({ok:true})
    return json({})
  }
  if(pathname==='/fixture.js')return route.fulfill({contentType:'text/javascript',body:fixture})
  if(pathname==='/ui/plugins-index.js')return route.fulfill({contentType:'text/javascript',body:plugins.map(f=>`import './plugins/${f}'`).join('\n')})
  const relative=pathname.startsWith('/vendor/')?'node_modules/'+pathname.slice(8):pathname.startsWith('/core/')?pathname.slice(1):'web'+(pathname==='/'?'/index.html':pathname)
  try{
    let body=await fs.readFile(path.join(root,relative))
    if(pathname==='/')body=Buffer.from(body.toString().replace('src="/main.js"','src="/fixture.js"'))
    const ext=path.extname(relative)
    const contentType={'.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.json':'application/json','.woff2':'font/woff2','.png':'image/png'}[ext]||'application/octet-stream'
    return route.fulfill({contentType,body})
  }catch{missing.push(pathname);return route.fulfill({status:404,body:''})}
})
const measurements=[]
try{
  const page=await context.newPage();await page.goto('http://arya-full-editor.test/');await page.waitForFunction(()=>window.ready,null,{timeout:10000})
  await page.waitForTimeout(400)
  await page.getByRole('button',{name:'Ask AI',exact:true}).waitFor({state:'visible'})
  const input=page.locator('textarea.title-text');await input.fill('Portrait draft with actions');await input.evaluate(el=>{el.setSelectionRange(2,9);window.originalInput=el;window.originalViewer=document.querySelector('.viewer');window.originalCanvas=document.querySelector('.viewer-canvas')})
  for(const viewport of [{width:390,height:500},{width:320,height:480}]){
    await page.setViewportSize(viewport);await page.waitForTimeout(250)
    const m=await page.evaluate(()=>{
      const box=selector=>{const el=document.querySelector(selector);if(!el)return null;const r=el.getBoundingClientRect();return {top:r.top,height:r.height,bottom:r.bottom,width:r.width}}
      return {viewport:{width:innerWidth,height:innerHeight},topbar:box('.topbar'),panel:box('.edit-inspector-pane'),body:box('.inspector-body'),input:box('textarea.title-text'),actions:box('.reel-animate-compact'),toggle:box('.phone-preview-toggle'),draft:document.querySelector('textarea.title-text').value,sameInput:window.originalInput===document.querySelector('textarea.title-text'),sameViewer:window.originalViewer===document.querySelector('.viewer'),sameCanvas:window.originalCanvas===document.querySelector('.viewer-canvas'),focus:document.activeElement===window.originalInput,selection:[window.originalInput.selectionStart,window.originalInput.selectionEnd],viewerCount:document.querySelectorAll('.viewer').length,inspectorCount:document.querySelectorAll('.inspector').length}
    })
    assert.equal(m.sameInput,true);assert.equal(m.sameViewer,true);assert.equal(m.sameCanvas,true);assert.equal(m.focus,true);assert.deepEqual(m.selection,[2,9]);assert.equal(m.draft,'Portrait draft with actions');assert.equal(m.viewerCount,1);assert.equal(m.inspectorCount,1)
    assert.ok(m.body.height>=120,'full Inspector body must fit title input: '+JSON.stringify(m))
    assert.ok(m.input.top>=m.body.top&&m.input.bottom<=m.body.bottom,'title input entirely inside visible body: '+JSON.stringify(m))
    assert.ok(m.input.bottom<=viewport.height);assert.ok(m.actions.height>=44);assert.ok(m.toggle.height>=44)
    for(const name of ['Ask AI','Animate selected']){const b=page.getByRole('button',{name,exact:true});const r=await b.boundingBox();assert.ok(r.width>=44&&r.height>=44,name+' touch target')}
    assert.equal(operations.length,0,'resize preserves uncommitted draft');measurements.push(m)
  }
  await page.screenshot({path:path.join(out,'full-inspector-focus-320x480.png')})
  await page.setViewportSize({width:390,height:500});await page.waitForTimeout(150)
  await page.getByRole('button',{name:'Show preview',exact:true}).click()
  assert.equal(await page.locator('.viewer').isVisible(),true)
  assert.equal(await page.locator('.edit-inspector-pane').isVisible(),false)
  const preview=await page.evaluate(()=>{const r=document.querySelector('.viewer-stage').getBoundingClientRect();return {height:r.height,top:r.top,bottom:r.bottom}});assert.ok(preview.height>=80,'preview keeps useful image area: '+JSON.stringify(preview))
  const transport=[]
  for(const name of ['Mark in','Mark out','Clear range','Loop playback']){const b=page.getByRole('button',{name,exact:true});assert.equal(await b.isVisible(),true);const r=await b.boundingBox();assert.ok(r.width>=44&&r.height>=44);transport.push({name,width:r.width,height:r.height})}
  await page.screenshot({path:path.join(out,'full-inspector-preview-390x500.png')})
  await page.getByRole('button',{name:'Focus Inspector',exact:true}).click()
  assert.equal(await page.locator('.viewer').isVisible(),false)
  assert.equal(await input.inputValue(),'Portrait draft with actions')
  await page.waitForFunction(()=>window.fixture.store.version===2)
  assert.equal(operations.length,1,'explicit button blur commits once')
  assert.equal(project.tracks[2].clips[0].title.text,'Portrait draft with actions')
  await page.setViewportSize({width:760,height:800});await page.waitForTimeout(150)
  assert.equal(await page.locator('.viewer').isVisible(),true)
  assert.equal(await input.evaluate(el=>el===window.originalInput),true)
  await page.getByRole('button',{name:'Undo',exact:true}).click();await page.waitForFunction(()=>window.fixture.store.version===3)
  assert.equal(project.tracks[2].clips[0].title.text,'Original title')
  await page.setViewportSize({width:390,height:500});await page.waitForTimeout(150)
  await page.getByRole('button',{name:'Ask AI',exact:true}).click()
  const motion=page.getByRole('textbox',{name:'Motion request'});await motion.fill('Restrained motion');assert.equal(await motion.inputValue(),'Restrained motion')
  const aiForm=[]
  for(const control of [motion,page.getByRole('button',{name:'Cancel',exact:true}),page.getByRole('button',{name:'Attach request',exact:true})]){await control.scrollIntoViewIfNeeded();const r=await control.boundingBox();assert.ok(r.y>=0&&r.y+r.height<=500,'expanded AI form control inside viewport: '+JSON.stringify(r));aiForm.push(r)}
  await page.getByRole('button',{name:'Cancel',exact:true}).click()
  assert.equal(await input.isVisible(),true)
  await input.fill('Reverse portrait draft');await input.evaluate(el=>el.setSelectionRange(3,10))
  for(const viewport of [{width:760,height:800},{width:390,height:500}]){await page.setViewportSize(viewport);await page.waitForTimeout(150);assert.deepEqual(await input.evaluate(el=>[el===window.originalInput,document.activeElement===el,el.value,el.selectionStart,el.selectionEnd]),[true,true,'Reverse portrait draft',3,10])}
  assert.equal(operations.length,1);await input.evaluate(el=>el.blur());await page.waitForFunction(()=>window.fixture.store.version===4);assert.equal(operations.length,2);assert.equal(project.tracks[2].clips[0].title.text,'Reverse portrait draft')
  await page.getByRole('button',{name:'Undo',exact:true}).click();await page.waitForFunction(()=>window.fixture.store.version===5);assert.equal(project.tracks[2].clips[0].title.text,'Original title')
  await page.getByRole('button',{name:'Show preview',exact:true}).click()
  for(const [name,time] of [['Mark in',2],['Mark out',3],['Clear range',3],['Loop playback',3]]){await page.evaluate(t=>window.fixture.setTime(t),time);await page.getByRole('button',{name,exact:true}).click();await page.waitForTimeout(100);const state=await page.evaluate(()=>({range:window.fixture.store.project.range,loop:window.fixture.store.loop}));assert.ok(name==='Mark in'?state.range?.in===2:name==='Mark out'?state.range?.out===3:name==='Clear range'?!state.range:state.loop,name+' actual transport action')}
  // Preview preference must not hide a draft on a height-only return to short portrait.
  await page.setViewportSize({width:390,height:800});await page.waitForTimeout(150)
  assert.equal(await page.locator('.edit-inspector-pane').isVisible(),true)
  await input.fill('Height-only return draft');await input.evaluate(el=>el.setSelectionRange(4,11))
  const heightOpsBefore=operations.length
  await page.setViewportSize({width:390,height:500});await page.waitForTimeout(150)
  const heightOnly=await input.evaluate(el=>{const r=el.getBoundingClientRect(),body=document.querySelector('.inspector-body').getBoundingClientRect();return {sameInput:el===window.originalInput,focus:document.activeElement===el,draft:el.value,selection:[el.selectionStart,el.selectionEnd],height:r.height,top:r.top,bottom:r.bottom,bodyHeight:body.height,viewerVisible:document.querySelector('.viewer').getBoundingClientRect().height>0}})
  await fs.writeFile(path.join(out,'height-only-observation.json'),JSON.stringify({...heightOnly,operationsBefore:heightOpsBefore,operationsAfter:operations.length},null,2)+'\n')
  assert.equal(heightOnly.sameInput,true);assert.equal(heightOnly.focus,true);assert.equal(heightOnly.draft,'Height-only return draft');assert.deepEqual(heightOnly.selection,[4,11]);assert.ok(heightOnly.height>0&&heightOnly.bottom<=500,'height-only return keeps active Inspector visible: '+JSON.stringify(heightOnly));assert.equal(heightOnly.viewerVisible,false);assert.ok(heightOnly.bodyHeight>=120);assert.equal(operations.length,heightOpsBefore)
  await input.evaluate(el=>el.blur());await page.waitForFunction(()=>window.fixture.store.project.tracks[2].clips[0].title.text==='Height-only return draft');assert.equal(operations.length,heightOpsBefore+1)
  await page.getByRole('button',{name:'Undo',exact:true}).click();await page.waitForFunction(()=>window.fixture.store.project.tracks[2].clips[0].title.text==='Original title')
  assert.deepEqual(failures,[]);assert.deepEqual(missing,[])
  const result={status:'PASS',boundary:'Complete unmodified editor UI, all real feature plugins, Viewer/canvas/transport/Inspector/store; intercepted disposable API using actual applyOps; no live server or project',loadedPlugins:plugins,measurements,preview,transport,heightOnly,draftResize:'no edit; same mounted input/viewer/canvas and selection',explicitBlur:'one edit',undo:'one undo restores original title',askAIForm:{status:'reachable and cancellable',controlBounds:aiForm},reverseDraft:'same input/selection, one edit and one Undo',transportActions:'4/4 actual action PASS',pageErrors:failures,missingResources:missing,requests}
  await fs.writeFile(path.join(out,'full-editor-results.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2))
}catch(error){console.error(JSON.stringify({pageErrors:failures,missingResources:missing,requests},null,2));throw error}finally{await browser.close()}
