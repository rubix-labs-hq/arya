import { h } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { describeLibraryItem, libraryPlacesObject } from '/core/library.js'
import { prepareLibraryOps } from '/core/library-resources.js'
import { selectionMotionContext, selectionMotionReference } from '/core/selection-ai.js'
import { addRef, api, edit, editRecoveryStatus, hasPendingEdits, retryEditRecovery, set, store, time, toast, useStore } from '../store.js'
import { registerBrowserSection, registerBrowserTab, registerClipMenu, registerInspector, registerInspectorAction } from '../registry.js'
import { LIBRARY_CATEGORIES, captureLibrarySource, libraryApplyPlan, libraryItemFacts, librarySaveChoices, librarySourceStatus } from '../library/model.js'

const html = htm.bind(h)
const labelFor = category => LIBRARY_CATEGORIES.find(([id]) => id === category)?.[1] ?? category

export function installLibraryStyle() {
  if (typeof document === 'undefined' || document.getElementById('reel-library-style')) return
  const link = document.createElement('link')
  link.id = 'reel-library-style'
  link.rel = 'stylesheet'
  link.href = new URL('../library/library.css', import.meta.url).href
  document.head.appendChild(link)
}

export function attachMotionIntent(project, ids, composition, intent, expectedRoot = store.root, expectedVersion = store.version) {
  try {
    if (expectedRoot !== store.root) throw new Error('The open project changed. Select its layers again before asking AI.')
    if (expectedVersion !== store.version) throw new Error('The project changed. Refresh the selected layers before asking AI.')
    if (project !== store.project) throw new Error('The project changed. Select its current layers before asking AI.')
    const reference = selectionMotionReference(project, ids, composition, intent)
    reference.context.projectRoot = store.root
    reference.context.projectVersion = store.version
    const identity = context => JSON.stringify([context.composition == null ? ['main'] : ['composition', context.composition], context.selected])
    const selectedIdentity = identity(reference.context)
    for (const ref of store.refs) {
      if (ref.kind === reference.kind && ref.id === reference.id && (!ref.context || identity(ref.context) !== selectedIdentity)) throw new Error('This motion reference conflicts with another scoped selection. Remove that reference and attach the request again.')
    }
    const references = [...store.refs.filter(ref => !(ref.kind === reference.kind && ref.id === reference.id)), reference].slice(-16)
    if (new TextEncoder().encode(JSON.stringify(references)).length > 64000) throw new Error('The attached references are too large. Remove a reference or select fewer layers.')
    addRef(reference)
    return reference
  } catch (error) {
    toast(error.message, 'error')
    return null
  }
}

