import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyOps, newProject } from '../core/project.js'

const editor = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = process.env.REEL_LIBRARY_SMOKE_OUTPUT || await fs.mkdtemp(path.join(os.tmpdir(), 'reel-library-ui-'))
await fs.mkdir(output, { recursive: true })
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'reel-library-chrome-'))
const chromePath = process.env.REEL_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const initial = applyOps(newProject('Library UI fixture'), [
  { op: 'add_title', track: 'V1', start: 0, dur: 4, text: 'Reusable heading', title: { font: 'Avenir Next', anim: 'none' } },
  { op: 'add_title', track: 'V2', start: 0, dur: 8, text: 'Compatible title' },
  { op: 'add_title', track: 'V3', start: 0, dur: 8, text: 'Already animated' },
  { op: 'effect', id: 'c1', type: 'glow' },
  { op: 'transition', id: 'c3', type: 'crossDissolve', dur: 0.6 },
  { op: 'keyframe', id: 'c1', prop: 'opacity', at: 0, value: 0, local: true },
  { op: 'keyframe', id: 'c1', prop: 'opacity', at: 4, value: 1, local: true },
  { op: 'keyframe', id: 'c3', prop: 'opacity', at: 0, value: 1, local: true },
  { op: 'library_save', category: 'title', name: 'Opening heading', description: 'An editable heading with a gentle opacity entrance.', source: { clip: 'c1' } },
  { op: 'library_save', category: 'effect', name: 'Soft glow', description: 'A glow effect copied from the selected title.', source: { clip: 'c1' } },
  { op: 'library_save', category: 'motion', name: 'Four second fade', description: 'Two opacity keyframes that fit a compatible target length.', source: { clip: 'c1' } },
  { op: 'library_save', category: 'transition', name: 'Short dissolve', source: { clip: 'c3' } },
  { op: 'add_title', track: 'V1', start: 4, dur: 4, text: 'After the cut' },
  { op: 'add_comp', name: 'Authored transition', duration: 1 },
  { op: 'add_shape', comp: 'k1', track: 'V1', start: 0, dur: 1, shape: { type: 'rect', width: 1920, height: 1080, fill: { color: '#f5b942' } } },
  { op: 'keyframe', id: 'c5', prop: 'opacity', at: 0, value: 0, local: true },
  { op: 'keyframe', id: 'c5', prop: 'opacity', at: 0.5, value: 1, local: true },
  { op: 'keyframe', id: 'c5', prop: 'opacity', at: 1, value: 0, local: true },
  { op: 'library_save', category: 'transition', name: 'Authored wipe overlay', source: { composition: 'k1' } },
]).project
const initialCount = initial.library.items.length
let project = structuredClone(initial), version = 1
const history = []
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }

const fixtureHTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reel library verification</title><link rel="stylesheet" href="/styles.css"><script type="importmap">{"imports":{"preact":"/vendor/preact/dist/preact.module.js","preact/hooks":"/vendor/preact/hooks/dist/hooks.module.js","htm":"/vendor/htm/dist/htm.module.js"}}</script><style>body{overflow:auto}#app{max-width:1000px;margin:0 auto;padding:16px}.fixture-controls{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}.fixture-panels{display:grid;grid-template-columns:minmax(0,330px) minmax(0,330px);gap:14px}.fixture-panel{border:1px solid var(--line);border-radius:8px;overflow:hidden}.fixture-panel h2{font-size:13px;margin:12px}.fixture-panel .tab-body{overflow:visible} @media(max-width:600px){#app{padding:10px}.fixture-panels{grid-template-columns:1fr}}</style></head><body><main id="app"></main><script type="module" src="/fixture.js"></script></body></html>`
const fixtureJS = `import {h,render} from 'preact';import htm from 'htm';import {LibraryTab, SavedLibrarySection,AnimateSelection} from '/ui/plugins/library.js';import {registry} from '/ui/registry.js';import {api,set,store,useStore} from '/ui/store.js';const html=htm.bind(h);const res=await api('/api/project');set({project:res.project,version:res.version,selection:['c2'],caps:{}});window.__libraryFixture={store,set,registry,reset:async()=>{const result=await api('/api/reset',{});set({project:result.project,version:result.version,selection:['c2'],refs:[]})},undo:async()=>{const result=await api('/api/undo',{});set({project:result.project,version:result.version})}};function Fixture(){const s=useStore();return html\`<div class="fixture-controls"><button onClick=\$\{()=>set({selection:['c1']})}>Select source</button><button onClick=\$\{()=>set({selection:['c2']})}>Select compatible</button><button onClick=\$\{()=>set({selection:['c3']})}>Select animated</button><button onClick=\$\{()=>set({selection:[]})}>Clear selection</button></div><div class="fixture-panels"><section class="fixture-panel" aria-label="Project library"><h2>Library</h2><\$\{LibraryTab}/></section><section class="fixture-panel" aria-label="Titles and contextual motion"><h2>Titles</h2><div class="tab-body"><\$\{SavedLibrarySection} category="title"/><\$\{AnimateSelection}/></div></section></div>\`};render(h(Fixture),document.getElementById('app'));window.__libraryFixtureReady=true;`

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1')
    const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/project') return json({ project, version })
      let bytes = ''
      for await (const chunk of req) bytes += chunk
      if (url.pathname === '/api/ops') {
        const body = JSON.parse(bytes)
        if (!Number.isSafeInteger(body.expectedVersion)) return json({ error: 'Library operations must send their captured expectedVersion.' }, 400)
        if (body.expectedVersion !== version) return json({ error: 'The project version changed. Refresh the form before editing.' }, 409)
        const result = applyOps(project, body.ops)
        history.push(structuredClone(project)); project = result.project; version++
        return json({ ...result, version })
      }
      if (url.pathname === '/api/reset') { project = structuredClone(initial); history.length = 0; version++; return json({ project, version }) }
      if (url.pathname === '/api/undo') { project = history.pop() ?? project; version++; return json({ project, version }) }
      return json({ error: 'Unknown fixture route' }, 404)
    }
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(fixtureHTML) }
    if (url.pathname === '/fixture.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(fixtureJS) }
    const base = url.pathname.startsWith('/core/') ? path.join(editor, 'core') : url.pathname.startsWith('/vendor/') ? path.join(editor, 'node_modules') : path.join(editor, 'web')
    const relative = url.pathname.startsWith('/core/') ? url.pathname.slice(6) : url.pathname.startsWith('/vendor/') ? url.pathname.slice(8) : url.pathname.slice(1)
    const file = path.resolve(base, relative)
    if (!file.startsWith(base + path.sep)) { res.writeHead(403); return res.end() }
    const data = await fs.readFile(file)
    res.writeHead(200, { 'content-type': mime[path.extname(file)] ?? 'application/octet-stream' }); res.end(data)
  } catch (error) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })) }
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const address = `http://127.0.0.1:${server.address().port}`
const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
let socket
const pageErrors = []
try {
  const browserURL = await new Promise((resolve, reject) => {
    let stderr = ''
    const timeout = setTimeout(() => reject(new Error('Headless Chrome did not start in 15 seconds')), 15000)
    chrome.on('error', error => { clearTimeout(timeout); reject(error) })
    chrome.stderr.on('data', chunk => { stderr += chunk; const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr); if (match) { clearTimeout(timeout); resolve(match[1]) } })
  })
  const devtools = new URL(browserURL)
  const tabs = await fetch(`http://${devtools.host}/json/list`).then(response => response.json())
  socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  let next = 0
  const pending = new Map()
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id) { const promise = pending.get(message.id); pending.delete(message.id); message.error ? promise?.reject(new Error(message.error.message)) : promise?.resolve(message.result) }
    if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
  })
  const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })) })
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  const until = async expression => {
    for (let count = 0; count < 100; count++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)) }
    throw new Error(`UI condition did not become true: ${expression}`)
  }
  const click = label => evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(node=>node.textContent.trim()===${JSON.stringify(label)});if(!button)throw Error('Button missing');button.click();return !button.disabled})()`)
  await call('Runtime.enable')
  await call('Page.enable')
  await call('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false })
  await call('Page.navigate', { url: address })
  await until('window.__libraryFixtureReady === true && document.querySelector(".reel-library-item")')
  const ids = await evaluate('window.__libraryFixture.store.project.library.items.map(item=>({id:item.id,category:item.category,customTransition:!!item.body.composition}))')
  assert.deepEqual(await evaluate('window.__libraryFixture.registry.browserSections.map(section=>section.tab).sort()'), ['effects', 'titles', 'transitions'])
  const customTransition = ids.find(item => item.category === 'transition' && item.customTransition).id
  await evaluate('window.__libraryFixture.set({selection:["c4"]})')
  await until(`!document.querySelector('[data-library-item="${customTransition}"] button').disabled`)
  await evaluate(`document.querySelector('[data-library-item="${customTransition}"] button').click()`)
  await until('Object.keys(window.__libraryFixture.store.project.comps).length === 2')
  const overlay = project.tracks.flatMap(track => track.clips).find(clip => clip.kind === 'comp')
  assert.equal(overlay.start, 3.5)
  assert.equal(overlay.dur, 1)
  const overlayTrackIndex = project.tracks.findIndex(track => track.clips.includes(overlay))
  const targetTrackIndex = project.tracks.findIndex(track => track.clips.some(clip => clip.id === 'c4'))
  assert(overlayTrackIndex > targetTrackIndex)
  assert.equal(project.tracks.filter(track => track.kind === 'video').length, initial.tracks.filter(track => track.kind === 'video').length + 1)
  for (const track of initial.tracks) assert.deepEqual(project.tracks.find(candidate => candidate.id === track.id).clips, track.clips)
  const overlayLayer = project.comps[overlay.comp].tracks.flatMap(track => track.clips).find(clip => clip.kind === 'shape')
  assert.notEqual(overlayLayer.id, 'c5')
  assert.deepEqual(overlayLayer.anim.opacity, [[0, 0], [0.5, 1], [1, 0]])
  await evaluate('window.__libraryFixture.undo()')
  assert.equal(Object.keys(project.comps).length, 1)
  await evaluate('window.__libraryFixture.set({selection:["c2"]})')
  const motion = ids.find(item => item.category === 'motion').id
  await evaluate(`document.querySelector('[data-library-item="${motion}"] button').click()`)
  await until('window.__libraryFixture.store.project.tracks[1].clips[0].anim?.opacity?.length === 2')
  assert.equal(await evaluate('window.__libraryFixture.store.project.tracks[1].clips[0].anim.opacity.at(-1)[0]'), 8)
  await evaluate('window.__libraryFixture.undo()')
  assert.equal(await evaluate('!!window.__libraryFixture.store.project.tracks[1].clips[0].anim?.opacity'), false)
  await click('Select animated')
  await until(`document.querySelector('[data-library-item="${motion}"] button').disabled`)
  assert.match(await evaluate(`document.querySelector('[data-library-item="${motion}"]').textContent`), /opacity/)
  await click('Select compatible')
  await until('window.__libraryFixture.store.selection[0] === "c2"')
  await click('Ask AI')
  await until('document.querySelector(".reel-animate textarea")')
  await evaluate(`(()=>{const input=document.querySelector('.reel-animate textarea');input.value='Fade this title in slowly.';input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  await click('Select source')
  await until('document.querySelector(".reel-animate form")?.textContent.includes("Refresh selected layers")')
  assert.equal(await evaluate(`Array.from(document.querySelector('.reel-animate form').querySelectorAll('button')).find(node=>node.textContent.trim()==='Attach request').disabled`), true)
  assert.equal(await evaluate('window.__libraryFixture.store.refs.length'), 0)
  await click('Refresh selected layers')
  await until(`!Array.from(document.querySelector('.reel-animate form').querySelectorAll('button')).find(node=>node.textContent.trim()==='Attach request').disabled`)
  assert.equal(await evaluate(`document.querySelector('.reel-animate textarea').value`), 'Fade this title in slowly.')
  await click('Attach request')
  await until('window.__libraryFixture.store.refs.length === 1')
  assert.equal(await evaluate('window.__libraryFixture.store.refs[0].intent'), 'Fade this title in slowly.')
  assert.deepEqual(await evaluate('window.__libraryFixture.store.refs[0].context.selected'), ['c1'])
  await click('Select source')
  await until('window.__libraryFixture.store.selection[0] === "c1"')
  await click('Save selection to library')
  await until('document.querySelector(".reel-library-save form input")')
  await evaluate(`(()=>{const input=document.querySelector('.reel-library-save form input');input.value='Saved via UI';input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  await click('Select compatible')
  await until('document.querySelector(".reel-library-save form")?.textContent.includes("Refresh source selection")')
  assert.equal(await evaluate(`Array.from(document.querySelector('.reel-library-save form').querySelectorAll('button')).find(node=>node.textContent.trim()==='Save component').disabled`), true)
  assert.equal(await evaluate(`document.querySelector('.reel-library-save form').textContent.includes('c1')`), true)
  assert.equal(project.library.items.length, initialCount)
  await click('Refresh source selection')
  await until('document.querySelector(".reel-library-save form")?.textContent.includes("c2")')
  await click('Save component')
  await until('window.__libraryFixture.store.project.library.items.some(item=>item.name === "Saved via UI")')
  assert.equal(project.library.items.length, initialCount + 1)
  assert.equal(project.tracks[0].clips[0].title.text, 'Reusable heading')
  assert.equal(project.library.items.find(item => item.name === 'Saved via UI').body.clip.title.text, 'Compatible title')
  const saved = project.library.items.find(item => item.name === 'Saved via UI').id
  await evaluate(`document.querySelector('[data-library-item="${saved}"] button[aria-expanded]').click()`)
  await until(`document.querySelector('[data-library-item="${saved}"] form')`)
  await evaluate(`(()=>{const input=document.querySelector('[data-library-item="${saved}"] form input');input.value='Renamed via UI';input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  await click('Save name')
  await until('window.__libraryFixture.store.project.library.items.some(item=>item.name === "Renamed via UI")')
  await evaluate(`document.querySelector('[data-library-item="${saved}"] button[aria-expanded]').click()`)
  await until(`document.querySelector('[data-library-item="${saved}"] form')`)
  await click('Remove')
  await until(`window.__libraryFixture.store.project.library.items.length === ${initialCount}`)
  await evaluate('window.__libraryFixture.undo()')
  assert.equal(project.library.items.find(item => item.id === saved).name, 'Renamed via UI')
  await evaluate('window.__libraryFixture.reset()')
  await until(`window.__libraryFixture.store.project.library.items.length === ${initialCount}`)
  const title = ids.find(item => item.category === 'title').id
  await evaluate(`document.querySelector('[data-library-item="${title}"] button[aria-expanded]').click()`)
  await until(`document.querySelector('[data-library-item="${title}"] form')`)
  project = structuredClone(project)
  project.library.items.find(item => item.id === title).body.clip.title.text = 'Reused ID in the same folder'
  version++
  await evaluate(`(()=>{const staleRename=document.querySelector('[data-library-item="${title}"] form button[type="submit"]');window.__libraryFixture.set({project:${JSON.stringify(project)},version:${version}});staleRename.click();})()`)
  await until(`!document.querySelector('[data-library-item="${title}"] form')`)
  assert.equal(project.library.items.find(item => item.id === title).name, 'Opening heading')
  await evaluate(`document.querySelector('[data-library-item="${title}"] button[aria-expanded]').click()`)
  await until(`document.querySelector('[data-library-item="${title}"] form')`)
  project = structuredClone(project)
  project.library.items.find(item => item.id === title).body.clip.title.text = 'ID reused again in the same folder'
  version++
  await evaluate(`(()=>{const staleRemove=[...document.querySelector('[data-library-item="${title}"] form').querySelectorAll('button')].find(node=>node.textContent.trim()==='Remove');window.__libraryFixture.set({project:${JSON.stringify(project)},version:${version}});staleRemove.click();})()`)
  await until(`!document.querySelector('[data-library-item="${title}"] form')`)
  assert.equal(project.library.items.length, initialCount)
  await evaluate('window.__libraryFixture.reset()')
  await until(`window.__libraryFixture.store.project.library.items.length === ${initialCount}`)
  await evaluate(`(()=>{const staleApply=document.querySelector('[data-library-item="${motion}"] button');window.__libraryFixture.set({selection:['c4']});staleApply.click();})()`)
  assert.equal(project.tracks[0].clips.find(clip=>clip.id==='c4').anim?.opacity, undefined)
  await evaluate(`document.querySelector('[data-library-item="${title}"] button[aria-expanded]').click()`)
  await until(`document.querySelector('[data-library-item="${title}"] form')`)
  const countBeforeSwitch = project.library.items.length
  await evaluate(`(()=>{const staleRemove=[...document.querySelector('[data-library-item="${title}"] form').querySelectorAll('button')].find(node=>node.textContent.trim()==='Remove');const other=structuredClone(window.__libraryFixture.store.project);other.name='Different project';other.library.items.find(item=>item.id==='${title}').body.clip.title.text='Different source with same ID';window.__libraryFixture.set({root:'/fixture/second-project',project:other,refs:[]});staleRemove.click();})()`)
  await until(`!document.querySelector('[data-library-item="${title}"] form')`)
  assert.equal(project.library.items.length, countBeforeSwitch)
  await evaluate('window.__libraryFixture.reset()')
  await until('window.__libraryFixture.store.project.name === "Library UI fixture"')
  await evaluate(`(()=>{const staleAnimate=[...document.querySelector('.reel-animate').querySelectorAll('button')].find(node=>node.textContent.trim()==='Animate selected');window.__libraryFixture.set({root:'/fixture/third-project',refs:[]});staleAnimate.click();})()`)
  assert.equal(await evaluate('window.__libraryFixture.store.refs.length'), 0)
  await evaluate('window.__libraryFixture.reset()')
  await evaluate(`(()=>{window.__libraryFixture.set({selection:['c4']});const filter=document.querySelector('#reel-library-filter');filter.value='transition';filter.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  await until(`!document.querySelector('[data-library-item="${customTransition}"] button').disabled && document.querySelector('#reel-library-filter').value === 'transition'`)
  await fs.writeFile(path.join(output, 'library-desktop.png'), Buffer.from((await call('Page.captureScreenshot', { captureBeyondViewport: true })).data, 'base64'))
  await call('Emulation.setDeviceMetricsOverride', { width: 375, height: 1000, deviceScaleFactor: 1, mobile: true })
  await until('innerWidth === 375')
  assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false)
  assert.equal(await evaluate(`(()=>{const rgb=getComputedStyle(document.querySelector('.reel-library-note')).color.match(/[0-9]+/g).map(Number);const linear=v=>{v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4};const l=c=>c.reduce((n,v,i)=>n+linear(v)*[0.2126,0.7152,0.0722][i],0);return(l(rgb)+0.05)/(l([24,24,29])+0.05)>=4.5})()`), true)
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.reel-library input,.reel-library select,.reel-library textarea')).every(node=>node.closest('label')||node.getAttribute('aria-label')||(node.id&&document.querySelector('label[for="'+node.id+'"]')))`), true)
  await fs.writeFile(path.join(output, 'library-mobile.png'), Buffer.from((await call('Page.captureScreenshot', { captureBeyondViewport: true })).data, 'base64'))
  await evaluate(`(()=>{const input=document.querySelector('#reel-library-search');input.value='no matching component';input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  await until('document.querySelector(".reel-library-empty")?.textContent.includes("No saved components match")')
  assert.deepEqual(pageErrors, [])
  console.log(`Library UI passed custom transition overlay, save, apply, conflict, rename, remove, undo, assistant intent, stale project actions, labels, contrast and 375px layout checks. Screenshots: ${output}`)
} finally {
  socket?.close()
  const stopped = new Promise(resolve => { if (chrome.exitCode !== null || chrome.signalCode !== null) resolve(); else chrome.once('exit', resolve) })
  chrome.kill()
  await stopped
  server.close()
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
