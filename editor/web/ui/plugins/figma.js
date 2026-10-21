// Figma tab in the left panel: connect your own Figma account, paste a link, pick frames,
// bring one in as a composition or two as a Smart Animate, and place compositions on the
// timeline. The page never sees a Figma token; the server answers { connected, handle, method }.

import { h } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { placeCompOps } from '/core/figma.js'
import { attachMotionIntent } from './library.js'
import { registerBrowserTab, registerSettings } from '../registry.js'
import { api, edit, set, store, time, toast, useStore } from '../store.js'
import { openComposition } from '../timeline.js'

const html = htm.bind(h)

const TOKEN_HELP = 'https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens'
const EASES = ['smooth', 'inOut', 'out', 'expoOut', 'backOut', 'linear']

const CSS = `
.fig { gap: 14px; }
.fig section { display: flex; flex-direction: column; gap: 7px; }
.fig h4 { margin: 0; display: flex; align-items: center; gap: 6px; }
.fig .row { display: flex; gap: 6px; align-items: center; min-width: 0; }
.fig .row > input:not([type=checkbox]) { flex: 1; }
.fig .who { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; padding: 7px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel-2); }
.fig .who .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--good); flex: none; }
.fig .who .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fig .who .grow { flex: 1 1 96px; min-width: 0; }
.fig .err { color: var(--danger); font-size: 11.5px; }
.fig .link { color: var(--accent); text-decoration: none; }
.fig .link:hover { text-decoration: underline; }
.fig .crumbs { font-size: 11.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fig .crumbs b { color: var(--text); font-weight: 600; }
.fig .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 6px; }
.fig .card { all: unset; box-sizing: border-box; cursor: pointer; border-radius: 6px; padding: 3px; border: 1px solid transparent; display: block; min-width: 0; }
.fig .card:hover { background: #ffffff08; }
.fig .card:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.fig .card[aria-pressed=true] { border-color: var(--accent); background: #f5b94210; }
.fig .thumb { aspect-ratio: 16/9; border-radius: 5px; background: repeating-conic-gradient(#16161b 0% 25%, #111115 0% 50%) 50% / 12px 12px; position: relative; display: grid; place-items: center; overflow: hidden; }
.fig .thumb img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
.fig .thumb .kind { position: absolute; left: 4px; top: 3px; background: #000b; color: var(--muted); font-size: 9.5px; padding: 0 4px; border-radius: 3px; letter-spacing: 0.03em; }
.fig .thumb .pick { position: absolute; right: 4px; top: 4px; width: 18px; height: 18px; border-radius: 50%; background: var(--accent); color: var(--accent-ink); font: 700 11px/18px -apple-system, sans-serif; text-align: center; }
.fig .card .name { font-size: 11.5px; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fig .card .size { font: 10px ui-monospace, Menlo, monospace; color: var(--muted); }
.fig .opts { display: grid; grid-template-columns: auto 1fr; gap: 5px 8px; align-items: center; font-size: 12px; color: var(--muted); }
.fig .opts input[type=number] { width: 64px; }
.fig .opts select { justify-self: start; }
.fig .opts .wide { grid-column: 1 / -1; color: var(--text); }
.fig .actions { display: flex; gap: 6px; flex-wrap: wrap; }
.fig .notes { font-size: 11.5px; color: var(--muted); margin: 0; padding-left: 16px; }
.fig .notes li { margin: 2px 0; }
.fig .comps { display: flex; flex-direction: column; gap: 2px; }
.fig .comp { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 5px; }
.fig .comp:hover { background: #ffffff08; }
.fig .comp .meta { flex: 1; min-width: 0; }
.fig .comp .title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fig .comp .sub { font: 10.5px ui-monospace, Menlo, monospace; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fig .comp-actions { display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; max-width: 140px; }
.fig .comp-actions button { min-height: 40px; }
.fig .waiting { font-size: 11.5px; color: var(--muted); display: flex; flex-direction: column; gap: 6px; }
@media (prefers-reduced-motion: no-preference) { .fig .card { transition: background 0.12s, border-color 0.12s; } }
`

function installStyle() {
  if (typeof document === 'undefined' || document.getElementById('figma-plugin-style')) return
  const el = document.createElement('style')
  el.id = 'figma-plugin-style'
  el.textContent = CSS
  document.head.append(el)
}

const errorText = e => (e?.message ?? String(e)).replace(/^Error: /, '')