export function AnimateSelection({ clip, composition, compact = false }) {
  const s = useStore()
  useEffect(installLibraryStyle, [])
  const [open, setOpen] = useState(false)
  const [intent, setIntent] = useState('')
  const [requestScope, setRequestScope] = useState(null)
  const root = s.root
  const version = s.version
  const selection = [...s.selection]
  const project = s.project
  const previousRoot = useRef(root)
  useEffect(() => { if (previousRoot.current !== root) { setOpen(false); setIntent(''); previousRoot.current = root } }, [root])
  const comp = composition ?? s.openComp
  const ids = clip && !s.selection.includes(clip.id) ? [clip.id] : [...s.selection]
  let context
  try { context = selectionMotionContext(s.project, ids, comp) } catch { context = null }
  const renderedScope = { root, version, selection, project, ids, comp, context }
  const captured = open ? requestScope : renderedScope
  const currentScope = scope => scope && scope.root === store.root && scope.version === store.version && scope.project === store.project && scope.comp === (composition ?? store.openComp) && JSON.stringify([...scope.selection].sort()) === JSON.stringify([...store.selection].sort())
  const scopeCurrent = currentScope(captured)
  if (open) context = captured?.context
  if (!context || s.caps?.host === 'browser-local') return null
  const hasFigma = context.layers.some(layer => layer.figma)
  const attach = value => {
    if (!currentScope(captured)) return toast('The project or selected layers changed. Refresh the selected layers before attaching this request.', 'error')
    const ref = attachMotionIntent(captured.project, captured.ids, captured.comp, value, captured.root, captured.version)
    if (ref) { setOpen(false); setIntent('') }
  }
  const defaultIntent = 'Animate the selected editable layers. Choose restrained timing and motion that suit this composition. Preserve the imported geometry, hierarchy and fonts, and use native editable keyframes.'
  return html`
    <div class=${`reel-library reel-animate ${compact ? 'reel-animate-compact' : ''}`}>
      <div class="reel-library-actions">
        <button type="button" class="ghost" aria-expanded=${open} onClick=${() => { setRequestScope(renderedScope); setOpen(!open) }}>Ask AI</button>
        <button type="button" onClick=${() => attach(defaultIntent)}>Animate selected</button>
      </div>
      ${open ? html`
        <form class="reel-library-form" onSubmit=${e => { e.preventDefault(); attach(intent.trim() || defaultIntent) }} onKeyDown=${e => e.stopPropagation()}>
          <label>Motion request<textarea rows="2" maxLength="4000" value=${intent} onInput=${e => setIntent(e.target.value)} placeholder="Describe the motion, or let AI choose" /></label>
          ${context.suggestions.length ? html`<div class="reel-motion-suggestions" aria-label="Motion suggestions">${context.suggestions.map(suggestion => html`<button type="button" class="ghost" key=${suggestion.id} title=${suggestion.intent} onClick=${() => setIntent(suggestion.intent)}>${suggestion.label}</button>`)}</div>` : null}
          <p class="reel-library-note">${context.selected.length} layer${context.selected.length === 1 ? '' : 's'} attached${hasFigma ? ' with their Figma node IDs' : ''}. The assistant receives this request with your next message.</p>
          ${!scopeCurrent ? html`<p class="reel-library-error" role="alert">The selected layers or project changed. Refresh the selection before attaching your request.</p><button type="button" class="ghost" onClick=${() => { try { const currentIds = [...store.selection], currentComp = composition ?? store.openComp; setRequestScope({ root: store.root, version: store.version, selection: currentIds, project: store.project, ids: currentIds, comp: currentComp, context: selectionMotionContext(store.project, currentIds, currentComp) }) } catch (error) { toast(error.message, 'error') } }}>Refresh selected layers</button>` : null}
          <div class="reel-library-actions"><button type="button" class="ghost" onClick=${() => setOpen(false)}>Cancel</button><button type="submit" class="primary" disabled=${!scopeCurrent}>Attach request</button></div>
        </form>` : null}
    </div>`
}

