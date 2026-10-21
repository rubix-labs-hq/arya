// node --test editor/test
// Runs the real server on a temporary project (its path has a space, like real ones do)
// and drives the interchange routes over HTTP.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseSRT, parseXML, toSRT } from '../core/interchange.js'
import { applyOps, newProject } from '../core/project.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(HERE, '..', 'server.mjs')
const FCP_DTD = '/Applications/Final Cut Pro.app/Contents/Frameworks/Interchange.framework/Versions/A/Resources/FCPXMLv1_11.dtd'

const which = bin => {
  try {
    return execFileSync('/usr/bin/which', [bin], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.on('error', reject)
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address()
    s.close(() => resolve(port))
  })
})

function request(port, method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body)
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = JSON.parse(text)
        } catch {}
        resolve({ status: res.statusCode, json, text })
      })
    })
    req.on('error', reject)
    req.end(data ?? undefined)
  })
}

async function startServer(root, env) {
  const port = await freePort()
  const child = spawn(process.execPath, [SERVER, '--root', root, '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', d => (log += d))
  child.stderr.on('data', d => (log += d))
  const until = Date.now() + 15000
  for (;;) {
    try {
      const r = await request(port, 'GET', '/api/state')
      if (r.status === 200) break
    } catch {}
    if (Date.now() > until || child.exitCode !== null) throw new Error(`the server did not start:\n${log}`)
    await new Promise(r => setTimeout(r, 100))
  }
  const api = async (route, body) => {
    const r = await request(port, body === undefined ? 'GET' : 'POST', route, body)
    if (r.status !== 200) throw new Error(r.json?.error ?? `${route} ${r.status}`)

    return r.json
  }
  const stop = async () => {
    if (child.exitCode !== null) return
    const gone = new Promise(r => child.once('exit', r))
    child.kill('SIGTERM')
    await gone
  }

  return { port, api, stop, log: () => log, request: (...a) => request(port, ...a) }
}

/** Every clip and marker of a project in whole frames, as stored (through JSON). */
function frames(p) {
  const f = t => Math.round(t * p.fps)
  const clip = c => ({ ...c, start: f(c.start), dur: f(c.dur), ...(c.in !== undefined ? { in: f(c.in) } : {}), ...(c.transitionIn ? { transitionIn: { ...c.transitionIn, dur: f(c.transitionIn.dur) } } : {}) })

  return JSON.parse(JSON.stringify({ tracks: p.tracks.map(t => ({ ...t, clips: t.clips.map(clip) })), markers: p.markers.map(m => ({ ...m, t: f(m.t) })) }))
}

test('interchange routes on a running server', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-routes-'))
  const root = path.join(base, 'Mod Systems', 'film')
  fs.mkdirSync(path.join(root, 'media'), { recursive: true })
  const ffmpeg = which('ffmpeg')
  const ffprobe = which('ffprobe')
  // Tool folders the server may see: ffmpeg/ffprobe only, so a real whisper-cli never interferes.
  const tools = path.join(base, 'tools')
  const fake = path.join(base, 'fake-whisper')
  fs.mkdirSync(tools)
  fs.mkdirSync(fake)
  for (const [bin, at] of [['ffmpeg', ffmpeg], ['ffprobe', ffprobe]]) if (at) fs.symlinkSync(at, path.join(tools, bin))
  const PATH = [tools, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':')

  if (ffmpeg) {
    const make = (...args) => execFileSync(ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', ...args])
    make('-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30000/1001:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(root, 'media', 'clip one.mp4'))
    make('-f', 'lavfi', '-i', 'sine=frequency=220:duration=8', path.join(root, 'media', 'tone.wav'))
  } else {
    t.diagnostic('ffmpeg is not installed: media are declared, not probed, and the transcript success path cannot run')
  }

  // The project file, written before the server starts. Assets without a codec are probed by the
  // server at start when ffmpeg is there.
  let p = applyOps(newProject('Route film', { fps: 29.97 }), [{ op: 'import', assets: {
    'media/clip one.mp4': { duration: 6, width: 320, height: 180, fps: 29.97, hasVideo: true, hasAudio: true, channels: 1 },
    'media/tone.wav': { duration: 8, hasVideo: false, hasAudio: true, channels: 1 },
  } }]).project
  p = applyOps(p, [
    { op: 'add_clip', src: 'media/clip one.mp4', track: 'V1', start: 0, in: 1, dur: 2 },
    { op: 'add_clip', src: 'media/clip one.mp4', track: 'V1', start: 2, in: 3, dur: 2 },
    { op: 'add_clip', src: 'media/tone.wav', track: 'A3', start: 0.5, dur: 4, set: { volume: -9 } },
    { op: 'add_title', track: 'V3', start: 1, dur: 2, text: 'Route film' },
    { op: 'captions', items: [{ t: 0.2, end: 1.5, text: 'Hello & welcome' }, { t: 2, end: 3, text: 'Two' }] },
    { op: 'marker', t: 1, label: 'beat' },
  ]).project
  p = applyOps(p, [{ op: 'transition', id: 'c2', type: 'crossDissolve', dur: 0.5 }]).project
  fs.writeFileSync(path.join(root, 'reel.project.json'), JSON.stringify(p, null, 2))

  const one = await startServer(root, { ...process.env, PATH })
  try {
    // The server probes assets that lack a codec right after it starts, and that probe replaces
    // the project when it finishes, so wait for it before editing.
    for (let i = 0; ffmpeg && i < 100 && !Object.values((await one.api('/api/project')).project.assets).every(a => a.codec); i++) await new Promise(r => setTimeout(r, 100))
    const original = (await one.api('/api/project')).project
    const media = Object.keys(original.assets)

    await t.test('export writes each format into renders/', async () => {
      for (const format of ['fcpxml', 'otio', 'srt', 'vtt']) {
        const r = await one.api('/api/interchange/export', { format })
        assert.equal(r.path, `renders/Route-film.${format}`)
        assert.deepEqual(r.warnings, [])
        assert.ok(fs.existsSync(path.join(root, r.path)))
      }
      const xml = fs.readFileSync(path.join(root, 'renders', 'Route-film.fcpxml'), 'utf8')
      assert.match(xml, /src="file:\/\/[^"]*\/Mod%20Systems\/film\/media\/clip%20one\.mp4"/)
      if (fs.existsSync(FCP_DTD) && which('xmllint')) {
        fs.copyFileSync(FCP_DTD, path.join(base, 'fcpxml.dtd'))
        execFileSync('xmllint', ['--noout', '--dtdvalid', 'fcpxml.dtd', path.join(root, 'renders', 'Route-film.fcpxml')], { cwd: base, stdio: 'pipe' })
      } else parseXML(xml)
      const otio = JSON.parse(fs.readFileSync(path.join(root, 'renders', 'Route-film.otio'), 'utf8'))
      assert.equal(otio.OTIO_SCHEMA, 'Timeline.1')
      assert.equal(fs.readFileSync(path.join(root, 'renders', 'Route-film.srt'), 'utf8'), toSRT(original))
      assert.match(fs.readFileSync(path.join(root, 'renders', 'Route-film.vtt'), 'utf8'), /^WEBVTT\n\n00:00:00\.200 --> /)
      assert.equal((await one.api('/api/interchange/export', { format: 'srt', name: '../../escape' })).path, 'renders/escape.srt')
    })

    await t.test('export refuses unknown formats and empty caption tracks', async () => {
      await assert.rejects(one.api('/api/interchange/export', { format: 'aaf' }), /format must be/)
      await assert.rejects(one.api('/api/interchange/export', { format: 'vtt', track: 'C7' }), /no caption track C7/)
    })

    await t.test('files lists interchange files by kind, inside the project only', async () => {
      const names = async kind => (await one.api(`/api/interchange/files?dir=renders&kind=${kind}`)).entries.map(e => e.name)
      assert.deepEqual(await names('timeline'), ['Route-film.fcpxml', 'Route-film.otio'])
      assert.deepEqual(await names('captions'), ['escape.srt', 'Route-film.srt', 'Route-film.vtt'])
      assert.deepEqual((await one.api('/api/interchange/files')).entries.map(e => [e.name, e.dir]), [['media', true], ['renders', true]])
      await assert.rejects(one.api('/api/interchange/files?dir=..'), /outside the project folder/)
    })

    await t.test('import previews a timeline file without touching the project', async () => {
      const before = (await one.api('/api/project')).version
      for (const file of ['renders/Route-film.fcpxml', 'renders/Route-film.otio']) {
        const r = await one.api('/api/interchange/import', { path: file })
        assert.deepEqual(frames(r.project), frames(original))
        assert.deepEqual(r.missing, ffmpeg ? [] : media.sort())
        assert.deepEqual(r.warnings, [])
      }
      assert.equal((await one.api('/api/project')).version, before)
    })

    await t.test('reviewed HTTP imports reject changed projects and changed input without editing', async () => {
      const file = 'renders/Route-film.otio'
      const preview = await one.api('/api/interchange/import', { path: file })
      assert.equal(preview.sourceHash, createHash('sha256').update(fs.readFileSync(path.join(root, file), 'utf8')).digest('hex'))
      await one.api('/api/ops', { ops: [{ op: 'delete_marker', id: 'm1' }] })
      const before = await one.api('/api/project')
      await assert.rejects(one.api('/api/interchange/import', { path: file, apply: true, expectedVersion: preview.version, expectedInputHash: preview.sourceHash }), /project changed/i)
      const fresh = await one.api('/api/interchange/import', { path: file })
      const originalText = fs.readFileSync(path.join(root, file), 'utf8')
      try {
        fs.appendFileSync(path.join(root, file), '\n')
        await assert.rejects(one.api('/api/interchange/import', { path: file, apply: true, expectedVersion: fresh.version, expectedInputHash: fresh.sourceHash }), /input changed/i)
        assert.deepEqual(await one.api('/api/project'), before)
      } finally { fs.writeFileSync(path.join(root, file), originalText) }
    })

    await t.test('import with apply replaces the project through an op and probes its media', async () => {
      await one.api('/api/ops', { ops: [{ op: 'delete', ids: ['c1', 'c2'] }, { op: 'delete_marker', id: 'm1' }], returnProject: false })
      const r = await one.api('/api/interchange/import', { path: 'renders/Route-film.fcpxml', apply: true })
      assert.equal(r.applied, true)
      assert.deepEqual(r.probed, ffmpeg ? media.sort() : [])
      const now = (await one.api('/api/project')).project
      assert.deepEqual(frames(now), frames(original))
      if (ffmpeg) assert.equal(now.assets['media/clip one.mp4'].codec, 'h264')
      // The replace is one undo step.
      await one.api('/api/undo', {})
      assert.equal((await one.api('/api/project')).project.tracks[0].clips.length, 0)
      await one.api('/api/redo', {})
    })

    await t.test('import reads SRT and WebVTT, and applies them to a caption track', async () => {
      fs.writeFileSync(path.join(root, 'subs.srt'), '1\r\n00:00:04,000 --> 00:00:05,500\r\n<i>From</i> SRT\r\n')
      assert.deepEqual((await one.api('/api/interchange/import', { path: 'subs.srt' })).captions, [{ t: 4, end: 5.5, text: 'From SRT' }])
      await one.api('/api/interchange/import', { path: 'subs.srt', apply: true, replace: true })
      await one.api('/api/interchange/import', { path: 'renders/Route-film.vtt', apply: true, track: 'C2' })
      const tracks = (await one.api('/api/project')).project.tracks.filter(tr => tr.kind === 'caption')
      assert.deepEqual(tracks.map(tr => [tr.id, tr.clips.map(c => c.text)]), [['C1', ['From SRT']], ['C2', ['Hello & welcome', 'Two']]])
      assert.deepEqual(parseSRT(fs.readFileSync(path.join(root, 'subs.srt'), 'utf8')).length, 1)
    })

    await t.test('import refuses paths outside the project and files it cannot read', async () => {
      await assert.rejects(one.api('/api/interchange/import', { path: '../../outside.fcpxml' }), /outside the project folder/)
      await assert.rejects(one.api('/api/interchange/import', { path: '/etc/hosts' }), /outside the project folder/)
      await assert.rejects(one.api('/api/interchange/import', { path: 'missing.otio' }), /no file missing\.otio/)
      await assert.rejects(one.api('/api/interchange/import', { path: 'media' }), /is a folder/)
      fs.writeFileSync(path.join(root, 'premiere.xml'), '<xmeml version="5"/>')
      await assert.rejects(one.api('/api/interchange/import', { path: 'premiere.xml' }), /not FCPXML/)
      await assert.rejects(one.api('/api/interchange/import', { path: 'reel.project.json' }), /Arya reads/)
      const cross = await one.request('POST', '/api/interchange/import', { path: 'subs.srt', apply: true }, { origin: 'http://elsewhere.example' })
      assert.equal(cross.status, 403)
    })

    await t.test('captions from a transcript report a missing whisper.cpp clearly', async () => {
      await assert.rejects(one.api('/api/captions/from-transcript', { src: 'media/clip one.mp4' }), /Transcription needs whisper\.cpp/)
      await assert.rejects(one.api('/api/captions/from-transcript', {}), /give src/)
    })
  } finally {
    await one.stop()
  }

  if (ffmpeg) {
    // A stand-in for whisper-cli that writes the JSON whisper.cpp writes (-oj -of <prefix>).
    const home = path.join(base, 'home')
    fs.mkdirSync(path.join(home, '.reel', 'models'), { recursive: true })
    fs.writeFileSync(path.join(home, '.reel', 'models', 'ggml-base.en.bin'), '')
    const words = [[1100, 1500, 'Hello'], [1500, 1600, ','], [1650, 1900, 'world'], [1900, 1950, '.'], [3200, 3600, 'Second'], [3600, 3900, 'part']]
    fs.writeFileSync(path.join(fake, 'whisper-cli'), `#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do case "$1" in -of) out="$2"; shift;; esac; shift; done\ncat > "$out.json" <<'J'\n${JSON.stringify({ transcription: words.map(([from, to, text]) => ({ offsets: { from, to }, text: ` ${text}` })) })}\nJ\n`, { mode: 0o755 })
    for (const bin of ['ffmpeg', 'ffprobe']) fs.symlinkSync(path.join(tools, bin), path.join(fake, bin))
    const two = await startServer(root, { ...process.env, HOME: home, PATH: [fake, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':') })
    try {
      await t.test('captions from a transcript land where each clip plays the words', async () => {
        assert.equal((await two.api('/api/caps')).whisper, true)
        // c1 plays source 1–3 s at 0–2 s and c2 plays source 3–5 s at 2–4 s (both snapped to 29.97 frames).
        const r = await two.api('/api/captions/from-transcript', { src: 'media/clip one.mp4' })
        assert.deepEqual(r.clips, ['c1', 'c2'])
        assert.equal(r.words, 6)
        assert.deepEqual(r.items.map(c => c.text), ['Hello, world.', 'Second part'])
        assert.ok(Math.abs(r.items[0].t - 0.1) < 0.002, `first caption at ${r.items[0].t}`)
        assert.ok(Math.abs(r.items[1].t - 2.2) < 0.01, `second caption at ${r.items[1].t}`)
        const applied = await two.api('/api/captions/from-transcript', { id: 'c2', apply: true, track: 'C3' })
        assert.deepEqual(applied.items.map(c => c.text), ['Second part'])
        const c3 = (await two.api('/api/project')).project.tracks.find(tr => tr.id === 'C3')
        assert.deepEqual(c3.clips.map(c => c.text), ['Second part'])
      })
      await t.test('durable corrected transcripts preserve source bytes and reject stale saves', async () => {
        const source = path.join(root, 'media/clip one.mp4')
        const before = createHash('sha256').update(fs.readFileSync(source)).digest('hex')
        const saved = await two.api('/api/transcript?src=media%2Fclip%20one.mp4&locale=en-US')
        assert.equal(saved.status, 'complete')
        const corrected = saved.words.map((word, i) => i === 0 ? { ...word, text: 'Corrected' } : word)
        const result = await two.api('/api/transcript', { src: 'media/clip one.mp4', locale: 'en-US', words: corrected, revision: saved.revision })
        assert.equal(result.revision, saved.revision + 1)
        await assert.rejects(two.api('/api/transcript', { src: 'media/clip one.mp4', locale: 'en-US', words: saved.words, revision: saved.revision }), /transcript changed/)
        assert.equal((await two.api('/api/transcript?src=media%2Fclip%20one.mp4&locale=en-US')).words[0].text, 'Corrected')
        assert.equal(createHash('sha256').update(fs.readFileSync(source)).digest('hex'), before)
      })
      await t.test('transcription jobs expose their terminal result and model language limits', async () => {
        const caps = await two.api('/api/caps')
        assert.equal(caps.transcription.durable, true)
        assert.equal(caps.transcription.jobs, true)
        assert.deepEqual(caps.transcription.locales, ['en-US', 'en-GB'])
        await assert.rejects(two.api('/api/analyze', { src: 'media/clip one.mp4', kind: 'transcript', locale: 'es-ES', wait: false }), /only recognizes English/)
        const started = await two.api('/api/analyze', { src: 'media/clip one.mp4', kind: 'transcript', locale: 'en-US', wait: false })
        assert.ok(started.id)
        let job = started
        for (let i = 0; i < 10 && !['done', 'failed'].includes(job.state); i++) job = await two.api(`/api/jobs/wait?id=${started.id}&timeout=2500`)
        assert.equal(job.state, 'done', job.error)
        assert.equal(job.result.words.length, 6)
        assert.equal((await two.api('/api/transcript?src=media%2Fclip%20one.mp4&locale=en-US')).revision, job.result.revision)
      })
      await t.test('shorts review creates native compositions in one edit and undo restores the project', async () => {
        const before = await two.api('/api/project')
        const proposed = await two.api('/api/shorts/propose', { src: 'media/clip one.mp4', minDur: 1, maxDur: 5, count: 2 })
        assert.equal(proposed.scoring, 'transcript-structure')
        assert.ok(proposed.candidates.length)
        const body = { src: 'media/clip one.mp4', ranges: proposed.candidates.map((candidate, i) => ({ from: candidate.from, to: candidate.to, name: `Reviewed ${i + 1}` })), captions: true, captionStyle: 'karaoke', width: 1080, height: 1920 }
        const preview = await two.api('/api/shorts/build', body)
        assert.deepEqual((await two.api('/api/project')).project, before.project)
        const applied = await two.api('/api/shorts/build', { ...body, apply: true, expectedVersion: preview.version })
        assert.equal(applied.version, before.version + 1)
        for (const made of applied.comps) {
          const comp = applied.project.comps[made.id]
          assert.equal(comp.width, 1080); assert.equal(comp.height, 1920)
          const video = comp.tracks.find(track => track.kind === 'video' && track.clips.length)?.clips[0]
          assert.equal(video.fit, 'cover')
          assert.ok(comp.tracks.some(track => track.kind === 'audio' && track.clips.some(clip => clip.link === video.link)))
          assert.ok(comp.tracks.some(track => track.kind === 'caption' && track.style.preset === 'karaoke' && track.clips.every(clip => clip.words.length)))
        }
        await assert.rejects(two.api('/api/shorts/build', { ...body, apply: true, expectedVersion: preview.version }), /project changed/)
        assert.deepEqual((await two.api('/api/undo', {})).project, before.project)
      })
      await t.test('lifting a transcript passage maps source time and preserves unrelated tracks', async () => {
        const before = await two.api('/api/project')
        const body = { id: 'c1', ranges: [{ from: 1.2, to: 1.4 }], ripple: false }
        const preview = await two.api('/api/transcript/edit', body)
        assert.ok(Math.abs(preview.ranges[0].from - 0.2) <= 1 / before.project.fps, JSON.stringify(preview.ranges))
        assert.ok(Math.abs(preview.ranges[0].to - 0.4) <= 1 / before.project.fps, JSON.stringify(preview.ranges))
        assert.deepEqual((await two.api('/api/project')).project, before.project)
        const applied = await two.api('/api/transcript/edit', { ...body, apply: true, expectedVersion: preview.version })
        assert.equal(applied.version, before.version + 1)
        const selected = before.project.tracks.flatMap(track => track.clips).find(clip => clip.id === 'c1')
        const relevant = new Set(before.project.tracks.filter(track => track.clips.some(clip => clip.id === selected.id || clip.link === selected.link)).map(track => track.id))
        assert.deepEqual(applied.project.tracks.filter(track => !relevant.has(track.id)), before.project.tracks.filter(track => !relevant.has(track.id)))
        assert.deepEqual((await two.api('/api/undo', {})).project, before.project)
      })
    } finally {
      await two.stop()
    }
  }
  fs.rmSync(base, { recursive: true, force: true })
})
