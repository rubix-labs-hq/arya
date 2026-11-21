// Context menu targets describe the item under the pointer, even when another clip is selected.
import { timecode } from '/core/project.js'
import { shownClipName } from './clip-name.js'
import { mediaDisplayName } from './media-label.js'
import { openMenu } from './menu.js'
import { addRef, set, store, time, toast, viewProject } from './store.js'

const audio = ['Normalize this clip to -14 LUFS.', 'Add a 0.8-second fade in and a 1.2-second fade out.', 'Reduce low-end rumble and lift vocal presence with EQ.']
const prompts = {
  video: ['Grade this shot with subtle contrast and warmer highlights.', 'Add an eased push-in from 100% to 108%.', 'Fade this shot in and out smoothly.'],
  image: ['Fit this image to the canvas.', 'Add a slow push-in to this still.', 'Fade this image in over half a second.'],
  title: ['Animate this title in and out with editable keys.', 'Improve title readability with tracking and shadow.', 'Add a thin amber rule beneath this title.'],
  shape: ['Ease this shape into position.', 'Add a contrasting stroke.', 'Animate the opacity over the first half second.'],
  audio, adjustment: ['Add gentle contrast to this adjustment layer.', 'Warm the underlying shots.', 'Ease the adjustment layer’s opacity in and out.'],
  comp: ['Stagger entrances inside this composition.', 'Add a slow push-in.', 'Fade out this composition over its final second.'],
  caption: ['Shorten this caption without changing its meaning.', 'Split this cue at a phrase break.', 'Check the timing against the dialogue.'],
  color: ['Change this solid to a warm charcoal.', 'Fade this solid into the next shot.', 'Place a centered title over this background.'],
  grade: ['Warm the highlights on this node.', 'Add a gentle S-curve to this grade.', 'Reduce saturation slightly while preserving contrast.'],
  motion: ['Ease the keyframes on this layer.', 'Slow down its entrance.', 'Add a pair of editable keys for the attached property.'],
  bus: ['Lower this bus by 3 dB.', 'Review the tracks routed to this bus.', 'Check headroom and suggest a gain adjustment.'],
  deliver: ['Check these export dimensions against the timeline.', 'Suggest a smaller preset for a review copy.', 'Check the export range before rendering.'],
  frame: ['Add a title at this moment.', 'Split the video clip under this frame.', 'Mark this frame with a descriptive label.'],
  videoTrack: ['Close gaps on this track.', 'Add a dissolve between adjacent shots.', 'Fade out the last shot on this track.'],
  audioTrack: ['Lower this track by 3 dB.', 'Center this track’s pan.', 'Add short fades to the audio clips on this track.'],
  captionTrack: ['Check these cues for overlaps.', 'Break long captions into shorter cues.', 'Tidy punctuation while keeping cue timing.'],
  videoMedia: ['Insert this video at the playhead and fit the canvas.', 'Place an opening title over this source.', 'Mark scene cuts in this source.'],
  imageMedia: ['Insert this still for four seconds.', 'Use this image behind an opening title.', 'Create a slow push-in on this still.'],
  audioMedia: ['Insert this audio at the playhead.', 'Place it beneath the picture with a soft fade in.', 'Measure this source’s integrated loudness.'],
  musicMedia: ['Place this cue at the playhead.', 'Fade this cue under the ending.', 'Build a shorter variation from its saved score.'],
}

export function clipTarget(clip, kind = 'clip', details = {}) {
  if (!clip) return frameTarget()
  const name = shownClipName(store.project, clip)
  return { kind, object: clip.id, label: kind === 'clip' ? name : `${kind} · ${name}`, type: kind === 'clip' ? clip.kind : kind, details }
}

export function selectedTarget(kind, details) {
  const clip = viewProject()?.tracks.flatMap(t => t.clips).find(c => c.id === store.selection[0])
  return clipTarget(clip, kind, details)
}

export function frameTarget(at = time.t) {
  return { kind: 'frame', object: String(at), label: `Frame ${timecode(at, viewProject()?.fps ?? 30)}`, type: 'frame', details: { time: at, selectedClip: store.selection[0] ?? null } }
}

export function mediaTarget(src, asset) {
  const type = asset?.generated?.kind === 'original-music' ? 'music' : asset?.still ? 'image' : asset?.hasVideo ? 'video' : 'audio'
  return { kind: 'media', object: src, label: mediaDisplayName(src, asset), type: type + 'Media' }
}

export function trackTarget(track) {
  return { kind: 'track', object: track.id, label: track.name || track.id, type: track.kind + 'Track' }
}

export function contextItems(target) {
  const { root, version, project, openComp } = store
  const details = target.details ?? {}
  const ref = { kind: 'editor_target', id: JSON.stringify([target.kind, openComp ?? null, target.object, details]), label: target.label.slice(0, 160),
    context: { kind: target.kind, object: target.object, composition: openComp ?? null, type: target.type, ...details, sourceProjectVersion: version } }
  const attach = suggestion => {
    if (root !== store.root || version !== store.version || project !== store.project || openComp !== store.openComp) return toast('The project changed. Open the item’s menu again.', 'error')
    const next = [...store.refs.filter(r => r.kind !== ref.kind || r.id !== ref.id), ref]
    if (next.length > 16 || ref.id.length > 2048 || new TextEncoder().encode(JSON.stringify(next)).length > 64000) return toast('Remove an attachment to make room for this reference.', 'error')
    addRef(ref)
    set({ assistantContextRequest: { root, suggestion } })
  }
  return [
    { label: 'Add to Ask Arya', run: () => attach(null) },
    { label: 'Ask Arya', sub: (prompts[target.type] ?? prompts.video).map(label => ({ label, run: () => attach(label) })) },
  ]
}

export function showContext(event, target, actions = []) {
  if (event.defaultPrevented || event.target.closest?.('textarea, input:not([type=range]), [contenteditable=true]')) return
  event.preventDefault()
  event.stopPropagation()
  openMenu(event.clientX, event.clientY, [...contextItems(target), ...(actions.length ? [{ sep: true }, ...actions] : [])])
}
