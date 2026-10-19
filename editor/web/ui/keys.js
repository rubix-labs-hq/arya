// Keyboard: Final Cut Pro and DaVinci Resolve defaults where they agree, Resolve
// conventions for delete (Delete lifts, Shift-Delete ripples).

import { clipEnd, compView, duration, snapToFrame, sourceTime } from '/core/project.js'
import { player } from './engine-host.js'
import { api, edit, set, store, time, toast, viewProject } from './store.js'
import { copySelection } from './timeline.js'
import { sourcePlacementPlan } from './source-media.js'

export const SHORTCUTS = [
  ['Space', 'Play / pause'], ['J K L', 'Shuttle reverse / stop / forward (tap again to go faster)'], ['← →', 'Previous / next frame (⇧ one second)'],
  ['↑ ↓', 'Previous / next edit point'], ['Home / End', 'Start / end'], ['I / O', 'Mark in / out'], ['X', 'Mark the clip under the playhead'],
  ['⌥X', 'Clear in and out'], ['A', 'Select tool'], ['B', 'Blade tool'], ['T', 'Trim tool (ripple edges, roll edit points, slip bodies; ⌥ slides)'],
  ['Y', 'Slip tool'], ['U', 'Slide tool'], ['H', 'Hand tool'], ['N', 'Snapping on / off'], ['⌘B', 'Blade at playhead (selected clips, or every track)'],
  ['⌫', 'Delete, leaving a gap'], ['⇧⌫', 'Ripple delete'], ['M', 'Add marker'], ['⌥[ / ⌥]', 'Trim start / end to playhead'],
  [', .', 'Nudge selection one frame (⇧ ten)'], ['V', 'Enable / disable clip'], ['⌘T', 'Add cross dissolve'], ['⌥F', 'Freeze frame'],
  ['F', 'Match frame (open the source at this frame)'], ['E W D Q', 'Append / insert / overwrite / connect the source clip'],
  ['⌘C ⌘X ⌘V', 'Copy / cut / paste at playhead'], ['⌘D', 'Duplicate'], ['⌘A', 'Select all'], ['⌘Z ⇧⌘Z', 'Undo / redo'],
  ['⌘= ⌘-', 'Zoom timeline'], ['⇧Z', 'Zoom to fit'], ['⌘L', 'Loop playback'], ['⇧1 … ⇧6', 'Media, Edit, Motion, Color, Audio, Deliver pages'],
  ['⌘E', 'Export'], ['⌘,', 'Settings'], ['/', 'Talk to the assistant'], ['⌥-click', 'Reference anything to the assistant'], ['?', 'This list'],
]

function sel() {
  return store.selection.filter(id => !id.startsWith('tr:'))
}

function clipsUnderPlayhead(p) {
  return p.tracks.flatMap(t => t.clips.filter(c => c.start < time.t && clipEnd(c) > time.t))
}

const COMMAND_INPUTS = 'input, textarea, select, [contenteditable], [role="dialog"], [role="alertdialog"], dialog'

const KEYBOARD_INPUTS = `${COMMAND_INPUTS}, button, summary, a[href], [role="button"], [role="tab"]`

export function runEditorCommand(command) {
  if (store.settingsOpen || document.activeElement?.closest?.(COMMAND_INPUTS)) return 'input'
  if (['copy', 'cut', 'paste'].includes(command) && window.getSelection?.()?.toString()) return 'input'
  const p = viewProject()
  if (!p) return 'unavailable'
  switch (command) {
    case 'playPause': player.toggle(); break
    case 'previousFrame': player.step(-1); break
    case 'nextFrame': player.step(1); break
    case 'split': {
      const selected = sel()
      const ids = selected.filter(id => {
        const c = p.tracks.flatMap(t => t.clips).find(clip => clip.id === id)
        return c && c.start < time.t && clipEnd(c) > time.t
      })
      if (ids.length) edit(ids.map(id => ({ op: 'blade', at: time.t, id })))
      else if (!selected.length) edit([{ op: 'blade', at: time.t }])
      else toast('Place the playhead inside a selected clip before splitting.')
      break
    }
    case 'delete':
    case 'rippleDelete': {
      const ids = sel()
      const transition = store.selection.find(id => id.startsWith('tr:'))
      if (transition) edit({ op: 'transition', id: transition.slice(3), type: 'none' })
      else if (store.selMarker) {
        edit({ op: 'delete_marker', id: store.selMarker })
        set({ selMarker: null })
      } else if (ids.length) {
        edit({ op: command === 'rippleDelete' ? 'ripple_delete' : 'lift', ids })
        set({ selection: [] })
      } else if (p.range) edit({ op: 'delete_range', from: p.range.in, to: p.range.out, ripple: command === 'rippleDelete' })
      break
    }
    case 'duplicate': if (sel().length) edit(sel().map(id => ({ op: 'duplicate', id }))); break
    case 'export': set({ page: 'deliver' }); break
    case 'copy': copySelection(p); break
    case 'cut':
      copySelection(p)
      if (sel().length) edit({ op: 'ripple_delete', ids: sel() })
      break
    case 'paste':
      if (store.clipboard) edit({ op: 'paste', at: time.t, clips: store.clipboard })
      break
    case 'matchFrame': {
      const c = sel().length ? p.tracks.flatMap(t => t.clips).find(cc => cc.id === sel()[0]) : clipsUnderPlayhead(p).filter(cc => cc.kind === 'video').at(-1)
      if (c?.src) set({ source: { src: c.src, in: c.in, out: (c.in ?? 0) + c.dur * (c.speed ?? 1), t: sourceTime(p, c, time.t) }, viewerMode: 'source' })
      break
    }
    default: return 'unavailable'
  }
  return 'handled'
}

