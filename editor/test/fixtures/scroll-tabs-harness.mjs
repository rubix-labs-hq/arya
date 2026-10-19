// Loads the real web/ui/scroll-tabs.js with small stand-ins for Preact's hooks, so tests can
// render ScrollTabs as a function, run its effects after each render and drive its handlers.
import fs from 'node:fs/promises'

const moduleURL = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const hooksURL = moduleURL(['useState', 'useRef', 'useEffect', 'useLayoutEffect'].map(name => `export const ${name}=(...a)=>globalThis.__tabHooks.${name}(...a);`).join(''))

export async function loadScrollTabs(tag = '') {
  let source = await fs.readFile(new URL('../../web/ui/scroll-tabs.js', import.meta.url), 'utf8')
  for (const [from, to] of [['preact/hooks', hooksURL], ['preact', import.meta.resolve('preact')], ['htm', import.meta.resolve('htm')], ['./icons.js', new URL('../../web/ui/icons.js', import.meta.url).href]]) source = source.replaceAll(`'${from}'`, JSON.stringify(to))
  return import(moduleURL(`${source}\n// ${tag}`))
}

/** One hook scope per component instance: slots in call order, effects queued until flushed. */
export class Scope {
  slots = []; index = 0; queue = []
  useState = initial => { const slot = this.slot(() => ({ value: initial })); return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next }] }
  useRef = initial => this.slot(() => ({ current: initial }))
  useEffect = (run, deps) => {
    const slot = this.slot(() => ({}))
    if (!deps || !slot.deps || deps.some((d, k) => d !== slot.deps[k])) { slot.deps = deps; this.queue.push(() => { slot.cleanup?.(); slot.cleanup = run() }) }
  }
  useLayoutEffect = (run, deps) => this.useEffect(run, deps)
  slot(make) { const i = this.index++; return (this.slots[i] ??= make()) }
  render(component, props) { globalThis.__tabHooks = this; this.index = 0; return component(props) }
  flush() { const queued = this.queue.splice(0); queued.forEach(run => run()) }
  unmount() { for (const slot of this.slots) slot?.cleanup?.() }
}

export const walk = (node, out = []) => { if (Array.isArray(node)) node.forEach(n => walk(n, out)); else if (node && typeof node === 'object') { out.push(node); walk(node.props?.children, out) } return out }
export const cls = (node, name) => String(node.props?.class ?? '').split(/\s+/).includes(name)
