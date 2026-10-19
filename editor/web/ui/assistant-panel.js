// Parts of the assistant panel: what the next request will see, suggestions for it, the
// preview of a proposed change and the one-step undo of the latest assistant change.

import { h } from 'preact'
import htm from 'htm'
import { applyOps, clipEnd, timecode } from '../../core/project.js'
import { clipName } from '../../core/describe.js'
import { changeReceipt } from './change-receipt.js'
import { assistantSuggestions } from './assistant-suggestions.js'

const html = htm.bind(h)
const MAX_LAYERS = 6
const MAX_PROPERTIES = 4

/** The open timeline, playhead timecode and the layers under the playhead, top first. */
function focus(project, { comp = null, playhead = 0 } = {}) {
  if (!project) return { scope: 'No project', time: '', under: [] }
  const scope = comp && Object.hasOwn(project.comps ?? {}, comp) ? project.comps[comp] : project
  const fps = scope.fps ?? project.fps ?? 30
  const t = Number.isFinite(playhead) ? playhead : null
  const tracks = scope.tracks ?? []
  const ordered = [...tracks.filter(track => track.kind === 'video').reverse(), ...tracks.filter(track => track.kind !== 'video')]
  const under = t == null ? [] : ordered.flatMap(track => (track.clips ?? []).filter(clip => clip.start <= t && clipEnd(clip) > t && clip.kind !== 'audio').map(clip => clipName(project, clip)))
  return { scope: scope === project ? 'Main timeline' : scope.name ?? comp, time: t == null ? 'unavailable' : timecode(t, fps), under: [...new Set(under)] }
}

