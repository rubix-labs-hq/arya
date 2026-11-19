import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { ANALYSIS_HELP, measuredNothing, parseLoudness, parseSilence } from '../core/analysis-parse.js'
import { BUNDLED_FONTS, SYSTEM_FONTS } from '../core/fonts.js'
import { applyOps, newProject, sourceTime } from '../core/project.js'
import { hasFFmpeg, runningServer, waitFor } from './fixtures/running-server.mjs'

// Recorded from ffmpeg 9.0.2 on a generated tone: `-af ebur128=peak=true:framelog=quiet`.
const SUMMARY = `[Parsed_ebur128_0 @ 0x7cf0838900] Summary:

  Integrated loudness:
    I:         -28.1 LUFS
    Threshold: -41.2 LUFS

  Loudness range:
    LRA:        21.8 LU
    Threshold: -54.2 LUFS
    LRA low:   -51.8 LUFS
    LRA high:  -30.0 LUFS

  True peak:
    Peak:      -24.1 dBFS
[out#0/null @ 0x7cf0838180] video:0KiB audio:517KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: unknown
`
const SILENT = SUMMARY.replace('-28.1 LUFS', '-70.0 LUFS').replace('21.8 LU', ' 0.0 LU').replace('-24.1 dBFS', ' -inf dBFS')
const PAST_END = `${SUMMARY.replace('-24.1 dBFS', '  0.0 dBFS')}[out#0/null @ 0x782cc3c180] Output file is empty, nothing was encoded(check -ss / -t / -frames parameters if used)\n`

test('the loudness summary gives integrated loudness, range and true peak', () => {
  assert.deepEqual(parseLoudness(SUMMARY), { lufs: -28.1, lra: 21.8, truePeak: -24.1 })
  // The range thresholds and LRA low and high are not mistaken for the values.
  assert.deepEqual(parseLoudness(SILENT), { lufs: -70, lra: 0, truePeak: undefined, silent: true })
  assert.deepEqual(parseLoudness('no summary here'), { lufs: undefined, lra: undefined, truePeak: undefined })
  assert.equal(measuredNothing(PAST_END), true); assert.equal(measuredNothing(SUMMARY), false)
})

test('silence pairs come back in source seconds when a range moved the start', () => {
  const log = '[Parsed_silencedetect_0 @ 0x1] silence_start: 0.999864\n[Parsed_silencedetect_0 @ 0x1] silence_end: 4 | silence_duration: 3.000136\n[Parsed_silencedetect_0 @ 0x1] silence_start: 4.5\n'
  assert.deepEqual(parseSilence(log), [[0.999864, 4]])
  assert.deepEqual(parseSilence(log, 1), [[1.999864, 5]], 'an unfinished silence at the end is left out, as before')
  assert.deepEqual(parseSilence(''), [])
})

test('the clip sentence of the analysis help matches how a clip reads its source', () => {
  assert.match(ANALYSIS_HELP.clip, /plays its source from clip\.in for clip\.dur \* speed seconds/)
  assert.match(ANALYSIS_HELP.clip, /Source second s plays at timeline second clip\.start \+ \(s - clip\.in\) \/ speed/)
  let p = newProject('Clip')
  p.assets['a.wav'] = { duration: 60, hasAudio: true, assetKind: 'audio' }
  p = applyOps(p, [{ op: 'append', track: 'A1', src: 'a.wav', in: 10, dur: 8 }, { op: 'speed', id: 'c1', speed: 2 }, { op: 'move', id: 'c1', start: 5 }]).project
  const clip = p.tracks.find(track => track.id === 'A1').clips[0]
  assert.deepEqual([clip.start, clip.in, clip.dur, clip.speed], [5, 10, 4, 2])
  const source = 14, timeline = clip.start + (source - clip.in) / clip.speed
  assert.equal(sourceTime(p, clip, timeline), source)
  assert.equal(sourceTime(p, clip, clip.start + clip.dur - 1e-9) - clip.in < clip.dur * clip.speed, true)
})

const tone = (root, initial) => {
  fs.mkdirSync(path.join(root, 'media'))
  // Two seconds of tone, two of silence, two of a much quieter tone.
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2,volume=0.5', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2,volume=0.05', '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1', '-ar', '44100', path.join(root, 'media', 'tone.wav')])
  initial.assets['media/tone.wav'] = { duration: 6, hasAudio: true, hasVideo: false, assetKind: 'audio' }
  return initial
}
const listing = root => fs.readdirSync(root, { recursive: true }).map(String).filter(name => !name.startsWith('bin') && !name.startsWith('.reel')).sort()