export function installKeys() {
  window.addEventListener('keydown', e => {
    if (e.defaultPrevented) return
    if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); set({ settingsOpen: !store.settingsOpen }); return }
    if (store.settingsOpen) return
    if (e.key === 'Escape' && store.showKeys) { e.preventDefault(); set({ showKeys: false }); return }
    if (e.target.closest?.(KEYBOARD_INPUTS)) return
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
      const target = e.target.closest?.('[tabindex]') ?? e.target
      if (target instanceof Element && !target.closest('.tl-canvas, .node-panel, [role="separator"]')) {
        const style = getComputedStyle(target)
        if ([style.overflowX, style.overflowY].some(value => value === 'auto' || value === 'scroll')) return
      }
    }
    const p = viewProject()
    if (!p) return
    const k = e.key
    const cmd = e.metaKey || e.ctrlKey
    const lower = k.length === 1 ? k.toLowerCase() : k
    let handled = true
    const fps = p.fps

    if (e.shiftKey && !cmd && /^Digit[1-6]$/.test(e.code)) {
      set({ page: ['media', 'edit', 'motion', 'color', 'audio', 'deliver'][Number(e.code.slice(5)) - 1] })
      e.preventDefault()

      return
    }

    if (cmd) {
      switch (lower) {
        case 'z':
          api(e.shiftKey ? '/api/redo' : '/api/undo', {}).then(r => set({ project: r.project, version: r.version }))
          break
        case 'b': {
          runEditorCommand('split')
          break
        }
        case 'c':
          handled = runEditorCommand('copy') === 'handled'
          break
        case 'x':
          handled = runEditorCommand('cut') === 'handled'
          break
        case 'v':
          handled = runEditorCommand('paste') === 'handled'
          break
        case 'd':
          runEditorCommand('duplicate')
          break
        case 'a':
          set({ selection: p.tracks.flatMap(t => t.clips.map(c => c.id)) })
          break
        case 't': {
          const ids = sel().length ? sel() : clipsUnderPlayhead(p).map(c => c.id)
          const targets = ids.length ? ids : p.tracks.flatMap(t => t.clips.filter(c => Math.abs(c.start - time.t) < 0.5 && c.start > 0)).map(c => c.id)
          if (targets.length) edit(targets.map(id => ({ op: 'transition', id, type: 'crossDissolve', dur: 1 })))
          else toast('Select a clip or park the playhead on a cut')
          break
        }
        case '=':
        case '+':
          set({ zoom: Math.min(2400, store.zoom * 1.5) })
          break
        case '-':
          set({ zoom: Math.max(0.5, store.zoom / 1.5) })
          break
        case 'l':
          set({ loop: !store.loop })
          break
        case 'e':
          runEditorCommand('export')
          break
        case 's':
          toast('Arya saves every edit as you make it')
          break
        default:
          handled = false
      }
    } else {
      switch (lower) {
        case ' ':
          runEditorCommand('playPause')
          break
        case 'j':
          player.shuttle(-1)
          break
        case 'k':
          player.shuttle(0)
          break
        case 'l':
          player.shuttle(1)
          break
        case 'ArrowLeft':
          e.shiftKey ? player.seek(Math.max(0, time.t - 1)) : player.step(-1)
          break
        case 'ArrowRight':
          e.shiftKey ? player.seek(time.t + 1) : player.step(1)
          break
        case 'ArrowUp':
        case 'ArrowDown': {
          const pts = [0, duration(p), ...p.markers.map(m => m.t), ...p.tracks.flatMap(t => t.clips.flatMap(c => [c.start, clipEnd(c)]))].sort((a, b) => a - b)
          const target = k === 'ArrowUp' ? pts.filter(x => x < time.t - 1e-3).at(-1) : pts.find(x => x > time.t + 1e-3)
          if (target !== undefined) player.seek(target)
          break
        }
        case 'Home':
          player.seek(0)
          break
        case 'End':
          player.seek(duration(p))
          break
        case 'i':
          edit({ op: 'range', in: time.t, out: Math.max(time.t + 1 / fps, p.range?.out ?? duration(p)) })
          break
        case 'o':
          edit({ op: 'range', in: Math.min(p.range?.in ?? 0, time.t - 1 / fps), out: time.t })
          break
        case 'x':
          if (e.altKey) edit({ op: 'range', in: null })
          else {
            const c = clipsUnderPlayhead(p).filter(cc => cc.kind !== 'audio').at(-1) ?? clipsUnderPlayhead(p)[0]
            if (c) edit({ op: 'range', in: c.start, out: clipEnd(c) })
          }
          break
        case '≈': // ⌥X on a US Mac keyboard
          edit({ op: 'range', in: null })
          break
        case 'a':
          set({ tool: 'select' })
          break
        case 'b':
          set({ tool: 'blade' })
          break
        case 't':
          set({ tool: 'trim' })
          break
        case 'y':
          set({ tool: 'slip' })
          break
        case 'u':
          set({ tool: 'slide' })
          break
        case 'h':
          set({ tool: 'hand' })
          break
        case 'n':
          set({ snapping: !store.snapping })
          toast(`Snapping ${store.snapping ? 'on' : 'off'}`)
          break
        case 'm':
          edit({ op: 'marker', t: time.t, label: '' })
          break
        case 'Backspace':
        case 'Delete': {
          runEditorCommand(e.shiftKey ? 'rippleDelete' : 'delete')
          break
        }
        case '[':
        case ']':
        case '“':
        case '‘': {
          if (!e.altKey && !e.shiftKey) {
            handled = false
            break
          }
          const right = k === ']' || k === '‘'
          const seen = new Set()
          const all = p.tracks.flatMap(t => t.clips)
          // The core trims linked partners, so send one trim per link group.
          const ids = (sel().length ? sel() : clipsUnderPlayhead(p).map(c => c.id)).filter(id => {
            const link = all.find(c => c.id === id)?.link
            if (!link || !store.linked) return true
            if (seen.has(link)) return false
            seen.add(link)
            return true
          })
          edit(ids.map(id => ({ op: 'trim', id, edge: right ? 'right' : 'left', to: time.t, ripple: e.altKey, ...(store.linked ? {} : { unlinked: true }) })))
          break
        }
        case ',':
        case '.':
        case '<':
        case '>': {
          const d = ((k === ',' || k === '<') ? -1 : 1) * (e.shiftKey ? 10 : 1) / fps
          const all = p.tracks.flatMap(t => t.clips)
          edit(sel().map(id => ({ op: 'move', id, start: Math.max(0, (all.find(c => c.id === id)?.start ?? 0) + d), unlinked: true })))
          break
        }
        case 'v':
          if (sel().length) {
            const first = p.tracks.flatMap(t => t.clips).find(c => c.id === sel()[0])
            edit({ op: 'update', ids: sel(), set: { enabled: first?.enabled === false ? null : false } })
          }
          break
        case 'ƒ': // ⌥F
        case 'f': {
          if (e.altKey || k === 'ƒ') {
            const c = sel().length ? p.tracks.flatMap(t => t.clips).find(cc => cc.id === sel()[0]) : clipsUnderPlayhead(p).filter(cc => cc.kind === 'video').at(-1)
            if (c) edit({ op: 'freeze', id: c.id, at: time.t, dur: 2 })
          } else handled = runEditorCommand('matchFrame') === 'handled'
          break
        }
        case 'e':
        case 'w':
        case 'd':
        case 'q': {
          const sourceContext = { root: store.root, version: store.version, project: store.project, composition: store.openComp ?? null, source: store.source }
          if (!sourceContext.source?.src) {
            toast('Pick a clip in the media browser first')
            break
          }
          const how = { e: 'append', w: 'insert', d: 'overwrite', q: 'connect' }[lower]
          const source = { ...sourceContext.source }
          try {
            const view = compView(sourceContext.project, sourceContext.composition)
            const op = { ...sourcePlacementPlan(view, source, how, time.t), comp: sourceContext.composition }
            if (sourceContext.root !== store.root || sourceContext.version !== store.version || sourceContext.project !== store.project || sourceContext.composition !== (store.openComp ?? null) || sourceContext.source !== store.source || source.src !== store.source?.src || source.in !== store.source?.in || source.out !== store.source?.out || source.audio !== store.source?.audio) throw new Error('The project or source changed. Open the source again before placing it.')
            edit(op, `${how} ${source.src.split('/').pop()}`, { expectedVersion: sourceContext.version })
          } catch (error) { toast(error.message, 'error') }
          break
        }
        case 'z':
          if (e.shiftKey) set({ zoom: Math.max(0.5, (document.querySelector('.tl-canvas')?.clientWidth ?? 1000) / Math.max(1, duration(p) * 1.05)), scroll: 0 })
          else handled = false
          break
        case 'Escape':
          set({ selection: [], selMarker: null })
          break
        case '/':
          set({ chatOpen: true })
          setTimeout(() => document.querySelector('.chat textarea')?.focus(), 30)
          break
        case '?':
          set({ showKeys: !store.showKeys })
          break
        default:
          handled = false
      }
    }
    if (handled) e.preventDefault()
  })
}

export { snapToFrame }