/** The changes a preview would make, from the shared edit model and the receipt builder. */
function previewChanges(project, proposal) {
  if (!project || !proposal?.ops?.length && !proposal?.steps?.length) return { error: 'This preview has no edits.' }
  if (!proposal.ops?.length) return { layers: [], settings: [] }
  try {
    const imports = Object.fromEntries(Object.entries(proposal.assets ?? {}).filter(([src]) => !project.assets?.[src]))
    const next = applyOps(project, Object.keys(imports).length ? [{ op: 'import', assets: imports }, ...proposal.ops] : proposal.ops).project
    const receipt = changeReceipt(project, next, { version: proposal.baseVersion + 1, who: 'agent', at: proposal.at })
    if (!receipt) return { error: 'These edits would not change the project.' }
    // Name layers as the timeline does, and list new nested values one property at a time.
    const names = new Map()
    for (const p of [project, next]) for (const scope of [p, ...Object.values(p.comps ?? {})]) for (const track of scope.tracks ?? []) for (const clip of track.clips ?? []) names.set(clip.id, clipName(next, clip))
    const layers = receipt.clips.map(layer => ({ ...layer, name: names.get(layer.id) ?? layer.name, changes: layer.changes.flatMap(expand) }))
    // A clip added to or removed from a track also reorders it; the layer row already says so.
    const settings = receipt.scopes.filter(scope => scope.changes.some(change => change.property !== 'Object order'))
    return { receipt, layers, settings }
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
}

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/** A new object value becomes one row per property, so "grade" reads as its settings. */
function expand(change) {
  if (change.before !== 'Absent' || !change.after.startsWith('{')) return [change]
  try {
    const value = JSON.parse(change.after)
    return Object.entries(value).map(([key, item]) => ({ property: `${change.property}.${key}`, before: 'Absent', after: JSON.stringify(item) }))
  } catch { return [change] }
}
const STATUS = { added: 'New', deleted: 'Removed', changed: 'Changed' }

function PreviewCard({ proposal, project, version, running, newRequest, busy, onApply, onDiscard }) {
  const stale = proposal.stale || proposal.baseVersion !== version
  const { receipt, error, layers = [], settings = [] } = stale ? {} : previewChanges(project, proposal)
  const steps = proposal.steps ?? []
  const headline = [receipt?.total ? `changes ${plural(receipt.total, 'layer')}` : '', settings.length ? `changes ${plural(settings.length, 'setting group')}` : '', steps.length ? `runs ${plural(steps.length, 'processing step')}` : ''].filter(Boolean).join(', ')
  return html`<section class="assistant-preview" aria-label="Preview of proposed changes">
    <header><span class="assistant-card-label">Preview</span><b>${proposal.summary || plural(proposal.ops.length, 'edit')}</b></header>
    ${proposal.replaced ? html`<p class="assistant-preview-note">Replaces the earlier preview: ${proposal.replaced}.</p>` : null}
    ${newRequest && !stale ? html`<p class="assistant-preview-note" role="status">The assistant is working on a new request. This preview stays until that request makes its own.</p>` : null}
    ${stale ? html`<p class="assistant-preview-note" role="status">The project changed after this preview. Ask again for a current one.</p>`
      : error ? html`<p class="assistant-preview-note" role="alert">This preview cannot be applied: ${error}</p>`
      : html`<p class="assistant-preview-note">Apply ${headline}. Nothing has changed yet${steps.length ? ' and nothing renders until you apply' : ''}.</p>`}
    ${layers.length ? html`<ul class="assistant-preview-list">${layers.slice(0, MAX_LAYERS).map(layer => html`<li key=${`${layer.comp}:${layer.id}`}>
      <div><b>${layer.name}</b><span class=${`assistant-preview-status ${layer.status}`}>${STATUS[layer.status] ?? layer.status}</span><small>${layer.compositionName} · ${layer.id}</small></div>
      ${layer.status === 'changed' ? html`<dl>${layer.changes.slice(0, MAX_PROPERTIES).map(change => html`<dt>${change.property}</dt><dd><span>${change.before}</span><span aria-label="changes to"> → </span><span>${change.after}</span></dd>`)}</dl>` : null}
      ${layer.status === 'changed' && layer.changes.length > MAX_PROPERTIES ? html`<small>${plural(layer.changes.length - MAX_PROPERTIES, 'more property', 'more properties')}</small>` : null}
    </li>`)}</ul>` : null}
    ${layers.length > MAX_LAYERS ? html`<p class="assistant-preview-note">${plural(layers.length - MAX_LAYERS, 'more layer')} change.</p>` : null}
    ${settings.length && !stale ? html`<p class="assistant-preview-note">Settings: ${settings.slice(0, 4).map(scope => scope.name).join(', ')}${settings.length > 4 ? ', …' : ''}</p>` : null}
    ${steps.length && !stale ? html`<ol class="assistant-preview-steps" aria-label="Processing steps">${steps.map((step, index) => html`<li key=${index}>
      <b>${step.preview?.title ?? step.path}</b>
      <p><span class="assistant-preview-step-label">Produces</span> ${step.preview?.produces ?? ''}</p>
      <p><span class="assistant-preview-step-label">Lands</span> ${step.preview?.lands ?? ''}</p>
    </li>`)}</ol>` : null}
    <div class="assistant-preview-actions">
      <button class="assistant-apply" disabled=${Boolean(stale || error || running || busy)} title=${running ? 'Wait for the assistant to finish' : 'Apply these edits as one undo step'} onClick=${onApply}>${busy === 'apply' ? 'Applying…' : 'Apply'}</button>
      <button class="ghost" disabled=${Boolean(busy)} onClick=${onDiscard}>Discard</button>
    </div>
  </section>`
}

/** A preview being applied: which step is running, or why it stopped. */
function ApplyingCard({ applying, onDismiss }) {
  if (!applying) return null
  const step = applying.index >= 0 ? `Step ${applying.index + 1} of ${applying.total}: ${applying.title}` : 'Applying the edits'
  return html`<section class=${`assistant-applying ${applying.error ? 'failed' : ''}`} aria-label="Applying the preview" aria-busy=${!applying.finished}>
    <header><span class="assistant-card-label">${applying.error ? 'Preview stopped' : 'Applying the preview'}</span><b>${applying.summary || 'Assistant preview'}</b></header>
    ${applying.error ? html`<p role="alert">${applying.error}</p><p class="assistant-preview-note">Edits made before the failure stay in the project. Use Undo this change to remove them together.</p>
      <div class="assistant-preview-actions"><button class="ghost" onClick=${onDismiss}>Dismiss</button></div>`
      : html`<p role="status">${step}</p><p class="assistant-preview-note">Rendering runs in Arya. Wait for it to finish before editing: a change to the project now stops this step before its result lands.</p>`}
  </section>`
}

function ChangeBar({ change, busy, onUndo }) {
  if (!change?.undoable) return null
  return html`<div class="assistant-change" role="status">
    <span>${change.kind === 'preview' ? 'Applied the assistant preview.' : `The last request made ${plural(change.edits, 'edit')}.`}</span>
    <button class="ghost" disabled=${Boolean(busy)} title="Restore the project from before this assistant change. Undo restores it again." onClick=${onUndo}>${busy === 'undo' ? 'Undoing…' : 'Undo this change'}</button>
  </div>`
}

export const assistantPanel = { focus, suggestions: assistantSuggestions, previewChanges, PreviewCard, ApplyingCard, ChangeBar }