export function SaveLibrarySelection({ category }) {
  const s = useStore()
  const pendingEdit = hasPendingEdits()
  const recovery = editRecoveryStatus()
  const [open, setOpen] = useState(false)
  const [capture, setCapture] = useState(null)
  const [savedChoices, setSavedChoices] = useState([])
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [effectIndex, setEffectIndex] = useState('-1')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const previousRoot = useRef(s.root)
  useEffect(() => { if (previousRoot.current !== s.root) { setOpen(false); setCapture(null); setName(''); setError(''); previousRoot.current = s.root } }, [s.root])
  const choices = librarySaveChoices(s.project, s.selection, s.openComp).filter(choice => !category || choice.category === category)
  const choice = open ? capture?.choice : choices[0]
  const clip = capture?.clip
  const compositionEffect = choice?.category === 'effect' && Boolean(choice.source.composition || choice.source.type === 'composition')
  const scope = () => ({ root: store.root, version: store.version, selection: store.selection, composition: store.openComp })
  const status = open ? librarySourceStatus(s.project, capture, scope()) : { ok: true, reason: '' }
  const refresh = (resetName = false) => {
    const currentChoices = librarySaveChoices(store.project, store.selection, store.openComp).filter(option => !category || option.category === category)
    const previous = resetName ? null : capture?.choice
    const compositionSource = source => Boolean(source?.composition || source?.type === 'composition')
    const sameSource = previous ? currentChoices.find(option => option.category === previous.category && JSON.stringify(option.source) === JSON.stringify(capture.choice.source)) : null
    const sameForm = option => option.category === previous?.category && (option.category !== 'effect' || compositionSource(option.source) === compositionSource(previous.source))
    const current = sameSource ?? currentChoices.find(sameForm) ?? (previous?.category === 'effect' ? null : currentChoices[0])
    if (!current) { setError(previous?.category === 'effect' ? 'This source cannot preserve the chosen Effects form. Cancel and choose a new source.' : 'Select a compatible source before refreshing.'); return }
    setSavedChoices(structuredClone(currentChoices))
    setCapture(captureLibrarySource(store.project, current, scope()))
    if (resetName) setName(current.name ?? '')
    setEffectIndex('-1'); setError('')
  }
  const begin = () => { if (hasPendingEdits()) return; refresh(true); setOpen(true); setDescription('') }
  const save = async e => {
    e.preventDefault()
    if (hasPendingEdits()) { setError(editRecoveryStatus()?.reason ?? 'Wait for the current edit to finish before saving a component.'); return }
    const current = librarySourceStatus(store.project, capture, scope())
    if (!current.ok) { setError(current.reason); return }
    if (!choice || !name.trim()) return
    setBusy(true)
    setError('')
    try {
      const assertCurrent = () => {
        if (hasPendingEdits()) throw new Error(editRecoveryStatus()?.reason ?? 'Wait for the current edit to finish before saving a component.')
        const status = librarySourceStatus(store.project, capture, scope())
        if (!status.ok) throw new Error(status.reason)
      }
      const operation = { op: 'library_save', comp: capture.composition, category: choice.category, name: name.trim(), description: description.trim(), source: choice.source, ...(choice.category === 'effect' && !compositionEffect && Number(effectIndex) >= 0 ? { index: Number(effectIndex) } : {}) }
      const prepared = await prepareLibraryOps(store.project, [operation], path => api('/api/luts/inspect', { path }), assertCurrent)
      assertCurrent()
      const result = await edit(prepared.ops, `save "${name.trim()}" to the project library`, { expectedVersion: capture.version })
      if (result) { setOpen(false); toast(`Saved "${name.trim()}" to ${labelFor(choice.category) === 'Composition' || choice.category === 'motion' ? 'Library' : `${labelFor(choice.category)}s`}`) }
      else setError('The selection could not be saved. Review the error and choose another source.')
    } catch (error) { setError(error.message) }
    finally { setBusy(false) }
  }
  return html`
    <div class="reel-library-save">
      ${open ? html`
        <form class="reel-library-form" onSubmit=${save} onKeyDown=${e => e.stopPropagation()}>
          <label>Save as<select value=${choice ? `${choice.category}:${JSON.stringify(choice.source)}` : ''} disabled=${busy || !status.ok} onChange=${e => { const current = librarySourceStatus(store.project, capture, scope()); if (!current.ok) { setError(current.reason); return } const next = savedChoices.find(option => `${option.category}:${JSON.stringify(option.source)}` === e.target.value); if (!next) return; setCapture(captureLibrarySource(store.project, next, scope())); setName(next.name ?? ''); setEffectIndex('-1'); setError('') }}>${savedChoices.map(option => html`<option value=${`${option.category}:${JSON.stringify(option.source)}`}>${option.label}</option>`)}</select></label>
          ${choice?.category === 'effect' && !compositionEffect && clip?.effects?.length ? html`<label>Component<select value=${effectIndex} disabled=${busy} onChange=${e => setEffectIndex(e.target.value)}><option value="-1">All effects and color nodes</option>${clip.effects.map((effect, index) => html`<option value=${index}>${index + 1}. ${effect.type}</option>`)}</select></label>` : null}
          <label>Name<input value=${name} maxLength="120" required disabled=${busy} onInput=${e => setName(e.target.value)} /></label>
          <label>Description<textarea rows="2" maxLength="2000" value=${description} disabled=${busy} onInput=${e => setDescription(e.target.value)} /></label>
          <p class="reel-library-note">Save an editable copy in this project. The current layers stay in place.</p>
          <p class="reel-library-note">Source ${choice?.name ?? ''} · ${choice?.source.clip ?? choice?.source.composition ?? ''}</p>
          ${!status.ok ? html`<p class="reel-library-error" role="alert">${status.reason}</p><button type="button" class="ghost" disabled=${busy} onClick=${() => refresh()}>Refresh source selection</button>` : null}
          ${error ? html`<p class="reel-library-error" role="alert">${error}</p>` : null}
          ${!choice ? html`<p class="reel-library-note">Select a compatible source to save.</p>` : null}
          <div class="reel-library-actions"><button type="button" class="ghost" disabled=${busy} onClick=${() => setOpen(false)}>Cancel</button><button type="submit" class="primary" disabled=${busy || pendingEdit || !status.ok || !choice || !name.trim()}>${busy ? 'Saving…' : 'Save component'}</button></div>
        </form>` : html`
        <button type="button" class="ghost reel-library-save-button" disabled=${!choices.length || pendingEdit} onClick=${begin}>${recovery ? 'Project sync required' : pendingEdit ? 'Saving your edit…' : `Save ${category ? labelFor(category).toLowerCase() : 'selection'} to library`}</button>
        ${pendingEdit && !recovery ? html`<p class="reel-library-note" role="status">Wait for the current edit to finish before saving a component.</p>` : null}
        ${!choices.length ? html`<p class="reel-library-note">${category === 'title' ? 'Select a title or open a title composition to save it.' : category === 'transition' ? 'Select an incoming transition, or open a composition to save it as a transition.' : category === 'effect' ? 'Select a clip with effects or color nodes to save them.' : s.selection.length > 1 ? 'Select one component to save, or open its composition.' : 'Select a title, effect, transition or animated layer, or open a composition.'}</p>` : null}`}
      ${recovery ? html`<p class="reel-library-error" role="alert">${recovery.reason}</p><button type="button" class="ghost" disabled=${!recovery.canRetry} onClick=${() => retryEditRecovery()}>${recovery.retrying ? 'Syncing project…' : 'Retry project sync'}</button>` : null}
    </div>`
}