test('the real server measures loudness and silence for a part of a file, with true peak, and writes nothing', { skip: !hasFFmpeg && 'ffmpeg is not installed' }, async t => {
  const server = await runningServer(t, [
    { method: 'GET', path: '/api/caps' },
    { method: 'POST', path: '/api/analyze', body: { src: 'media/tone.wav', kind: 'loudness', in: 4, dur: 2 } },
  ], { tools: true, setup: tone })
  // The server probes the file once at start and saves what it found; measure after that.
  await waitFor(async () => (await server.api('GET', '/api/project')).body.project.assets['media/tone.wav'].codec)
  const before = listing(server.root)
  const analyze = async body => { const reply = await server.api('POST', '/api/analyze', { src: 'media/tone.wav', ...body }); return reply.status === 200 ? reply.body : { error: reply.body.error } }
  const whole = await analyze({ kind: 'loudness' })
  assert.deepEqual(Object.keys(whole).sort(), ['kind', 'lra', 'lufs', 'truePeak'])
  assert.ok(whole.truePeak < -20 && whole.truePeak > -28, JSON.stringify(whole))
  const loud = await analyze({ kind: 'loudness', in: 0, dur: 2 }), quiet = await analyze({ kind: 'loudness', in: 4, dur: 2 })
  assert.deepEqual([loud.in, loud.dur, quiet.in, quiet.dur], [0, 2, 4, 2])
  assert.ok(loud.lufs - quiet.lufs > 15, `${loud.lufs} against ${quiet.lufs}`)
  assert.ok(loud.truePeak - quiet.truePeak > 15, `${loud.truePeak} against ${quiet.truePeak}`)
  const gap = await analyze({ kind: 'loudness', in: 2.3, dur: 1.4 })
  assert.equal(gap.silent, true); assert.equal(Object.hasOwn(gap, 'truePeak'), false)
  // Silence: the default threshold takes the quiet tone for silence, a lower one does not.
  const near = (pairs, expected) => { assert.equal(pairs.length, expected.length, JSON.stringify(pairs)); pairs.flat().forEach((value, index) => assert.ok(Math.abs(value - expected.flat()[index]) < 0.05, JSON.stringify(pairs))) }
  near((await analyze({ kind: 'silence' })).ranges, [[2, 6]])
  near((await analyze({ kind: 'silence', noise: -50 })).ranges, [[2, 4]])
  const part = await analyze({ kind: 'silence', noise: -50, in: 1, dur: 4 })
  near(part.ranges, [[2, 4]]); assert.deepEqual([part.in, part.dur], [1, 4])
  near((await analyze({ kind: 'silence', noise: -50, in: 3 })).ranges, [[3, 4]])
  // Refusals say what is wrong.
  assert.match((await analyze({ kind: 'loudness', in: 30, dur: 2 })).error, /No sound was measured/)
  assert.match((await analyze({ kind: 'loudness', in: -1 })).error, /in must be a number from 0/)
  assert.match((await analyze({ kind: 'silence', dur: 0 })).error, /dur must be a number from 0\.1 to 3600/)
  assert.match((await analyze({ kind: 'beats', in: 1 })).error, /in and dur apply only to kind loudness and silence/)
  assert.deepEqual(listing(server.root), before, 'measuring writes no file in the project')
  // The agent reads the same through its tools.
  const agent = await server.ask('Measure the last two seconds.')
  const [caps, measured] = agent.results
  assert.deepEqual(caps.analysisHelp, ANALYSIS_HELP)
  assert.deepEqual({ ...measured, lufs: 0, lra: 0, truePeak: 0 }, { kind: 'loudness', lufs: 0, lra: 0, truePeak: 0, in: 4, dur: 2 })
  assert.equal(measured.lufs, quiet.lufs)
})

test('caps lists the fonts the editor knows and how to measure sound', async t => {
  const server = await runningServer(t)
  const caps = (await server.api('GET', '/api/caps')).body
  assert.deepEqual(caps.fonts.bundled, BUNDLED_FONTS); assert.ok(caps.fonts.bundled.includes('Inter'))
  assert.deepEqual(caps.fonts.system, SYSTEM_FONTS)
  assert.match(caps.fonts.note, /draws only if this machine has it/)
  assert.deepEqual(caps.analysisHelp, ANALYSIS_HELP)
  assert.equal(caps.analysis.loudness, true); assert.equal(caps.analysis.silence, true)
  // Each default and limit the help names is the one the server uses.
  const source = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  assert.match(source, /analysisNumber\(options\.noise, -32, -90, 0, 'noise'\)/)
  assert.match(source, /analysisNumber\(options\.min, 0\.45, 0\.01, 60, 'min'\)/)
  assert.match(ANALYSIS_HELP.silence, /noise \(dB, default -32\) for at least min seconds \(default 0\.45\)/)
  assert.match(source, /'audio-wav': \{ ext: 'wav'/)
  // The bundled list is the pair of families the renderer loads from web/fonts.
  const media = fs.readFileSync(new URL('../web/engine/media.js', import.meta.url), 'utf8')
  for (const family of BUNDLED_FONTS) assert.ok(media.includes(family), family)
})
