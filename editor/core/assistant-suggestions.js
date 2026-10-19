// Requests that fit what the editor is looking at: the selection first, then the open timeline
// and its media. Each suggestion is a draft; nothing is sent until the user presses Send.

const VISUAL = new Set(['video', 'image', 'multicam', 'comp'])
const MAX = 4

function scopeOf(project, comp) {
  return comp && Object.hasOwn(project?.comps ?? {}, comp) ? project.comps[comp] : project
}

function clipsOf(scope) {
  return (scope?.tracks ?? []).flatMap(track => (track.clips ?? []).map(clip => ({ clip, track })))
}

function hasSound(project, clip) {
  if (clip.kind === 'audio') return true
  return clip.kind === 'video' && !clip.mute && Boolean(project?.assets?.[clip.src]?.hasAudio)
}

function length(scope) {
  return clipsOf(scope).reduce((end, { clip }) => Math.max(end, clip.start + clip.dur), 0)
}

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/** Up to four { id, label, prompt } suggestions for the current project, selection and timeline. */
export function assistantSuggestions(project, { selection = [], comp = null } = {}) {
  if (!project) return []
  const scope = scopeOf(project, comp)
  const all = clipsOf(scope)
  const ids = new Set(selection.filter(id => !String(id).startsWith('tr:')))
  const chosen = all.filter(({ clip }) => ids.has(clip.id)).map(({ clip }) => clip)
  const out = []
  const add = (id, label, prompt) => { if (out.length < MAX && !out.some(item => item.id === id)) out.push({ id, label, prompt }) }

  if (chosen.length) {
    const shots = chosen.filter(clip => VISUAL.has(clip.kind))
    const titles = chosen.filter(clip => clip.kind === 'title')
    const sound = chosen.filter(clip => hasSound(project, clip))
    if (shots.length >= 2) add('match', 'Grade these to match', `Grade the ${plural(shots.length, 'selected shot')} to match each other. Use the best-exposed shot as the reference and keep every unselected clip unchanged.`)
    else if (shots.length === 1) add('grade-shot', 'Grade this shot', 'Give the selected shot a clean, natural grade: balance exposure and white balance, then add gentle contrast. Leave other clips unchanged.')
    if (titles.length) add('animate-title', titles.length === 1 ? 'Animate this title' : 'Animate these titles', `Animate the ${plural(titles.length, 'selected title')} in and out with smooth, readable motion that fits the edit.`)
    if (sound.some(clip => clip.kind === 'video' || clip.kind === 'audio')) add('silences-selection', 'Cut the silences', `Remove the silent pauses inside the ${plural(sound.length, 'selected clip')}. Keep natural breaths and close the gaps.`)
    if (sound.length) add('clean-audio', 'Clean up the sound', `Make the dialogue in the ${plural(sound.length, 'selected clip')} clear and even: level it near -14 LUFS and reduce background noise.`)
    add('explain-selection', 'Explain the selection', 'Describe the selected clips as an editor would: timing, grade, effects and animation. Do not change anything.')
    return out
  }

  if (!all.length) {
    const media = Object.entries(project.assets ?? {}).filter(([, asset]) => asset?.hasVideo !== false || asset?.hasAudio)
    if (media.length) add('rough-cut', 'Build a rough cut', `Build a rough cut from the ${plural(media.length, 'media file')} in the project: pick the strongest moments, order them into a story and keep it under 60 seconds.`)
    return out
  }

  const shots = all.filter(({ clip }) => VISUAL.has(clip.kind))
  const talking = all.filter(({ clip }) => hasSound(project, clip))
  const longest = Math.max(0, ...Object.values(project.assets ?? {}).map(asset => Number(asset?.duration) || 0), length(scope))
  if (talking.length) add('silences', 'Cut the silences', 'Remove the silent pauses across the timeline. Keep natural breaths, keep linked audio and video in sync and close the gaps.')
  if (longest >= 75 && talking.length) add('shorts', 'Make three 30-second shorts', 'Make three 30-second vertical shorts from the strongest moments in the transcript, each in its own composition with captions.')
  if (shots.length >= 2) add('match-all', 'Grade these to match', `Grade the ${plural(shots.length, 'shot')} on the timeline to match each other, with one consistent look.`)
  if ((scope.width ?? project.width) > (scope.height ?? project.height) && shots.length) add('vertical', 'Make a 9:16 version', 'Make a 9:16 vertical version: a new composition at 1080x1920 with every shot reframed on its subject.')
  if (talking.length && !all.some(({ track }) => track.kind === 'caption')) add('captions', 'Add captions', 'Transcribe the dialogue and add readable captions timed to the words.')
  add('review', 'Review the edit', 'Watch the edit at its cuts and tell me what you would improve. Do not change anything yet.')
  return out
}