export function LibraryItem({ item }) {
  const s = useStore()
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(item.name)
  const [description, setDescription] = useState(item.description ?? '')
  const [busy, setBusy] = useState(false)
  const opened = useRef(null)
  const root = s.root
  const version = s.version
  const targets = [...s.selection]
  const composition = s.openComp
  const previousScope = useRef({ root, id: item.id })
  useEffect(() => {
    if (previousScope.current.root !== root || previousScope.current.id !== item.id) {
      setRenaming(false); setName(item.name); setDescription(item.description ?? ''); opened.current = null
      previousScope.current = { root, id: item.id }
    }
  }, [root, item.id])
  const facts = libraryItemFacts(item)
  const plan = libraryApplyPlan(s.project, item, s.selection, { start: time.t, comp: s.openComp })
  const detail = item.description || describeLibraryItem(item)
  const placement = libraryPlacesObject(item)
  const apply = async () => {
    if (root !== store.root) return toast('The open project changed. Choose its saved component again.', 'error')
    if (version !== store.version || composition !== store.openComp || !placement && JSON.stringify([...targets].sort()) !== JSON.stringify([...store.selection].sort())) return toast('The project or target selection changed. Choose the component again before applying it.', 'error')
    const current = libraryApplyPlan(store.project, item, targets, { start: time.t, comp: composition })
    if (!current.ok) return toast(current.reason, 'error')
    setBusy(true)
    try {
      const assertCurrent = () => {
        if (root !== store.root || version !== store.version || composition !== store.openComp ||
            !placement && JSON.stringify([...targets].sort()) !== JSON.stringify([...store.selection].sort())) throw new Error('The project or target selection changed. Choose the component again before applying it.')
      }
      const prepared = await prepareLibraryOps(store.project, current.ops, path => api('/api/luts/inspect', { path }), assertCurrent)
      assertCurrent()
      const result = await edit(prepared.ops, `${placement ? 'place' : 'apply'} library component "${item.name}"`, { expectedVersion: version })
      if (result) {
        const created = result.created?.filter(id => /^c\d+$/.test(id))
        if (placement && created?.length) set({ selection: [created.at(-1)] })
        toast(`${placement ? 'Placed' : 'Applied'} "${item.name}"`)
      }
    } catch (error) { toast(error.message, 'error') }
    finally { setBusy(false) }
  }
  const rename = async e => {
    e.preventDefault()
    if (!manageCurrent()) return
    setBusy(true)
    const result = await edit({ op: 'library_rename', item: item.id, name: name.trim(), description: description.trim() }, `rename library component "${item.name}"`, { expectedVersion: opened.current.version })
    setBusy(false)
    if (result) setRenaming(false)
  }
  const remove = async () => {
    if (!manageCurrent()) return
    setBusy(true)
    const result = await edit({ op: 'library_remove', item: item.id }, `remove "${item.name}" from the project library`, { expectedVersion: opened.current.version })
    setBusy(false)
    if (result) toast(`Removed "${item.name}" from the library. Placed copies stay in the project.`)
  }
  const manageCurrent = () => {
    const snapshot = opened.current
    const current = store.project.library?.items?.find(candidate => candidate.id === item.id)
    if (!snapshot || snapshot.root !== store.root || snapshot.version !== store.version || JSON.stringify(snapshot.item) !== JSON.stringify(current)) {
      setRenaming(false)
      toast('This component or the open project changed. Reopen its controls before editing.', 'error')
      return false
    }
    return true
  }
  return html`
    <article class="reel-library-item" data-library-item=${item.id}>
      <div class="reel-library-item-head"><b>${item.name}</b><span class="reel-library-kind">${labelFor(item.category)}</span></div>
      ${facts.text ? html`<div class="reel-library-text" aria-label="Text sample">${facts.text}</div>` : null}
      <p class="reel-library-description">${detail}</p>
      <p class="reel-library-facts">${facts.details}</p>
      <div class="reel-library-actions"><button type="button" disabled=${busy || !plan.ok} title=${plan.ok ? placement ? 'Place an editable copy at the playhead' : item.category === 'transition' ? 'Apply at the incoming cuts of the selected compatible clips' : 'Apply to the selected compatible clips' : plan.reason} onClick=${apply}>${busy ? 'Working…' : placement ? 'Place at playhead' : item.category === 'transition' ? 'Apply to selected cuts' : 'Apply to selection'}</button><button type="button" class="ghost" aria-expanded=${renaming} onClick=${() => { opened.current = { root: store.root, version: store.version, item: structuredClone(item) }; setName(item.name); setDescription(item.description ?? ''); setRenaming(!renaming) }}>Manage</button></div>
      ${!plan.ok ? html`<p class="reel-library-note">${plan.reason}</p>` : null}
      ${renaming ? html`<form class="reel-library-form reel-library-manage" onSubmit=${rename} onKeyDown=${e => e.stopPropagation()}>
        <label>Name<input value=${name} maxLength="120" required disabled=${busy} onInput=${e => setName(e.target.value)} /></label>
        <label>Description<textarea rows="2" maxLength="2000" value=${description} disabled=${busy} onInput=${e => setDescription(e.target.value)} /></label>
        <div class="reel-library-actions"><button type="button" class="ghost danger" disabled=${busy} title="Remove the saved component. Existing copies stay in the project." onClick=${remove}>Remove</button><span class="grow"></span><button type="button" class="ghost" disabled=${busy} onClick=${() => setRenaming(false)}>Cancel</button><button type="submit" disabled=${busy || !name.trim()}>Save name</button></div>
      </form>` : null}
    </article>`
}

