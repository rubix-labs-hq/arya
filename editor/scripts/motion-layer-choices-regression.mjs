import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(process.argv[2]), out = path.resolve(process.argv[3]), dependencies = path.resolve(process.argv[4] || root)
const baseline = process.argv[5] ? path.resolve(process.argv[5]) : null
const { chromium } = await import(process.env.ARYA_PLAYWRIGHT_MODULE || 'playwright')
await fs.mkdir(out, { recursive: true })
const source = await fs.readFile(path.join(root, 'web/ui/motion/layers.js'), 'utf8')
const body = source.slice(source.indexOf('function LayerRow('), source.indexOf('\nfunction GroupRow('))
assert.ok(body.startsWith('function LayerRow('))
const constants = source.split('\n').filter(line => /^(export const ROW|const KIND_ICON|const MATTE_LABEL|const layerName)\b/.test(line)).join('\n').replace('export const ROW', 'const ROW')
const modules = {
  '/web/ui/motion/layer-fixture.js': `import {h} from 'preact';import {useState} from 'preact/hooks';import htm from 'htm';import {BLEND_MODES,MATTE_MODES,clipEnd,round,snapToFrame} from '/core/project.js';import {edit,set,store,time,viewProject} from '../store.js';import {ms,mset} from './state.js';import {inView,soloOps} from './ops.js';const html=htm.bind(h);${constants}\n${body}\nexport {LayerRow};`,
  '/web/ui/store.js': `
    import {useReducer,useEffect} from 'preact/hooks';
    import {applyOps,compView,newProject} from '/core/project.js';
    const listeners=new Set(), history=[];
    export const store={project:null,selection:['c1'],page:'motion',tool:'select',motion:null,openComp:null};
    export const time={t:1};
    export const set=value=>{Object.assign(store,value);for(const listener of listeners)listener()};
    export const viewProject=()=>compView(store.project,store.openComp);
    export const toast=()=>{window.toastCalls++};
    export const useStore=()=>{const[,update]=useReducer(x=>x+1,0);useEffect(()=>{listeners.add(update);return()=>listeners.delete(update)},[]);return store};
    export function edit(op){
      const scoped=store.openComp?{...op,comp:store.openComp}:op;
      try {const next=applyOps(store.project,[scoped]).project;history.push(structuredClone(store.project));window.edits.push(structuredClone(scoped));set({project:next})}
      catch(error){window.refusals.push(error.message);set({})}
    }
    window.fixture={store,time,viewProject,
      boot(nested=false){
        window.edits=[];window.refusals=[];window.toastCalls=0;history.length=0;
        const p=newProject('Motion choice fixture');
        const names=['Artwork','Text title','Accent shape','Lower title','Null controller with a complete long source name','Background'];
        const tracks=names.map((label,i)=>({id:'V'+(i+1),kind:'video',name:'Layer '+(i+1),clips:[{id:'c'+(i+1),kind:i===4?'null':i%2?'title':'shape',label,start:i/2,dur:4,title:{text:label},shape:{type:'rect',width:200,height:100},x:100+i*10}]}));
        tracks[0].clips[0].blend='multiply';tracks[0].clips[0].matte={mode:'alphaInverted'};
        tracks[0].clips[0].parent='c5';tracks[0].clips[0].parentRef={x:140};
        if(nested)p.comps={nested:{id:'nested',name:'Portrait composition',width:1080,height:1920,fps:30,tracks}};else p.tracks=tracks;
        set({project:p,selection:['c1'],openComp:nested?'nested':null,motion:null,tool:'select'});
      },
      undo(){set({project:history.pop()})},
      lock(){viewProject().tracks[0].locked=true;set({})},
      cycle(){viewProject().tracks[4].clips[0].parent='c1';set({})},
    };
  `,
  '/fixture.js': `
    import {h,render} from 'preact';import htm from 'htm';
    import {LayerRow} from '/web/ui/motion/layer-fixture.js';
    import {store,useStore,viewProject} from '/web/ui/store.js';
    import {installMotionKeys} from '/web/ui/motion/shortcuts.js';
    const html=htm.bind(h);window.fixture.boot();installMotionKeys();
    function Layers(){useStore();const view=viewProject();return html\`<div class="mt"><div class="mt-head"><div class="mt-cols" style="width:560px"><span/><span class="c">#</span><span class="c">◉</span><span class="c">S</span><span class="c">Lock</span><span/><span>Layer</span><span>Mode</span><span>Track matte</span><span/><span>Parent</span></div><div class="mt-ruler"/></div><div class="mt-body"><div class="mt-scroll">\${view.tracks.map((track,i)=>html\`<\${LayerRow} key=\${track.id} row=\${{clip:track.clips[0],track,n:i+1}} view=\${view} X=\${t=>12+t*80} zoom=80 marquee=\${()=>{}} setWhip=\${()=>{}}/>\`)}</div></div></div>\`;}
    render(h(Layers),document.querySelector('#app'));window.ready=true;
  `,
}
const browser = await chromium.launch({ executablePath: process.env.REEL_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const pageErrors = [], blockedRequests = [], records = []
try {
  for (const touch of [false, true]) {
    const context = await browser.newContext({ viewport: touch ? { width: 1180, height: 820 } : { width: 1512, height: 945 }, hasTouch: touch })
    await context.route('**/*', async route => {
      const url = new URL(route.request().url()), file = url.pathname
      if (url.hostname !== 'arya-motion.test') { blockedRequests.push(url.origin);return route.abort() }
      try {
        if (file === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><link rel="stylesheet" href="/web/styles.css"><link id="motion-css" rel="stylesheet" href="/web/ui/motion/motion.css"><style>#app{margin:32px;height:420px;border:1px solid var(--line);border-radius:6px;overflow:hidden}</style><script type="importmap">{"imports":{"preact":"/preact.js","preact/hooks":"/hooks.js","htm":"/htm.js"}}</script></head><body><div id="app"></div><script type="module" src="/fixture.js"></script></body></html>` })
        if (modules[file]) return route.fulfill({ contentType: 'text/javascript', body: modules[file] })
        if (file === '/baseline-motion.css' && baseline) return route.fulfill({ contentType: 'text/css', body: await fs.readFile(baseline) })
        const deps = { '/preact.js': 'node_modules/preact/dist/preact.module.js', '/hooks.js': 'node_modules/preact/hooks/dist/hooks.module.js', '/htm.js': 'node_modules/htm/dist/htm.module.js', '/fonts/manrope.ttf': 'web/fonts/manrope.ttf' }
        const resolved = path.resolve(deps[file] ? dependencies : root, deps[file] || file.slice(1))
        assert.ok(resolved.startsWith((deps[file] ? dependencies : root) + path.sep))
        return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.ttf') ? 'font/ttf' : 'text/javascript', body: await fs.readFile(resolved) })
      } catch (error) { return route.fulfill({ status: 404, body: error.message }) }
    })
    const page = await context.newPage()
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.goto('http://arya-motion.test/')
    await page.waitForFunction(() => window.ready)
    await page.evaluate(() => document.fonts.ready)
    if (!touch && baseline) {
      await page.evaluate(() => { document.querySelector('#motion-css').href = '/baseline-motion.css' })
      await page.waitForFunction(() => getComputedStyle(document.querySelector('select')).appearance !== 'none')
      await page.screenshot({ path: path.join(out, 'motion-b8-before-1512.png') })
      await page.evaluate(() => { document.querySelector('#motion-css').href = '/web/ui/motion/motion.css' })
      await page.waitForFunction(() => getComputedStyle(document.querySelector('select')).appearance === 'none')
    }
    if (!touch) await page.screenshot({ path: path.join(out, 'motion-b8-after-1512.png') })
    for (const nested of [false, true]) {
      await page.evaluate(nested => window.fixture.boot(nested), nested)
      await page.waitForFunction(() => document.querySelector('.mode').value === 'multiply')
      const mode = page.getByRole('combobox', { name: 'Blend mode for Artwork', exact: true })
      const matte = page.getByRole('combobox', { name: 'Track matte for Artwork', exact: true })
      const parent = page.getByRole('combobox', { name: 'Parent for Artwork', exact: true })
      assert.equal(await page.getByRole('combobox').count(), 18)
      assert.equal(await mode.inputValue(), 'multiply')
      assert.equal(await matte.inputValue(), 'alphaInverted')
      assert.equal(await parent.inputValue(), 'c5')
      assert.equal(await parent.getAttribute('title'), 'Parent: Null controller with a complete long source name')
      const selection = await page.evaluate(() => [...window.fixture.store.selection])
      const geometry = await mode.evaluate(el => {
        const r = el.getBoundingClientRect(), row = el.closest('.mt-row').getBoundingClientRect(), s = getComputedStyle(el)
        return { width: r.width, height: r.height, rowHeight: row.height, contained: r.top >= row.top && r.bottom <= row.bottom, appearance: s.appearance, background: s.backgroundColor, border: s.borderTopColor, fontSize: s.fontSize, coarse: matchMedia('(any-pointer: coarse)').matches }
      })
      assert.equal(geometry.appearance, 'none')
      assert.equal(geometry.background, 'rgba(0, 0, 0, 0)')
      assert.equal(geometry.border, 'rgba(0, 0, 0, 0)')
      assert.equal(geometry.contained, true)
      assert.equal(geometry.coarse, touch)
      for (const control of await page.getByRole('combobox').all()) {
        const box = await control.boundingBox()
        if (touch) assert.ok(box.width >= 44 && box.height >= 44)
        else assert.equal(box.height, 20)
        assert.equal(await control.evaluate(el => { const r = el.getBoundingClientRect(), row = el.closest('.mt-row').getBoundingClientRect();return r.top >= row.top && r.bottom <= row.bottom }), true)
      }
      await mode.focus()
      await page.keyboard.press('Tab')
      assert.equal(await matte.evaluate(el => el === document.activeElement), true)
      await page.keyboard.press('Tab')
      assert.equal(await parent.evaluate(el => el === document.activeElement), true)
      const focus = await parent.evaluate(el => { const s = getComputedStyle(el);return { width: s.outlineWidth, style: s.outlineStyle, color: s.outlineColor } })
      assert.deepEqual(focus, { width: '2px', style: 'solid', color: 'rgb(239, 188, 104)' })
      if (!nested) await page.screenshot({ path: path.join(out, touch ? 'motion-b8-focus-touch-1180.png' : 'motion-b8-focus-1512.png') })
      await page.keyboard.press('F9')
      await page.keyboard.press('q')
      assert.equal(await page.evaluate(() => window.toastCalls), 0)
      assert.equal(await page.evaluate(() => window.fixture.store.tool), 'select')
      assert.deepEqual(await page.evaluate(() => window.fixture.store.selection), selection)
      assert.equal(await page.evaluate(() => window.edits.length), 0)
      await page.keyboard.press('Escape')
      await mode.selectOption('normal')
      const before = await page.evaluate(() => structuredClone(window.fixture.store.project))
      await mode.focus()
      await page.keyboard.press('s')
      await page.keyboard.press('Tab')
      console.log(JSON.stringify({ phase: 'native keyboard typeahead', touch, nested, value: await mode.inputValue(), edits: await page.evaluate(() => window.edits.length), active: await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) }))
      await page.waitForFunction(() => window.edits.length === 2)
      assert.equal(await mode.inputValue(), 'screen')
      await page.evaluate(() => window.fixture.undo())
      assert.deepEqual(await page.evaluate(() => window.fixture.store.project), before)
      await matte.selectOption('lumaInverted')
      assert.equal(await matte.inputValue(), 'lumaInverted')
      const activeMatte = await page.evaluate(() => structuredClone(window.fixture.store.project))
      await matte.selectOption('')
      assert.equal(await matte.inputValue(), '')
      assert.equal(await page.evaluate(() => window.fixture.viewProject().tracks[0].clips[0].matte), undefined)
      await page.evaluate(() => window.fixture.undo())
      assert.deepEqual(await page.evaluate(() => window.fixture.store.project), activeMatte)
      assert.equal(await matte.inputValue(), 'lumaInverted')
      await parent.selectOption('c2')
      assert.equal(await parent.inputValue(), 'c2')
      await parent.selectOption('')
      assert.equal(await parent.inputValue(), '')
      await page.evaluate(() => window.fixture.undo())
      assert.equal(await parent.inputValue(), 'c2')
      const valid = await page.evaluate(() => structuredClone(window.fixture.store.project))
      await page.evaluate(() => window.fixture.cycle())
      const cycle = await page.evaluate(() => structuredClone(window.fixture.store.project))
      await parent.selectOption('c5')
      assert.deepEqual(await page.evaluate(() => window.fixture.store.project), cycle)
      assert.equal(await parent.inputValue(), 'c2')
      assert.match(await page.evaluate(() => window.refusals.at(-1)), /loop/)
      await page.evaluate(() => window.fixture.lock())
      const locked = await page.evaluate(() => structuredClone(window.fixture.store.project))
      await mode.selectOption('screen')
      assert.deepEqual(await page.evaluate(() => window.fixture.store.project), locked)
      assert.equal(await mode.inputValue(), 'normal')
      assert.match(await page.evaluate(() => window.refusals.at(-1)), /locked/)
      if (nested) assert.deepEqual(locked.tracks, valid.tracks)
      records.push({ touch, nested, geometry, namedNativeChoices: 18, allTargetsContained: true, keyboardFocusAndTypeahead: 'PASS', oneUndo: 'PASS', activeMatteClearAndUndo: 'PASS', matteAndParentState: 'PASS', lockedAndCycleRefusal: 'PASS' })
    }
    await page.evaluate(() => window.fixture.boot())
    await page.evaluate(() => document.activeElement?.blur())
    if (touch) await page.screenshot({ path: path.join(out, 'motion-b8-after-touch-1180.png') })
    await context.close()
  }
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(blockedRequests, [])
  const receipt = { records, pageErrors, blockedRequests, nativePopupKeyboardConfirmationVerified: false, physicalDeviceAcceptanceRun: false, fullEditorAcceptanceRun: false, scope: 'Actual LayerRow and Motion keyboard listener with fixture store and shared core operations. Chromium requests use local fulfillment.' }
  await fs.writeFile(path.join(out, 'browser-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify(receipt, null, 2))
} finally { await browser.close() }
