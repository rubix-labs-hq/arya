import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

// Run the actual engine-host wiring. Both keyboard and host menu commands use this player.
function host() {
  const state = { viewerMode: 'source', source: { src: 'media/clip.mp4' }, playing: false }
  const context = vm.createContext({
    document: { createElement: () => ({}) },
    Compositor: class {}, Media: class {}, AudioEngine: class {},
    Player: class { constructor(options) { Object.assign(this, options) } },
    store: state, set: patch => Object.assign(state, patch), subscribe() {}, setInterval() {},
    setTime() {}, viewProject: () => null, loadLuts() {}, api() {}, host: { kind: 'server' },
  })
  const source = fs.readFileSync(new URL('../web/ui/engine-host.js', import.meta.url), 'utf8')
  vm.runInContext(source.replace(/^import .*$/gm, '').replace(/^export /gm, '') + '\nglobalThis.transport = player', context)
  return { state, player: context.transport }
}

test('starting timeline playback reveals the timeline instead of a frozen source viewer', () => {
  const { state, player } = host()
  player.onState({ playing: true, rate: 1 })
  assert.equal(state.playing, true)
  assert.equal(state.viewerMode, 'timeline')
  assert.equal(state.source.src, 'media/clip.mp4')
})

test('stopping timeline playback does not interrupt the source viewer', () => {
  const { state, player } = host()
  player.onState({ playing: false, rate: 0 })
  assert.equal(state.viewerMode, 'source')
})
