import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { captureExportSources, prepareExportCohort, createExportDestination } from '../core/export-cohort.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-export-cohort-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'media'))
  for (const [name, bytes] of [['video.mp4', 'admitted video'], ['proxy.mp4', 'admitted proxy'], ['audio.wav', 'admitted audio'], ['grade.cube', 'admitted lut']]) fs.writeFileSync(path.join(root, 'media', name), bytes)
  const project = { name: 'fixture', assets: { 'media/video.mp4': { proxy: 'media/proxy.mp4' }, 'media/audio.wav': {} }, tracks: [{ clips: [{ src: 'media/video.mp4', grade: { lut: 'media/grade.cube' } }] }], comps: { nested: { tracks: [{ clips: [{ src: 'media/audio.wav' }] }] } } }
  return { root, project }
}

for (const target of ['original', 'copy']) test(`final cohort check refuses an earlier ${target} changed while a later source validates`, async t => {
  const { root, project } = fixture(t)
  const cohort = await prepareExportCohort(root, captureExportSources(root, project))
  const file = target === 'original' ? path.join(root, 'media/video.mp4') : path.join(root, cohort.project.tracks[0].clips[0].src)
  let checks = 0, mutated = false
  try {
    await assert.rejects(cohort.assertCurrent(() => {
      if (++checks === 4) {
        fs.chmodSync(file, 0o600)
        fs.writeFileSync(file, 'changed earlier source bytes')
        mutated = true
      }
    }), /changed/)
    assert.equal(mutated, true)
  } finally { cohort.cleanup() }
})

test('immutable cohort rewrites video, proxy, audio, nested clip and LUT to admitted byte copies', async t => {
  const { root, project } = fixture(t), captured = captureExportSources(root, project)
  captured.project.tracks[0].clips.push({ kind: 'title', text: 'media/video.mp4', transcript: { text: 'media/audio.wav' } })
  const cohort = await prepareExportCohort(root, captured)
  await cohort.assertCurrent()
  const clip = cohort.project.tracks[0].clips[0]
  assert.notEqual(clip.src, project.tracks[0].clips[0].src)
  assert.equal(fs.readFileSync(path.join(root, clip.src), 'utf8'), 'admitted video')
  assert.equal(fs.readFileSync(path.join(root, cohort.project.assets[clip.src].proxy), 'utf8'), 'admitted proxy')
  assert.equal(fs.readFileSync(path.join(root, clip.grade.lut), 'utf8'), 'admitted lut')
  assert.equal(fs.readFileSync(path.join(root, cohort.project.comps.nested.tracks[0].clips[0].src), 'utf8'), 'admitted audio')
  assert.equal(project.tracks[0].clips[0].src, 'media/video.mp4')
  assert.equal(cohort.project.tracks[0].clips[1].text, 'media/video.mp4')
  assert.equal(cohort.project.tracks[0].clips[1].transcript.text, 'media/audio.wav')
  cohort.cleanup()
  assert.equal(fs.readFileSync(path.join(root, 'media/video.mp4'), 'utf8'), 'admitted video')
})

for (const name of ['video.mp4', 'proxy.mp4', 'audio.wav', 'grade.cube']) test(`changed ${name} refuses publication while immutable bytes remain admitted`, async t => {
  const { root, project } = fixture(t), cohort = await prepareExportCohort(root, captureExportSources(root, project))
  const source = path.join(root, 'media', name), stat = fs.statSync(source)
  fs.writeFileSync(source, 'new bytes'); fs.utimesSync(source, stat.atime, stat.mtime)
  await assert.rejects(cohort.assertCurrent(), /changed/)
  const copies = Object.values(cohort.project.assets).map(a => a.proxy).filter(Boolean)
  assert.ok(copies.every(value => fs.existsSync(path.join(root, value))))
  cohort.cleanup(); assert.equal(fs.readFileSync(source, 'utf8'), 'new bytes')
})

test('same bytes in a replaced inode refuse queued source preparation', async t => {
  const { root, project } = fixture(t), captured = captureExportSources(root, project), source = path.join(root, 'media/video.mp4')
  fs.renameSync(source, source + '.old'); fs.copyFileSync(source + '.old', source)
  await assert.rejects(prepareExportCohort(root, captured), /changed/)
  assert.equal(fs.readFileSync(source + '.old', 'utf8'), 'admitted video')
})