export function SavedLibrarySection({ category }) {
  const s = useStore()
  useEffect(installLibraryStyle, [])
  const items = (s.project?.library?.items ?? []).filter(item => item.category === category)
  return html`
    <section class="reel-library" aria-label=${`Saved ${labelFor(category).toLowerCase()}s`}>
      <div class="reel-library-heading"><h4>Saved in this project</h4><span class="reel-library-count">${items.length}</span></div>
      <${SaveLibrarySelection} category=${category} />
      ${items.length ? html`<div class="reel-library-items">${items.map(item => html`<${LibraryItem} key=${item.id} item=${item} />`)}</div>` : html`<p class="reel-library-note">Saved components appear here for reuse. Agents can create them through project operations.</p>`}
    </section>`
}

export function LibraryTab() {
  const s = useStore()
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  useEffect(installLibraryStyle, [])
  const items = (s.project?.library?.items ?? []).filter(item => (filter === 'all' || item.category === filter) && `${item.name} ${item.description ?? ''}`.toLowerCase().includes(query.toLowerCase()))
  return html`
    <div class="tab-body reel-library">
      <div class="reel-library-heading"><h4>Project library</h4><span class="reel-library-count">${s.project?.library?.items?.length ?? 0}</span></div>
      <p class="reel-library-note">Reuse editable titles, compositions, effects, transitions and keyframe motion.</p>
      <${SaveLibrarySelection} />
      <div class="reel-library-filters"><label class="reel-library-sr-only" for="reel-library-filter">Component type</label><select id="reel-library-filter" value=${filter} onChange=${e => setFilter(e.target.value)}><option value="all">All types</option>${LIBRARY_CATEGORIES.map(([id, label]) => html`<option value=${id}>${label}</option>`)}</select><label class="reel-library-sr-only" for="reel-library-search">Search saved components</label><input id="reel-library-search" type="search" placeholder="Search library" value=${query} onInput=${e => setQuery(e.target.value)} onKeyDown=${e => e.stopPropagation()} /></div>
      ${items.length ? html`<div class="reel-library-items">${items.map(item => html`<${LibraryItem} key=${item.id} item=${item} />`)}</div>` : html`<p class="reel-library-empty">${query || filter !== 'all' ? 'No saved components match. Change the type or search.' : 'Save a selected component to use it again. Titles, transitions and effects also appear in their browser sections.'}</p>`}
    </div>`
}

