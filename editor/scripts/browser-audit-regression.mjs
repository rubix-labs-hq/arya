import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

const root = path.resolve(process.argv[2]), out = path.resolve(process.argv[3])
await fs.mkdir(out, {recursive: true})
const {chromium} = await import(process.env.ARYA_PLAYWRIGHT_MODULE || 'playwright')
const {newProject, applyOps, snapToFrame} = await import(pathToFileURL(path.join(root, 'core/project.js')))
const initial = newProject('Timeline audit with a longer project name')
initial.tracks[2].clips.push({id:'c1', kind:'title', start:0, dur:4, title:{text:'Original title',size:96}, note:'Original note'})
let project = structuredClone(initial), version = 1
const history = [], operations = [], requests = [], failures = [], missing = []
const plugins = (await fs.readdir(path.join(root, 'web/ui/plugins'))).filter(f=>f.endsWith('.js')).sort()
const fixture = `await import('/ui/plugins-index.js');const {mountApp}=await import('/ui/app.js');await mountApp(document.querySelector('#app'));const {store,set,setTime,time}=await import('/ui/store.js');set({selection:['c1'],inspectorTab:'title',chatOpen:false});setTime(2);const {rowsOf}=await import('/ui/timeline.js');window.fixture={store,set,setTime,time,rowsOf};window.ready=true;`
const browser = await chromium.launch({executablePath:process.env.REEL_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true})
const context = await browser.newContext({viewport:{width:760,height:800},hasTouch:false})
context.on('page',p=>{p.on('pageerror',e=>failures.push(e.message));p.on('console',m=>{if(m.type()==='error')console.error('Browser console: '+m.text())});p.on('requestfailed',r=>console.error('Request failed: '+r.url()+' '+r.failure()?.errorText))})
const contextRoute=async route=>{
  const request=route.request(), url=new URL(request.url()), pathname=url.pathname
  requests.push({method:request.method(),path:pathname})
  const json=data=>route.fulfill({contentType:'application/json',body:JSON.stringify(data)})
  if(pathname.startsWith('/api/')){
    if(pathname==='/api/project')return json({project,version,root:'/disposable/portrait-fixture'})
    if(pathname==='/api/ops'){
      const body=request.postDataJSON();history.push(structuredClone(project));operations.push(body.ops);project=applyOps(project,body.ops).project;version++;return json({project,version})
    }
    if(pathname==='/api/undo'){project=history.pop();version++;return json({project,version})}
    if(pathname==='/api/luts')return json({luts:[]})
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
}
await context.route('**/*',contextRoute)
context.setDefaultTimeout(5000)
const results=[]
const check=async(name,run)=>{try{results.push({name,pass:true,evidence:await run()})}catch(error){results.push({name,pass:false,error:error.message,latestOperations:operations.slice(-3),projectRange:project.range})}}
const ready=async page=>{await page.goto('http://arya-full-editor.test/');await page.waitForFunction(()=>window.ready,null,{timeout:10000});await page.waitForTimeout(250)}
try{
  const fine=await context.newPage();await fine.setViewportSize({width:1512,height:945});await ready(fine)
  await fine.evaluate(()=>document.querySelector('.edit-viewer').style.width='550px');await fine.waitForTimeout(100)
  await check('B5 timeline transport fits 550px with working precise controls',async()=>{
    const m=await fine.evaluate(()=>{const r=el=>{const b=el.getBoundingClientRect();return {left:b.left,top:b.top,right:b.right,bottom:b.bottom,width:b.width,height:b.height}};const el=document.querySelector('.transport');return {transport:r(el),groups:[...el.children].map(r),buttons:[...el.querySelectorAll('button')].map(b=>({name:b.getAttribute('aria-label'),...r(b)})),duration:el.querySelector('.tc-dur').textContent}})
    assert.equal(m.buttons.length,11);assert.ok(m.transport.height<45,JSON.stringify(m));assert.ok(Math.max(...m.groups.map(b=>b.top))<Math.min(...m.groups.map(b=>b.bottom)),'All transport groups occupy the same row')
    for(const b of m.buttons)assert.ok(b.left>=m.transport.left&&b.right<=m.transport.right&&b.bottom<=m.transport.bottom,b.name+' stays inside the transport')
    assert.equal(m.duration,'/ 00:00:04:00')
    console.log('B5 action: Go to start');await fine.getByRole('button',{name:'Go to start',exact:true}).click();await fine.waitForFunction(()=>window.fixture.time.t===0)
    console.log('B5 action: Forward one frame');await fine.getByRole('button',{name:'Forward one frame',exact:true}).click();await fine.waitForFunction(()=>Math.abs(window.fixture.time.t-1/30)<1e-6)
    console.log('B5 action: Go to end');await fine.getByRole('button',{name:'Go to end',exact:true}).click();await fine.waitForFunction(()=>window.fixture.time.t===4)
    console.log('B5 action: Previous edit');await fine.getByRole('button',{name:'Previous edit',exact:true}).click();await fine.waitForFunction(()=>window.fixture.time.t===0)
    console.log('B5 action: precise timecode');await fine.locator('.transport .tc').click();await fine.locator('.tc-input').fill('00:00:02:13');await fine.locator('.tc-input').press('Enter');await fine.waitForFunction(()=>Math.abs(window.fixture.time.t-(2+13/30))<1e-6)
    await fine.waitForFunction(()=>document.querySelector('.transport .tc')?.textContent==='00:00:02:13');console.log('B5 action: Mark in');await fine.getByRole('button',{name:'Mark in',exact:true}).click();await fine.waitForFunction(expected=>window.fixture.store.project.range?.in===expected,snapToFrame(2+13/30,initial.fps))
    await fine.evaluate(()=>window.fixture.setTime(3));await fine.waitForFunction(()=>document.querySelector('.transport .tc')?.textContent==='00:00:03:00');console.log('B5 action: Mark out');await fine.getByRole('button',{name:'Mark out',exact:true}).click();await fine.waitForFunction(()=>window.fixture.store.project.range?.out===3)
    console.log('B5 action: Clear range');await fine.getByRole('button',{name:'Clear range',exact:true}).click();await fine.waitForFunction(()=>!window.fixture.store.project.range)
    const loop=fine.getByRole('button',{name:'Loop playback',exact:true});await loop.click();assert.equal(await loop.getAttribute('aria-pressed'),'true');await loop.click();assert.equal(await loop.getAttribute('aria-pressed'),'false')
    return {...m,preciseTimecodeSeek:true,rangeAndLoop:true}
  })
  await check('B6 long project name retains complete format metadata',async()=>{
    const m=await fine.evaluate(()=>{const el=document.querySelector('.topbar .proj'),format=el.querySelector('.muted'),name=el.querySelector('.proj-name'),r=el.getBoundingClientRect(),f=format.getBoundingClientRect();return {project:{left:r.left,right:r.right,width:r.width,clientWidth:el.clientWidth,scrollWidth:el.scrollWidth},format:{text:format.textContent,left:f.left,right:f.right},name:name?{text:name.textContent,title:name.title,clientWidth:name.clientWidth,scrollWidth:name.scrollWidth}:null,duration:document.querySelector('.transport .tc-dur').textContent}})
    assert.equal(m.format.text,'1920×1080 · 30fps');assert.ok(m.format.left>=m.project.left&&m.format.right<=m.project.right);assert.ok(m.project.scrollWidth<=m.project.clientWidth);assert.equal(m.name.title,initial.name);assert.equal(m.name.text,initial.name);assert.ok(m.name.scrollWidth>m.name.clientWidth,'Long name truncates instead of metadata');assert.equal(m.duration,'/ 00:00:04:00');return m
  })
  await fine.screenshot({path:path.join(out,'desktop-transport-header.png')})
  await fine.evaluate(()=>window.fixture.set({page:'color',chatOpen:false}));await fine.waitForTimeout(250)
  await check('B7 visible disabled Color explanation follows real node selection',async()=>{
    for(const name of ['Qualifier','Window']){const b=fine.locator('.palette-tabs').getByRole('button',{name,exact:true});assert.equal(await b.isDisabled(),true);assert.equal(await b.getAttribute('title'),'Select a corrector node for this palette')}
    const hint=fine.locator('.palette-hint');assert.equal(await hint.isVisible(),true);assert.equal(await hint.textContent(),'Select a corrector node to use Qualifier and Window.');assert.equal(await hint.getAttribute('role'),'note')
    await fine.getByRole('button',{name:'+ Serial',exact:true}).click();await fine.waitForFunction(()=>window.fixture.store.project.tracks[2].clips[0].nodes?.list?.some(n=>n.type==='corrector'))
    for(const name of ['Qualifier','Window'])assert.equal(await fine.locator('.palette-tabs').getByRole('button',{name,exact:true}).isEnabled(),true)
    assert.equal(await hint.count(),0)
    await fine.locator('.nnode.t-primary').click();await hint.waitFor({state:'visible'})
    for(const name of ['Qualifier','Window'])assert.equal(await fine.locator('.palette-tabs').getByRole('button',{name,exact:true}).isDisabled(),true)
    await fine.screenshot({path:path.join(out,'color-disabled-explanation.png')});return {hoverReasonRetained:true,inlineReason:true,serialCorrectorEnables:true,primarySelectionRestores:true}
  })
  await fine.close()
  const touchContext=await browser.newContext({viewport:{width:390,height:844},hasTouch:true});touchContext.on('page',p=>p.on('pageerror',e=>failures.push(e.message)));await touchContext.route('**/*',contextRoute)
  const touch=await touchContext.newPage();await ready(touch)
  await check('Phone track controls have aligned 44px targets and real toggle/Undo behavior',async()=>{
    await touch.evaluate(()=>window.fixture.set({trackHeight:{V3:30,A1:30},selection:[]}));await touch.waitForTimeout(150)
    const m=await touch.evaluate(()=>({coarse:matchMedia('(pointer: coarse)').matches,rows:window.fixture.rowsOf(window.fixture.store.project).rows.map(r=>({id:r.track.id,y:r.y,height:r.h})),headers:[...document.querySelectorAll('.th')].map(el=>{const r=el.getBoundingClientRect(),n=el.querySelector('.th-name').getBoundingClientRect();return {id:el.querySelector('.th-name b').textContent,height:r.height,nameBottom:n.bottom,buttons:[...el.querySelectorAll('button')].map(b=>{const t=b.getBoundingClientRect();return {label:b.getAttribute('aria-label'),pressed:b.getAttribute('aria-pressed'),width:t.width,height:t.height,top:t.top,bottom:t.bottom,rowBottom:r.bottom}})}})}))
    assert.equal(m.coarse,true)
    for(const row of m.rows){assert.ok(row.height>=70);const header=m.headers.find(h=>h.id===row.id);assert.equal(header.height,row.height+2);for(const b of header.buttons){assert.ok(b.width>=44&&b.height>=44,JSON.stringify(b));assert.ok(b.top>=header.nameBottom&&b.bottom<=b.rowBottom,JSON.stringify(b));assert.ok(b.label);assert.equal(b.pressed,'false')}}
    for(const [id,label,key] of [['V3','Hide','hidden'],['V3','Mute','muted'],['V3','Lock','locked'],['A1','Solo','solo'],['A1','Mute','muted'],['A1','Lock','locked']]){
      const b=touch.getByRole('button',{name:label+' '+id,exact:true});await b.scrollIntoViewIfNeeded();const before=operations.length;await b.click();await touch.waitForFunction(({id,key})=>window.fixture.store.project.tracks.find(t=>t.id===id)[key]===true,{id,key});assert.equal(await b.getAttribute('aria-pressed'),'true');assert.equal(operations.length,before+1)
      assert.deepEqual(operations.at(-1),[{op:'update_track',id,set:{[key]:true}}]);await touch.getByRole('button',{name:'Undo',exact:true}).click();await touch.waitForFunction(({id,key})=>!window.fixture.store.project.tracks.find(t=>t.id===id)[key],{id,key});assert.equal(await b.getAttribute('aria-pressed'),'false')
    }
    await touch.locator('.th-scroll').evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event('scroll'))});await touch.waitForTimeout(100)
    const row=m.rows.find(r=>r.id==='V3');await touch.locator('.tl-canvas canvas').click({position:{x:24,y:row.y+row.height/2}});await touch.waitForFunction(()=>window.fixture.store.selection.includes('c1'))
    assert.deepEqual(await touch.evaluate(()=>window.fixture.store.trackHeight),{V3:30,A1:30});assert.equal(await touch.locator('.topbar .proj').isVisible(),false)
    await touch.screenshot({path:path.join(out,'phone-track-touch-controls.png')});return {...m,toggles:6,undoRestores:6,canvasSelection:'c1',finePreferencesRetained:true,phoneHeaderMetadataHidden:true}
  })
  await touchContext.close();assert.deepEqual(failures,[]);assert.deepEqual(missing,[])
  await fs.writeFile(path.join(out,'result.json'),JSON.stringify({sourceRoot:root,plugins:plugins.length,checks:results,pageErrors:failures,missingResources:missing,operationCount:operations.length,requests},null,2)+'\n')
  console.log(JSON.stringify(results.map(({name,pass,error})=>({name,pass,error})),null,2));assert.ok(results.every(r=>r.pass),'Browser audit regression failed')
}finally{await browser.close()}