test('an empty disabled LUT remains disabled in the admitted snapshot', async t => {
  const { root, project } = fixture(t)
  project.tracks[0].clips[0].grade.lut = ''
  const captured = captureExportSources(root, project), cohort = await prepareExportCohort(root, captured)
  assert.equal(captured.records.length, 3)
  assert.equal(cohort.project.tracks[0].clips[0].grade.lut, '')
  await cohort.assertCurrent(); cohort.cleanup()
})

test('confined absolute source aliases retain compatibility while outside files refuse admission', async t => {
  const { root, project } = fixture(t), original = 'media/video.mp4', absolute = path.join(root, original)
  project.assets[absolute] = project.assets[original]; delete project.assets[original]
  project.tracks[0].clips[0].src = absolute
  const cohort = await prepareExportCohort(root, captureExportSources(root, project))
  assert.equal(fs.readFileSync(path.join(root, cohort.project.tracks[0].clips[0].src), 'utf8'), 'admitted video')
  await cohort.assertCurrent(); cohort.cleanup()
  project.tracks[0].clips[0].src = path.join(path.dirname(root), 'outside-file.mp4')
  assert.throws(() => captureExportSources(root, project), /outside the project/)
})

test('symlink leaf and linked source parent refuse capture without reading a target', t => {
  const { root, project } = fixture(t), source = path.join(root, 'media/video.mp4')
  fs.renameSync(source, source + '.old'); fs.symlinkSync(source + '.old', source)
  assert.throws(() => captureExportSources(root, project), /symbolic links/)
  fs.unlinkSync(source); fs.renameSync(source + '.old', source)
  fs.renameSync(path.join(root, 'media'), path.join(root, 'old-media')); fs.symlinkSync('old-media', path.join(root, 'media'))
  assert.throws(() => captureExportSources(root, project), /symbolic links/)
})

test('copy cancellation drains held descriptors, removes owned stages, and preserves originals', async t => {
  const { root, project } = fixture(t), source = path.join(root, 'media/video.mp4')
  fs.writeFileSync(source, Buffer.alloc(3 * 1024 * 1024, 7))
  const captured = captureExportSources(root, project)
  let checks = 0
  await assert.rejects(prepareExportCohort(root, captured, () => { if (++checks > 4) throw new Error('cancelled') }), /cancelled/)
  assert.equal(fs.statSync(source).size, 3 * 1024 * 1024)
  assert.deepEqual(fs.readdirSync(path.join(root, '.reel/export-cohorts')), [])
})

test('parent replacement after admission refuses preparation and preserves both directories', async t => {
  const { root, project } = fixture(t), captured = captureExportSources(root, project)
  fs.renameSync(path.join(root, 'media'), path.join(root, 'old-media')); fs.mkdirSync(path.join(root, 'media'))
  for (const name of fs.readdirSync(path.join(root, 'old-media'))) fs.linkSync(path.join(root, 'old-media', name), path.join(root, 'media', name))
  await assert.rejects(prepareExportCohort(root, captured), /parent changed/)
  assert.equal(fs.readFileSync(path.join(root, 'old-media/video.mp4'), 'utf8'), 'admitted video')
})

for (const kind of ['file', 'empty', 'symlink', 'directory']) test(`existing ${kind} destination refuses without changing it`, t => {
  const { root } = fixture(t), output = path.join(root, 'renders/result.mp4')
  fs.mkdirSync(path.dirname(output))
  if (kind === 'directory') fs.mkdirSync(output)
  else if (kind === 'symlink') fs.symlinkSync('../media/video.mp4', output)
  else fs.writeFileSync(output, kind === 'empty' ? '' : 'keep this output')
  assert.throws(() => createExportDestination(root, output), /already exists|symbolic links/)
  if (kind === 'file') assert.equal(fs.readFileSync(output, 'utf8'), 'keep this output')
  assert.equal(fs.readFileSync(path.join(root, 'media/video.mp4'), 'utf8'), 'admitted video')
})