function Account({ status, onStatus }) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pendingUrl, setPendingUrl] = useState(null)
  const poll = useRef(null)
  useEffect(() => () => clearInterval(poll.current), [])

  const saveToken = async e => {
    e?.preventDefault()
    setBusy(true)
    setError('')
    try {
      const s = await api('/api/figma/token', { token })
      setToken('')
      onStatus({ ...status, ...s })
      toast(`Figma connected as ${s.handle}`)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const signIn = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await api('/api/figma/oauth/start')
      if (result.started) {
        const s = await api('/api/figma/status')
        onStatus(s)
        setPendingUrl(null)
        if (s.connected) toast(`Figma connected as ${s.handle}`)
        return
      }
      const { url } = result
      if (!url) throw new Error('Figma sign-in did not return an authorization URL.')
      // Figma's sign-in must run in the system browser, not inside an embedded web view.
      const opened = window.open(url, '_blank', 'noopener')
      setPendingUrl(opened ? '' : url)
      const until = Date.now() + 5 * 60 * 1000
      clearInterval(poll.current)
      poll.current = setInterval(async () => {
        const s = await api('/api/figma/status').catch(() => null)
        if (s?.connected) {
          clearInterval(poll.current)
          setPendingUrl(null)
          onStatus(s)
          toast(`Figma connected as ${s.handle}`)
        } else if (Date.now() > until) {
          clearInterval(poll.current)
          setPendingUrl(null)
          setError('Figma sign-in timed out. Try again.')
        }
      }, 1500)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    await api('/api/figma/disconnect', {})
    onStatus({ ...status, connected: false, handle: null, method: null })
  }

  if (!status) return html`<div class="hint">Checking Figma…</div>`
  if (status.connected) {
    return html`
      <div class="who">
        <span class="dot"></span>
        <div class="grow"><div class="name">${status.handle ?? 'Figma account'}</div><div class="muted" style=${{ fontSize: '11px' }}>${status.method === 'oauth' ? 'Signed in with Figma' : 'Personal token'}</div></div>
        <button class="ghost tiny" onClick=${disconnect}>Disconnect</button>
      </div>`
  }

  return html`
    <div class="hint">Connect your own Figma account to bring frames in. Your access token stays on the computer running the editor, never in the project.</div>
    ${status.oauth ? html`
      <button class="primary" disabled=${busy || pendingUrl !== null} onClick=${signIn}>Sign in with Figma</button>
      ${pendingUrl !== null ? html`
        <div class="waiting">
          <span>Finish signing in in your browser. This updates on its own.</span>
          ${pendingUrl ? html`<span>Your browser did not open. <a class="link" href=${pendingUrl} target="_blank" rel="noopener">Open Figma sign-in</a></span>` : null}
          <button class="ghost tiny" style=${{ alignSelf: 'flex-start' }} onClick=${() => { clearInterval(poll.current); setPendingUrl(null) }}>Cancel</button>
        </div>` : null}
      <div class="hint">Or paste a personal access token:</div>` : null}
    <form class="row" onSubmit=${saveToken}>
      <input type="password" autocomplete="off" spellcheck="false" placeholder="figd_…" aria-label="Figma personal access token" value=${token} onInput=${e => setToken(e.target.value)} />
      <button type="submit" class=${status.oauth ? '' : 'primary'} disabled=${busy || !token.trim()}>${busy ? 'Checking…' : 'Connect'}</button>
    </form>
    <div class="hint">In Figma: Settings → Security → Personal access tokens. Give it read access to <b>File content</b> and <b>Current user</b>. <a class="link" href=${TOKEN_HELP} target="_blank" rel="noopener">How</a></div>
    <div class="hint">Your token is saved in ~/.reel on the computer running the editor (or its configured settings folder), never in the project.</div>
    <div class="hint">Or, in Claude Code with the Figma MCP server, run <code>/reel</code> and ask Claude to import a frame. Editor chat cannot access that session’s Figma connection.</div>
    ${error ? html`<div class="err" role="alert">${error}</div>` : null}`
}

function FrameCard({ frame, pick, onPick, onOpen }) {
  const container = frame.type === 'SECTION' || frame.type === 'CANVAS'

  return html`
    <button class="card" aria-pressed=${pick ? 'true' : 'false'} title=${container ? `Open ${frame.name}` : frame.name}
      onClick=${() => (container ? onOpen(frame) : onPick(frame))}>
      <div class="thumb">
        ${frame.thumbnail ? html`<img src=${frame.thumbnail} alt="" loading="lazy" />` : html`<span class="muted">${container ? '▤' : '▢'}</span>`}
        ${frame.type !== 'FRAME' ? html`<span class="kind">${frame.type.toLowerCase().replace('_', ' ')}</span>` : null}
        ${pick ? html`<span class="pick">${pick}</span>` : null}
      </div>
      <div class="name">${frame.name}</div>
      <div class="size">${container ? 'open ›' : frame.width ? `${Math.round(frame.width)}×${Math.round(frame.height)}` : ''}</div>
    </button>`
}

