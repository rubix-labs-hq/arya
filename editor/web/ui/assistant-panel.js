// Parts of the assistant panel: what the next request will see, suggestions for it, the
// preview of a proposed change and the one-step undo of the latest assistant change.

import { h } from 'preact'
import htm from 'htm'
import { applyOps, clipEnd, timecode } from '../../core/project.js'
import { clipName } from '../../core/describe.js'
import { editNotes } from '../../core/edit-notes.js'
import { changeReceipt } from './change-receipt.js'
import { assistantSuggestions } from './assistant-suggestions.js'
import { messageHTML } from './message-text.js'
import { changeKinds, clock, readableChange, settingsSummary, splitChanges } from './change-values.js'
import { proposalOps } from '../../core/proposal-ops.js'

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
    const ops = proposalOps(project, proposal)
    const applied = applyOps(project, ops), next = applied.project
    const receipt = changeReceipt(project, next, { version: proposal.baseVersion + 1, who: 'agent', at: proposal.at })
    if (!receipt) return { error: 'These edits would not change the project.' }
    // Name layers as the timeline does, and list new nested values one property at a time.
    // A linked video clip and its audio share a name, so each row also says which kind of track it is on.
    const names = new Map(), places = new Map()
    for (const p of [project, next]) for (const scope of [p, ...Object.values(p.comps ?? {})]) for (const track of scope.tracks ?? []) for (const clip of track.clips ?? []) { names.set(clip.id, layerName(next, clip, track)); places.set(clip.id, `${track.id} at ${clock(clip.start)}`) }
    const layers = receipt.clips.map(layer => ({ ...layer, name: names.get(layer.id) ?? layer.name, track: places.get(layer.id) ?? '', changes: splitChanges(layer.changes) }))
    // A clip added to or removed from a track also reorders it; the layer row already says so.
    const settings = receipt.scopes.filter(scope => scope.changes.some(change => change.property !== 'Object order')).map(scope => scope.changes.filter(change => change.property !== 'Object order').every(change => change.property === 'duration') ? { ...scope, name: 'Timeline length' } : scope)
    // The same notes the editor shows under a committed edit: overlaps, shortened text, fonts and the like.
    const notes = editNotes(project, next, { ops, created: applied.created ?? [], audience: 'person' })
    return { receipt, layers, settings, notes }
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
}

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/** A clip's name as the timeline draws it. The sound of a linked video clip says so, so the two rows differ. */
function layerName(project, clip, track) {
  const name = clipName(project, clip)
  return track?.kind === 'audio' && project?.assets?.[clip.src]?.hasVideo ? `${name} audio` : name
}

/** Where a receipt layer is now: its name, and "V3 at 0:01" from the live project, or the time alone once it is gone. */
function layerPlace(project, layer) {
  const scope = layer.comp == null ? project : Object.hasOwn(project?.comps ?? {}, layer.comp) ? project.comps[layer.comp] : null
  for (const track of scope?.tracks ?? []) for (const clip of track.clips ?? []) {
    if (clip.id === layer.id) return { name: layerName(project, clip, track), place: `${track.id} at ${clock(clip.start)}` }
  }
  return { name: layer.name, place: Number.isFinite(layer.start) ? `at ${clock(layer.start)}` : '' }
}

const STATUS = { added: 'New', deleted: 'Removed', changed: 'Changed' }
const MAX_KEYS = 4

/** The frame rate of the timeline a layer or settings group belongs to. */
const fpsOf = (project, comp) => (comp != null && Object.hasOwn(project?.comps ?? {}, comp) ? project.comps[comp].fps : null) ?? project?.fps ?? 30

function Value({ text, swatch }) {
  return html`<span>${swatch ? html`<i class="change-swatch" style=${{ background: swatch }} aria-hidden="true"></i>` : null}${text}</span>`
}

/** Receipt changes as words: seconds with timecode, one line per keyframe, colours with a swatch. */
function ChangeList({ changes = [], fps = 30, keyLimit = Infinity }) {
  return html`<dl class="change-list">${splitChanges(changes).map(change => {
    const row = readableChange(change, { fps })
    const arrow = html`<span class="receipt-arrow" aria-label="changed to">→</span>`
    if (row.only) return html`<dt>${row.label}</dt><dd><span>${row.only}</span></dd>`
    if (row.keys) {
      const shown = row.keys.slice(0, keyLimit)
      return html`<dt>${row.label}</dt><dd><ul class="change-keys" title="Times are seconds into the layer">${shown.map(key => html`<li>
        <span class="change-key-time">${key.time}</span> ${key.status === 'added' ? html`<span>Added ${key.after}</span>` : key.status === 'removed' ? html`<span>Removed ${key.before}</span>` : html`<span>${key.before}</span>${arrow}<span>${key.after}</span>`}
      </li>`)}${row.keys.length > shown.length ? html`<li>${plural(row.keys.length - shown.length, 'more keyframe')}</li>` : null}${row.keys.length ? null : html`<li>No keyframes changed</li>`}</ul></dd>`
    }
    return html`<dt>${row.label}</dt><dd class="change-pair">${Value({ text: row.before, swatch: row.swatches?.[0] })}<span class="change-to">${arrow}${Value({ text: row.after, swatch: row.swatches?.[1] })}</span></dd>`
  })}</dl>`
}

