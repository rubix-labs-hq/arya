// node --test editor/test
// The audio route module's pure parts: clean filter chains, the noise-floor estimate and
// loudnorm's JSON parsing. The ffmpeg runs are exercised against a live server, not here.
import assert from 'node:assert/strict'
import test from 'node:test'

import audioRoutes, { cleanChain, cleanFilter, floorOf, lastJson } from '../routes/audio.mjs'

test('clean chains honor default strength and detail, within afftdn limits', () => {
  assert.equal(cleanChain('denoise', -62.6), 'afftdn=nr=22.5:nf=-41:gs=3')
  assert.match(cleanChain('voice', -62.6), /^afftdn=nr=22.5:nf=-41:gs=3,highpass=f=80,lowpass=f=12000,acompressor=/)
  assert.equal(cleanChain('denoise', -200), 'afftdn=nr=22.5:nf=-80:gs=3')
  assert.equal(cleanChain('denoise', -20), 'afftdn=nr=22.5:nf=-30:gs=3')
  assert.equal(cleanChain('robot', -60), null)
})

test('noise floor: 10th percentile of window levels, digital silence ignored', () => {
  const levels = [-20, -18, -60, -61, -25, -22, -19, -21, -23, -24, -Infinity, NaN, -150]
  assert.equal(floorOf(levels), -60)
  assert.equal(floorOf([]), -80)
})

test('lastJson reads the measurement loudnorm prints after its log lines', () => {
  const stderr = '[Parsed_loudnorm_0 @ 0x1] \n{\n\t"input_i" : "-14.68",\n\t"input_tp" : "-5.15"\n}\n'
  assert.deepEqual(lastJson(stderr), { input_i: '-14.68', input_tp: '-5.15' })
  assert.throws(() => lastJson('no json here'))
})

test('the module registers its two routes', () => {
  const made = audioRoutes({})
  assert.deepEqual(Object.keys(made.routes).sort(), ['POST /api/audio/clean', 'POST /api/audio/loudnorm'])
})


test('each manual setting changes the checked processing plan and zero strength bypasses denoise', () => {
  const common = { strength: 1, detail: 0.5, quality: 'balanced' }
  assert.equal(cleanChain('denoise', -62.6, common), 'afftdn=nr=30:nf=-39:gs=3')
  assert.notEqual(cleanChain('denoise', -62.6, common), cleanChain('denoise', -62.6, { ...common, strength: 0.25 }))
  assert.notEqual(cleanChain('denoise', -62.6, common), cleanChain('denoise', -62.6, { ...common, detail: 1 }))
  assert.notEqual(cleanChain('denoise', -62.6, common), cleanChain('denoise', -62.6, { ...common, quality: 'high' }))
  assert.equal(cleanChain('denoise', -60, { strength: 0 }), 'anull')
  assert.match(cleanChain('voice', -60, { strength: 0 }), /^anull,highpass=/)
  for (const options of [{ strength: '1' }, { detail: NaN }, { quality: 'ultra' }, { strength: true }]) assert.throws(() => cleanChain('denoise', -60, options))
})

test('known noise profile primes analysis before processing the whole source with original timestamps', () => {
  const options = { strength: 0.8, detail: 0.7, quality: 'high', noiseFrom: 3.125, noiseTo: 3.625 }
  const args = cleanFilter('denoise', -65, options)
  assert.equal(args[0], '-filter_complex')
  assert.match(args[1], /atrim=start=3.125000:end=3.625000/)
  assert.match(args[1], /concat=n=2:v=0:a=1,asendcmd=c='0 afftdn sn start;0.500000 afftdn sn stop'/)
  assert.match(args[1], /afftdn=nr=24:nf=-43:gs=6,atrim=start=0.500000,asetpts=PTS-STARTPTS/)
  assert.deepEqual(args.slice(2), ['-map', '[clean]'])
})
