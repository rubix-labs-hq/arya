// Motion page keys, After Effects style. They run in the capture phase so they win over
// the editor's global keys, and only on the Motion page.
//   F9 easy ease · ⇧F9 ease in · ⌘⇧F9 ease out · ⌫ delete selected keys
//   ⌘C / ⌘V copy and paste keys (clips when no key is selected)
//   V select · Q shape tools (again cycles) · G pen · Y anchor point
//   P S R T A reveal position, scale, rotation, opacity, anchor · U animated properties

import { edit, set, store, time, toast, viewProject } from '../store.js'
import { copyKeys, deleteOps, easeOps, pasteOps } from './keyframes.js'
import { REVEAL } from './props.js'
import { ms, mset } from './state.js'

const SHAPE_CYCLE = ['rect', 'ellipse', 'polygon', 'star']

export function installMotionKeys() {
  window.addEventListener('keydown', e => {
    if (store.page !== 'motion' || e.target.closest?.('input, textarea, select, [contenteditable]')) return
    const cmd = e.metaKey || e.ctrlKey
    const m = ms()
    const keys = m.keySel
    const lower = e.key.length === 1 ? e.key.toLowerCase() : e.key
    let handled = true

    if (e.key === 'F9') {
      if (!keys.length) toast('Select keyframes first')
      else {
        const mode = cmd && e.shiftKey ? 'out' : e.shiftKey ? 'in' : 'easy'
        edit(easeOps(store.project, keys, mode), mode === 'easy' ? 'easy ease' : `easy ease ${mode}`)
      }
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && keys.length && !cmd) {
      edit(deleteOps(keys), `delete ${keys.length} key${keys.length > 1 ? 's' : ''}`)
      mset({ keySel: [] })
    } else if (cmd && lower === 'c') {
      if (!keys.length) {
        mset({ lastCopy: 'clips' })
        handled = false // the editor copies the selected clips
      } else {
        const board = copyKeys(store.project, keys)
        mset({ keyClipboard: board, lastCopy: 'keys' })
        toast(`Copied ${board.items.length} key${board.items.length > 1 ? 's' : ''}`)
      }
    } else if (cmd && lower === 'v' && m.lastCopy === 'keys' && m.keyClipboard) {
      const view = viewProject()
      const target = view.tracks.flatMap(t => t.clips).filter(c => store.selection.includes(c.id))
      if (target.length !== 1) toast('Select one layer to paste keys into')
      else {
        const onto = m.graphProps.length === 1 && m.graphProps[0].startsWith(`${target[0].id}|`) ? m.graphProps[0].split('|')[1] : undefined
        const { ops, selection } = pasteOps(m.keyClipboard, target[0], time.t, view.fps, onto)
        edit(ops, `paste ${ops.length} key${ops.length > 1 ? 's' : ''}`)
        mset({ keySel: selection })
      }
    } else if (!cmd && !e.altKey && lower === 'v') set({ tool: 'select' })
    else if (!cmd && !e.altKey && lower === 'q') {
      const next = store.tool === 'm-shape' ? SHAPE_CYCLE[(SHAPE_CYCLE.indexOf(m.shapeKind) + 1) % SHAPE_CYCLE.length] : m.shapeKind
      mset({ shapeKind: next })
      set({ tool: 'm-shape' })
    } else if (!cmd && !e.altKey && lower === 'g') set({ tool: 'm-pen' })
    else if (!cmd && !e.altKey && lower === 'y') set({ tool: 'm-anchor' })
    else if (!cmd && !e.altKey && !e.shiftKey && REVEAL[lower]) {
      const props = REVEAL[lower]
      const same = m.reveal?.props?.join() === props.join()
      mset({ reveal: same ? null : { props } })
    } else if (!cmd && !e.altKey && lower === 'u') mset({ reveal: m.reveal?.animated ? null : { animated: true } })
    else if (e.key === 'Escape' && keys.length) {
      mset({ keySel: [] })
      handled = false
    } else handled = false

    if (handled) {
      e.preventDefault()
      e.stopImmediatePropagation()
    }
  }, true)
}