function PreviewCard({ proposal, project, version, running, newRequest, busy, shown = false, onShow, onApply, onDiscard }) {
  const stale = proposal.stale || proposal.baseVersion !== version
  const { receipt, error, layers = [], settings = [], notes = [] } = stale ? {} : previewChanges(project, proposal)
  const steps = proposal.steps ?? []
  const changed = [receipt?.total ? plural(receipt.total, 'layer') : '', settings.length ? plural(settings.length, 'setting group') : ''].filter(Boolean).join(' and ')
  const run = steps.length ? `run ${plural(steps.length, 'processing step')}` : ''
  const headline = changed ? `Apply changes to ${changed}${run ? ` and ${run}` : ''}` : run ? `Apply to ${run}` : 'Apply these edits'
  return html`<section class="assistant-preview" aria-label="Preview of proposed changes">
    <header><span class="assistant-card-label">Preview</span><b>${proposal.summary || plural(proposal.ops.length, 'edit')}</b></header>
    ${proposal.replaced ? html`<p class="assistant-preview-note">Replaces the earlier preview: ${proposal.replaced}.</p>` : null}
    ${newRequest && !stale ? html`<p class="assistant-preview-note" role="status">The assistant is working on a new request. This preview stays until that request makes its own.</p>` : null}
    ${stale ? html`<p class="assistant-preview-note" role="status">The project changed after this preview. Ask again for a current one.</p>`
      : error ? html`<p class="assistant-preview-note" role="alert">This preview cannot be applied: ${error}</p>`
      : html`<p class="assistant-preview-note" role="status">${headline}. Nothing has changed yet${steps.length ? ' and nothing renders until you apply' : ''}.</p>`}
    ${layers.length ? html`<ul class="assistant-preview-list">${layers.slice(0, MAX_LAYERS).map(layer => html`<li key=${`${layer.comp}:${layer.id}`}>
      <div><b>${layer.name}</b><span class=${`assistant-preview-status ${layer.status}`}>${STATUS[layer.status] ?? layer.status}</span><small title=${layer.id}>${layer.comp == null ? '' : `${layer.compositionName} · `}${layer.track || `at ${clock(layer.start)}`}</small></div>
      ${layer.status === 'changed' ? ChangeList({ changes: layer.changes.slice(0, MAX_PROPERTIES), fps: fpsOf(project, layer.comp), keyLimit: MAX_KEYS }) : null}
      ${layer.status === 'changed' && layer.changes.length > MAX_PROPERTIES ? html`<small>${plural(layer.changes.length - MAX_PROPERTIES, 'more property', 'more properties')}</small>` : null}
    </li>`)}</ul>` : null}
    ${layers.length > MAX_LAYERS ? html`<p class="assistant-preview-note">${plural(layers.length - MAX_LAYERS, 'more layer')} change.</p>` : null}
    ${settings.length && !stale ? html`<p class="assistant-preview-note">Settings: ${settingsSummary(settings)}</p>` : null}
    ${notes.map(note => html`<p class="assistant-note">${note}</p>`)}
    ${receipt && !stale ? html`<details class="assistant-preview-details"><summary>Show all changes</summary>
      ${[...receipt.scopes, ...layers].map(item => html`<div class="receipt-layer">
        <b title=${item.id ?? undefined}>${String(item.name).replace(/^Track /, '')}</b><span class="receipt-meta">${[item.track && item.id ? item.track : '', STATUS[item.status] ?? item.status].filter(Boolean).join(' · ')}</span>
        ${ChangeList({ changes: item.changes, fps: fpsOf(project, item.comp) })}
      </div>`)}
      ${receipt.truncated ? html`<p class="assistant-preview-note">Some changes or values in this receipt are shortened.</p>` : null}
    </details>` : null}
    ${steps.length && !stale ? html`<ol class="assistant-preview-steps" aria-label="Processing steps">${steps.map((step, index) => html`<li key=${index}>
      <b>${step.preview?.title ?? step.path}</b>
      <p><span class="assistant-preview-step-label">Produces</span> ${step.preview?.produces ?? ''}</p>
      <p><span class="assistant-preview-step-label">Lands</span> ${step.preview?.lands ?? ''}</p>
    </li>`)}</ol>` : null}
    ${onShow && !stale && !error && proposal.ops?.length ? html`<div class="assistant-preview-show">
      <button class="ghost tiny" aria-pressed=${shown} title=${shown ? 'Show the saved project again' : 'Draw this preview in the viewer and playback. Nothing is saved and editing is off until you apply, discard or go back.'} onClick=${() => onShow(!shown)}>${shown ? 'Back to project' : 'Show in viewer'}</button>
      ${shown ? html`<span class="assistant-preview-note" role="status">The viewer shows this preview.${steps.length ? ' Processing steps are not shown.' : ''}</span>` : null}
    </div>` : null}
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

// The undo bar on its own. The panel folds it into the result card; this stays for hosts that show it alone.
function ChangeBar({ change, busy, onUndo }) {
  if (!change?.undoable) return null
  return html`<div class="assistant-change" role="status">
    <span>${change.kind === 'preview' ? 'Applied the preview' : `Made ${plural(change.edits, 'edit')}`}</span>
    <button class="ghost" disabled=${Boolean(busy)} title="Restore the project from before this assistant change. Undo restores it again." onClick=${onUndo}>${busy === 'undo' ? 'Undoing…' : 'Undo this change'}</button>
  </div>`
}

export const assistantPanel = { layerPlace, layerName, changeKinds, STATUS, focus, suggestions: assistantSuggestions, previewChanges, PreviewCard, ApplyingCard, ChangeBar, messageHTML, ChangeList, fpsOf }
