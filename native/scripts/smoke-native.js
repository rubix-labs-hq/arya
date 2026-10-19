// Run through the debug app's --automation option with a scratch project folder.
const { api, host } = await import('/host.js')
const { startNativeExport, saveNativeFrame } = await import('/engine/export-webcodecs.js')
const { figmaToOps } = await import('/core/figma.js')
const { drawTitle } = await import('/engine/media.js')
await api('/api/new', { name: 'Native smoke', width: 320, height: 180, fps: 24 })
await api('/api/import', { paths: ['media/clip.mp4', 'media/tone.m4a'] })
await api('/api/ops', { ops: [
  { op: 'append', src: 'media/clip.mp4', dur: 1 },
  { op: 'add_title', text: 'INTER NATIVE', start: 0, dur: 1, title: { font: 'Inter', weight: 700, size: 144, tracking: 12, anim: 'none', shadow: null, plate: '#000000cc', padding: 18 }, set: { x: 160, y: 45 } },
  { op: 'add_caption', text: 'Native export', start: 0, dur: 1 },
] })
const initial = (await api('/api/project')).project
const imported = figmaToOps({
  id: 'frame-native', type: 'FRAME', name: 'Native boxed text', size: { x: 320, y: 180 }, clipsContent: true,
  fills: [{ type: 'SOLID', color: { r: 0.03, g: 0.05, b: 0.08 } }],
  children: [{ id: 'text-native', type: 'TEXT', name: 'Boxed Inter', size: { x: 260, y: 90 }, relativeTransform: [[1, 0, 30], [0, 1, 40]], characters: 'Figma boxed text wraps within this frame.',
    fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
    style: { fontFamily: 'Inter', fontWeight: 500, fontSize: 20, lineHeightPx: 25, letterSpacing: 1.5, textAutoResize: 'NONE', textAlignHorizontal: 'LEFT', textAlignVertical: 'TOP' },
  }],
}, { project: initial, fps: 24, duration: 1 })
await api('/api/ops', { ops: imported.ops })
const { project } = await api('/api/project')
const still = await saveNativeFrame(project, { at: 0.5 })
const boxedStill = await saveNativeFrame(project, { at: 0.5, comp: imported.comp })
const fonts = [...document.fonts].filter(font => font.family === 'Inter').map(font => ({ style: font.style, status: font.status }))
if (fonts.length !== 2 || fonts.some(font => font.status !== 'loaded')) throw new Error('The bundled Inter fonts did not load in WKWebView.')
const plain = document.createElement('canvas'), spaced = document.createElement('canvas')
drawTitle(plain, { text: 'INTER', font: 'Inter', size: 120, tracking: 0 }, 1 / 6)
drawTitle(spaced, { text: 'INTER', font: 'Inter', size: 120, tracking: 12 }, 1 / 6)
if (spaced.width <= plain.width) throw new Error('Inter title tracking did not change native text metrics.')
const fontProof = { fonts, plainWidth: plain.width, spacedWidth: spaced.width, boxedStill, comp: imported.comp, warnings: imported.warnings }
const chunkBytes = Uint8Array.from({ length: 5 * 1024 * 1024 }, (_, i) => i % 251)
const chunkSave = await host.save(chunkBytes, { name: 'renders/chunk-test.bin' })
const savedBytes = new Uint8Array(await (await fetch(`/media?path=${encodeURIComponent(chunkSave.path)}`)).arrayBuffer())
if (savedBytes.length !== chunkBytes.length || savedBytes.some((v, i) => v !== i % 251)) throw new Error('Chunked native saves changed the file bytes.')
const exports = []
for (const preset of ['h264-high', 'hevc', 'audio-m4a', 'audio-wav']) {
  const { completion } = await startNativeExport(project, { preset, name: `native-${preset}`, width: 320, height: 180, fps: 24, range: { in: 0, out: 1 } })
  exports.push(await completion)
}
const cancelled = await startNativeExport(project, { preset: 'h264-web', name: 'cancelled', width: 640, height: 360, fps: 30, range: { in: 0, out: 30 } })
cancelled.completion.catch(() => {})
let progressBeforeCancel = 0
for (let i = 0; i < 100; i++) {
  const { jobs } = await api('/api/jobs')
  const job = jobs.find(j => j.id === cancelled.job.id)
  progressBeforeCancel = job.progress
  if (progressBeforeCancel > 0.12 || job.state !== 'running') break
  await new Promise(resolve => setTimeout(resolve, 20))
}
await api('/api/jobs/cancel', { id: cancelled.job.id })
let cancelError
try { await cancelled.completion } catch (error) { cancelError = error.message }
const interchange = await api('/api/interchange/export', { format: 'otio' })
const preview = await api('/api/interchange/import', { path: interchange.path })
const assistant = await api('/api/assistant/status')
let setupError
if (!assistant.configured) { try { await api('/api/bridge/send', { text: 'Describe the current project' }) } catch (error) { setupError = error.message } }
return { host: host.kind, caps: await api('/api/caps'), state: await api('/api/state'), assistant, setupError, still, fontProof, chunkBytes: savedBytes.length, exports, cancelError, progressBeforeCancel, jobs: await api('/api/jobs'), interchange, previewName: preview.project.name, audioWorklet: typeof AudioWorkletNode, videoEncoder: typeof VideoEncoder }