test('late destination collision refuses final publication and retains the external output', t => {
  const { root } = fixture(t), output = path.join(root, 'renders/result.mp4'), owned = createExportDestination(root, output)
  fs.writeFileSync(owned.output, 'rendered cohort bytes'); fs.writeFileSync(output, 'keep late output')
  assert.throws(() => owned.publish(), /appeared/)
  assert.equal(owned.state, 'staged'); assert.deepEqual(owned.published, [])
  owned.cleanup(); assert.equal(fs.readFileSync(output, 'utf8'), 'keep late output')
})

test('missing source reference is protected before exclusive output admission', t => {
  const { root } = fixture(t), output = path.join(root, 'renders/missing.mp4')
  assert.throws(() => createExportDestination(root, output, { references: ['renders/missing.mp4'] }), /source media/)
  assert.equal(fs.existsSync(output), false)
})

test('file publication creates one final file and stage cleanup preserves it', t => {
  const { root } = fixture(t), output = path.join(root, 'renders/nested/result.mp4'), owned = createExportDestination(root, output)
  fs.writeFileSync(owned.output, 'rendered cohort bytes'); owned.publish(); assert.equal(owned.state, 'published')
  assert.deepEqual(owned.published, ['renders/nested/result.mp4']); owned.cleanup()
  assert.equal(fs.readFileSync(output, 'utf8'), 'rendered cohort bytes')
})

test('incomplete frame sequence refuses final directory creation', t => {
  const { root } = fixture(t), out = path.join(root, 'renders/sequence/frame_%05d.png'), owned = createExportDestination(root, out, { sequence: true })
  fs.writeFileSync(path.join(path.dirname(owned.output), 'frame_00001.png'), 'frame1')
  assert.throws(() => owned.publish(2), /incomplete/); owned.cleanup()
  assert.equal(fs.existsSync(path.dirname(out)), false)
})

test('complete frame sequence publishes to an exclusively created directory', t => {
  const { root } = fixture(t), out = path.join(root, 'renders/sequence/frame_%05d.png'), owned = createExportDestination(root, out, { sequence: true })
  for (let i = 1; i <= 2; i++) fs.writeFileSync(path.join(path.dirname(owned.output), `frame_${String(i).padStart(5, '0')}.png`), `frame${i}`)
  owned.publish(2); assert.equal(owned.state, 'published'); assert.equal(owned.published.length, 2); owned.cleanup()
  assert.equal(fs.readFileSync(path.join(path.dirname(out), 'frame_00002.png'), 'utf8'), 'frame2')
})

test('a frame collision during sequence publication reports the actual partial output', t => {
  const { root } = fixture(t), out = path.join(root, 'renders/sequence/frame_%05d.png'), owned = createExportDestination(root, out, { sequence: true })
  for (let i = 1; i <= 2; i++) fs.writeFileSync(path.join(path.dirname(owned.output), `frame_${String(i).padStart(5, '0')}.png`), `frame${i}`)
  const link = fs.linkSync
  fs.linkSync = (source, target) => { if (target.endsWith('frame_00002.png')) fs.writeFileSync(target, 'late frame sentinel'); return link(source, target) }
  try { assert.throws(() => owned.publish(2), /EEXIST/) } finally { fs.linkSync = link }
  assert.equal(owned.state, 'partial'); assert.deepEqual(owned.published, ['renders/sequence/frame_00001.png'])
  owned.cleanup()
  assert.equal(fs.readFileSync(path.join(path.dirname(out), 'frame_00001.png'), 'utf8'), 'frame1')
  assert.equal(fs.readFileSync(path.join(path.dirname(out), 'frame_00002.png'), 'utf8'), 'late frame sentinel')
})

test('changed owned stage refuses cleanup of the replacement directory', t => {
  const { root } = fixture(t), output = path.join(root, 'renders/result.mp4'), owned = createExportDestination(root, output), stage = path.dirname(owned.output)
  fs.renameSync(stage, stage + '.owned'); fs.mkdirSync(stage); fs.writeFileSync(path.join(stage, 'sentinel'), 'keep replacement')
  assert.throws(() => owned.cleanup(), /directory changed/)
  assert.equal(fs.readFileSync(path.join(stage, 'sentinel'), 'utf8'), 'keep replacement')
})