function Frames() {
  const [url, setUrl] = useState('')
  const [listing, setListing] = useState(null)
  const [picked, setPicked] = useState([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notes, setNotes] = useState([])
  const [length, setLength] = useState(5)
  const [transition, setTransition] = useState(0.8)
  const [ease, setEase] = useState('smooth')
  const [place, setPlace] = useState(true)

  const load = async (body, e) => {
    e?.preventDefault()
    setBusy('load')
    setError('')
    setNotes([])
    try {
      const data = await api('/api/figma/frames', body)
      setListing(data)
      // A link to one frame preselects it.
      setPicked(data.target && data.frames[0]?.id === data.target.id && data.target.type !== 'CANVAS' && data.target.type !== 'SECTION' ? [data.target.id] : [])
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy('')
    }
  }

  const togglePick = frame => setPicked(p => (p.includes(frame.id) ? p.filter(id => id !== frame.id) : [...p, frame.id].slice(-2)))

  const run = async (what, body) => {
    setBusy(what)
    setError('')
    try {
      const res = await api('/api/figma/import', { fileKey: listing.fileKey, placeOnTimeline: place, start: time.t, comp: store.openComp, ...body })
      toast(place ? `Imported "${res.name}" and placed it at the playhead` : `Imported "${res.name}" into Compositions`)
      setNotes(n => [...n, ...(res.images?.length ? [`Imported as images, not editable as shapes or text: ${res.images.join(', ')}`] : []), ...res.warnings])

      return res
    } catch (err) {
      setError(errorText(err))

      return null
    } finally {
      setBusy('')
    }
  }

  const importPicked = async () => {
    setNotes([])
    const destination = { comp: store.openComp, start: time.t }
    for (const id of picked) if (!(await run('import', { nodeId: id, duration: Number(length) || 5, ...destination }))) break
  }
  const smart = () => {
    setNotes([])
    run('smart', { mode: 'smartAnimate', nodeId: picked[0], toNodeId: picked[1], transition: Number(transition) || 0.8, ease })
  }
  const nameOf = id => listing?.frames.find(f => f.id === id)?.name ?? id

  return html`
    <form class="row" onSubmit=${e => load({ url }, e)}>
      <input placeholder="Paste a Figma link to a page or frame" aria-label="Figma link" value=${url} onInput=${e => setUrl(e.target.value)} />
      <button type="submit" disabled=${!url.trim() || busy === 'load'}>${busy === 'load' ? 'Loading…' : 'Load'}</button>
    </form>
    ${error ? html`<div class="err" role="alert">${error}</div>` : null}
    ${listing ? html`
      <div class="crumbs" title=${`${listing.fileName} › ${listing.target.name}`}>${listing.fileName} › <b>${listing.target.name}</b>
        ${listing.target.type === 'SECTION' ? html` · <a class="link" href="#" onClick=${e => { e.preventDefault(); load({ fileKey: listing.fileKey }) }}>page</a>` : null}</div>
      ${listing.frames.length ? html`
        <div class="hint">Pick one frame to import it, or two (A, then B) to animate between them.</div>
        <div class="grid">
          ${listing.frames.map(f => html`<${FrameCard} key=${f.id} frame=${f} pick=${picked.length === 2 ? ['A', 'B'][picked.indexOf(f.id)] : picked.includes(f.id) ? '✓' : null}
            onPick=${togglePick} onOpen=${fr => load({ fileKey: listing.fileKey, nodeId: fr.id })} />`)}
        </div>` : html`<div class="hint">No frames on this page. Paste a link to another page or to a frame.</div>`}
      ${picked.length ? html`
        <div class="opts">
          <label for="fig-len">Length</label><span><input id="fig-len" type="number" min="0.5" step="0.5" value=${length} onInput=${e => setLength(e.target.value)} /> s</span>
          ${picked.length === 2 ? html`
            <label for="fig-tr">Transition</label><span><input id="fig-tr" type="number" min="0.1" step="0.1" value=${transition} onInput=${e => setTransition(e.target.value)} /> s</span>
            <label for="fig-ease">Ease</label><select id="fig-ease" value=${ease} onChange=${e => setEase(e.target.value)}>${EASES.map(x => html`<option value=${x}>${x}</option>`)}</select>` : null}
          <label class="row wide"><input type="checkbox" checked=${place} onChange=${e => setPlace(e.target.checked)} /> Place at the playhead</label>
        </div>
        <div class="actions">
          <button class=${picked.length === 1 ? 'primary' : ''} disabled=${Boolean(busy)} onClick=${importPicked}>${busy === 'import' ? 'Importing…' : picked.length === 1 ? 'Import as composition' : 'Import both'}</button>
          ${picked.length === 2 ? html`<button class="primary" disabled=${Boolean(busy)} onClick=${smart} title=${`${nameOf(picked[0])} → ${nameOf(picked[1])}`}>${busy === 'smart' ? 'Animating…' : 'Smart Animate A → B'}</button>` : null}
        </div>` : null}
      ${notes.length ? html`<details><summary class="hint">${notes.length} note${notes.length === 1 ? '' : 's'} from the import</summary><ul class="notes">${notes.map(n => html`<li>${n}</li>`)}</ul></details>` : null}` : null}`
}

function Compositions({ project }) {
  const { root, version, openComp } = useStore()
  const comps = Object.values(project.comps ?? {}).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
  const uses = id => [project.tracks, ...Object.values(project.comps ?? {}).map(k => k.tracks)].flat().flatMap(t => t.clips).filter(c => c.kind === 'comp' && c.comp === id).length
  const placeAt = comp => root === store.root && version === store.version && project === store.project && openComp === store.openComp ? edit(placeCompOps(project, comp, { start: time.t, comp: openComp }), `placed composition "${comp.name}"`, { expectedVersion: version }) : toast('The project changed. Choose its current composition.', 'error')
  const ask = comp => {
    const ref = attachMotionIntent(project, [], comp.id, 'Animate the editable layers in this imported composition. Choose restrained timing and motion that fit its text and geometry. Preserve the imported hierarchy and fonts, and use native editable keyframes.', root, version)
    if (ref) {
      openComposition(comp.id)
      set({ page: 'motion' })
    }
  }

  if (!comps.length) return html`<div class="hint">No compositions yet. Imported frames land here.</div>`

  return html`
    <div class="comps">
      ${comps.map(k => html`
        <div class="comp" key=${k.id}>
          <div class="meta">
            <div class="title">${k.name}</div>
            <div class="sub" title=${`${k.width}×${k.height}, ${k.duration ?? '?'} s, used ${uses(k.id)} times`}>${uses(k.id) ? `used ${uses(k.id)}× · ` : ''}${k.duration ?? '?'}s · ${k.width}×${k.height}</div>
          </div>
          <div class="comp-actions">
            <button class="ghost tiny" title="Open this composition's editable layers" onClick=${() => { openComposition(k.id); set({ page: 'motion' }) }}>Open layers</button>
            <button class="ghost tiny" title="Attach this composition and its exact layer IDs to an animation request" onClick=${() => ask(k)}>Ask AI</button>
            <button class="tiny" title="Place at the playhead on the top free video track" onClick=${() => placeAt(k)}>Place</button>
          </div>
        </div>`)}
    </div>`
}

function FigmaTab({ project }) {
  const s = useStore()
  const available = s.caps.figma?.available !== false
  const [status, setStatus] = useState(null)
  useEffect(() => {
    installStyle()
    if (available) api('/api/figma/status').then(setStatus).catch(() => setStatus({ connected: false, oauth: false }))
  }, [available])

  return html`
    <div class="tab-body fig">
      <section><h4>Figma account</h4>${available ? html`<${Account} status=${status} onStatus=${setStatus} />` : html`<div class="hint">${s.caps.figma.reason}</div>`}</section>
      ${available && status?.connected ? html`<section><h4>Frames</h4><${Frames} /></section>` : null}
      <section><h4>Compositions</h4><${Compositions} project=${project} /></section>
    </div>`
}

registerBrowserTab({ id: 'figma', label: 'Figma', order: 60, component: FigmaTab })

function FigmaSettings() {
  const s = useStore(), hosted = s.caps.host === 'browser-local'
  const [status, setStatus] = useState(null)
  useEffect(() => { installStyle(); if (!hosted) api('/api/figma/status').then(setStatus).catch(() => setStatus({ connected: false, oauth: false })) }, [hosted])
  return html`<div class="fig"><h3 class="settings-heading">Figma</h3>${hosted ? html`<p>Figma import needs the Arya Mac app or the local editor.</p><div class="settings-actions"><a class="button primary" href="https://arya-beta-delta.vercel.app/download/#mac" target="_blank" rel="noopener noreferrer">Download for Mac</a><a class="settings-link" href="https://arya-beta-delta.vercel.app/install/#accounts" target="_blank" rel="noopener noreferrer">Run locally</a></div>` : html`<${Account} status=${status} onStatus=${setStatus} /><button class="ghost" onClick=${() => set({ settingsOpen: false, page: 'edit', browserTab: 'figma' })}>Browse Figma frames</button>`}</div>`
}
registerSettings({ id: 'figma', label: 'Figma', component: FigmaSettings })
