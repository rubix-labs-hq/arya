// AudioWorklet processors for Reel. They wrap the pure DSP in dsp.js, so what the tests measure
// in Node is what plays and exports.
//
//   reel-dynamics  compressor | gate | deesser | limiter (stereo, stereo-linked), params as k-rate AudioParams
//   reel-meter     pass-through meter: sample and true peak per channel, and optionally loudness
//                  (momentary, short-term, integrated, LRA); posts readings on its port

import { LoudnessMeter, makeDynamics, TruePeak } from './dsp.js'

const PARAMS = ['threshold', 'ratio', 'attack', 'release', 'knee', 'makeup', 'hold', 'range', 'lo', 'hi', 'ceiling']

/** Copies input 0 into a stereo output (mono goes to both sides). Returns false when there is no input. */
function copyIn(inputs, out) {
  const input = inputs[0]
  if (!input || input.length === 0) {
    out[0].fill(0)
    out[1]?.fill(0)

    return false
  }
  out[0].set(input[0])
  if (out[1]) out[1].set(input[1] ?? input[0])

  return true
}

class Dynamics extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return PARAMS.map(name => ({ name, defaultValue: 0, automationRate: 'k-rate' }))
  }

  constructor(options) {
    super()
    const { type, params } = options.processorOptions ?? {}
    this.params = { ...(params ?? {}) }
    this.dsp = makeDynamics(type, sampleRate, this.params)
    this.alive = Boolean(this.dsp)
    this.quiet = Infinity // samples since the last input
    this.tail = (this.dsp?.latency ?? 0) + 128
    this.port.onmessage = e => {
      if (e.data?.type === 'dispose') this.alive = false
    }
  }

  process(inputs, outputs, parameters) {
    if (!this.alive) return false
    const out = outputs[0]
    const n = out[0].length
    // Automation: a parameter that moved away from the current value updates the processor.
    let changed = false
    for (const name of PARAMS) {
      if (!(name in this.params)) continue
      const v = parameters[name]?.[0]
      if (v !== undefined && v !== this.params[name]) {
        this.params[name] = v
        changed = true
      }
    }
    if (changed) this.dsp.set(this.params)
    if (copyIn(inputs, out)) this.quiet = 0
    else if (this.quiet >= this.tail) return true
    else this.quiet += n
    const R = out[1] ?? new Float32Array(n)
    this.dsp.process(out[0], R, n)

    return true
  }
}

class Meter extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const o = options.processorOptions ?? {}
    this.loudness = o.loudness ? new LoudnessMeter(sampleRate, 2) : null
    this.tp = new TruePeak(2)
    this.every = Math.round(sampleRate * (o.interval ?? 0.1))
    this.count = 0
    this.alive = true
    this.resetPeaks()
    this.port.onmessage = e => {
      if (e.data?.type === 'reset') {
        this.loudness?.reset()
        this.resetPeaks()
      }
      if (e.data?.type === 'dispose') this.alive = false
    }
  }

  resetPeaks() {
    this.win = [0, 0] // true peak since the last report
    this.winSample = [0, 0]
    this.hold = [0, 0] // true peak since reset
  }

  process(inputs, outputs) {
    if (!this.alive) return false
    const out = outputs[0]
    const n = out[0].length
    copyIn(inputs, out)
    const chans = [out[0], out[1] ?? out[0]]
    this.loudness?.push(chans, n)
    for (let c = 0; c < 2; c++) {
      const data = chans[c]
      let sp = this.winSample[c]
      let tp = this.win[c]
      for (let i = 0; i < n; i++) {
        const x = data[i]
        const a = x < 0 ? -x : x
        if (a > sp) sp = a
        const t = this.tp.next(c, x)
        if (t > tp) tp = t
      }
      this.winSample[c] = sp
      this.win[c] = Math.max(tp, sp)
      if (this.win[c] > this.hold[c]) this.hold[c] = this.win[c]
    }
    this.count += n
    if (this.count >= this.every) {
      this.count = 0
      const m = this.loudness
      this.port.postMessage({
        samplePeak: this.winSample,
        truePeak: this.win,
        truePeakMax: this.hold,
        ...(m ? { momentary: m.momentary(), shortTerm: m.shortTerm(), integrated: m.integrated(), lra: m.lra() } : {}),
      })
      this.win = [0, 0]
      this.winSample = [0, 0]
    }

    return true
  }
}

registerProcessor('reel-dynamics', Dynamics)
registerProcessor('reel-meter', Meter)