export function LibraryInspector({ clip }) {
  useEffect(installLibraryStyle, [])
  const animated = Object.entries(clip.anim ?? {}).filter(([, keys]) => keys?.length)
  return html`<div class="section-body reel-library"><${SaveLibrarySelection} /><${AnimateSelection} clip=${clip} />${animated.length ? html`<div class="reel-library-heading"><h4>Editable keyframes</h4></div>${animated.map(([property, keys]) => html`<div class="kv"><span>${property}</span><b>${keys.length} keys</b></div>`)}<button type="button" class="ghost" onClick=${() => set({ page: 'motion', inspectorTab: 'motion' })}>Inspect on Motion page</button>` : null}</div>`
}

registerBrowserTab({ id: 'library', label: 'Library', order: 65, component: LibraryTab })
for (const [tab, category] of [['titles', 'title'], ['transitions', 'transition'], ['effects', 'effect']]) registerBrowserSection({ id: `saved-${category}`, tab, order: 10, component: () => html`<${SavedLibrarySection} category=${category} />` })
registerInspector({ id: 'library', label: 'Library', order: 65, component: LibraryInspector })
registerInspectorAction({ id: 'animate-selection', order: 10, when: clip => clip.kind !== 'audio', component: props => html`<${AnimateSelection} ...${props} compact=${true} />` })
registerClipMenu((project, hit) => {
  const root = store.root
  const version = store.version
  const sourceProject = store.project
  const composition = store.openComp
  const clip = hit.clip
  if (!clip || clip.kind === 'audio') return []
  return [
    store.caps?.host === 'browser-local' ? null : { label: 'Ask AI to animate selected layers', run: () => { if (root !== store.root || version !== store.version || sourceProject !== store.project || composition !== store.openComp) return toast('The project changed. Select its current layers.', 'error'); const reference = attachMotionIntent(sourceProject, [clip.id], composition, 'Animate this selected editable layer. Choose restrained timing and motion that fit the composition. Preserve its geometry, hierarchy and font, and use editable keyframes.', root, version); if (reference) set({ selection: [clip.id], inspectorTab: 'library' }) } },
    { label: 'Save component to library', run: () => root === store.root ? set({ selection: [clip.id], inspectorTab: 'library', browserTab: 'library' }) : toast('The open project changed. Select its current component.', 'error') },
  ]
})
