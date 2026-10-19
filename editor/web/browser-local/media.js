import { ALL_FORMATS, AudioSampleSink, BlobSource, CanvasSink, Input, canEncodeAudio, canEncodeVideo } from '/vendor/mediabunny/dist/bundles/mediabunny.min.mjs'

const inputFor = file => new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
async function verifyVideoElement(file) {
  const element = document.createElement('video'), url = URL.createObjectURL(file)
  element.muted = true; element.preload = 'auto'
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Video preview could not load within 15 seconds. Try a browser-compatible MP4 or the native app.')), 15_000)
      const finish = error => { clearTimeout(timer); element.onloadeddata = element.onerror = null; error ? reject(error) : resolve() }
      element.onloadeddata = () => finish()
      element.onerror = () => finish(new Error('This browser cannot preview this video container. Try H.264 MP4 or the native Arya app.'))
      element.src = url; element.load()
    })
  } finally { element.pause(); element.removeAttribute('src'); element.load(); URL.revokeObjectURL(url) }
}
export async function probe(file) {
  if (!file.size) throw new Error('This file is empty.')
  if (/^image\//.test(file.type) || /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(file.name)) {
    const image = await createImageBitmap(file)
    try { return { hasVideo: true, hasAudio: false, still: true, width: image.width, height: image.height } }
    finally { image.close() }
  }
  const input = inputFor(file)
  try {
    const video = await input.getPrimaryVideoTrack(), audio = await input.getPrimaryAudioTrack()
    if (!video && !audio) throw new Error('This file has no supported video or audio track.')
    if (video && !await video.canDecode()) throw new Error('This browser cannot decode this video codec. Convert the original or use the native Arya app.')
    if (audio && !await audio.canDecode()) throw new Error('This browser cannot decode this audio codec. Convert the original or use the native Arya app.')
    const duration = await input.computeDuration()
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('This file has no valid duration.')
    if (video) await verifyVideoElement(file)
    const fps = video ? (await video.computePacketStats(100)).averagePacketRate : undefined
    return { hasVideo: !!video, hasAudio: !!audio, duration, ...(video ? { width: video.displayWidth, height: video.displayHeight, fps } : {}), ...(audio ? { sampleRate: audio.sampleRate, channels: audio.numberOfChannels } : {}) }
  } finally { input.dispose() }
}

export function wav(buffer) {
  const channels = buffer.numberOfChannels, frames = buffer.length, bytes = new Uint8Array(44 + frames * channels * 2), view = new DataView(bytes.buffer)
  const text = (offset, value) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)))
  text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true)
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true)
  text(36, 'data'); view.setUint32(40, frames * channels * 2, true)
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++) {
    const value = Math.max(-1, Math.min(1, buffer.getChannelData(channel)[frame])); view.setInt16(44 + (frame * channels + channel) * 2, value < 0 ? Math.round(value * 32768) : Math.round(value * 32767), true)
  }
  return new Blob([bytes], { type: 'audio/wav' })
}

export async function strip(file, asset, signal) {
  const count = asset.still ? 1 : 8, w = 320, h = Math.max(1, Math.round(w * asset.height / asset.width))
  const canvas = document.createElement('canvas'); canvas.width = w * count; canvas.height = h
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Thumbnail canvas is unavailable.')
  if (asset.still) {
    const image = await createImageBitmap(file)
    try { signal?.throwIfAborted(); context.drawImage(image, 0, 0, w, h) } finally { image.close() }
  } else {
    const input = inputFor(file)
    try {
      const track = await input.getPrimaryVideoTrack()
      const sink = new CanvasSink(track, { width: w, height: h, fit: 'contain' })
      for (let index = 0; index < count; index++) {
        signal?.throwIfAborted()
        const sample = await sink.getCanvas(Math.min(asset.duration - 0.001, asset.duration * (index + 0.5) / count))
        signal?.throwIfAborted()
        if (!sample) throw new Error('A thumbnail frame could not be decoded.')
        context.drawImage(sample.canvas, index * w, 0, w, h)
      }
    } finally { input.dispose() }
  }
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9))
  if (!blob) throw new Error('Thumbnails could not be encoded.')
  return { blob, w, h, count }
}

/** Decode only the requested source interval and retain its original timeline origin. */
export async function audioBuffer(file, from, duration, context, signal) {
  if (!Number.isFinite(from) || from < 0 || !Number.isFinite(duration) || duration <= 0 || duration > 900) throw new Error('Audio decoding needs a range of at most 15 minutes. Shorten this clip or export range.')
  const input = inputFor(file)
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track || !await track.canDecode()) throw new Error('The source audio cannot be decoded in this browser.')
    const rate = track.sampleRate, channels = track.numberOfChannels
    const length = Math.ceil(duration * rate)
    if (length * channels * 4 > 192 * 1024 * 1024) throw new Error('The selected audio interval exceeds browser memory limits. Shorten this clip.')
    const buffer = context.createBuffer(channels, length, rate), sink = new AudioSampleSink(track)
    for await (const sample of sink.samples(from, from + duration)) {
      try {
        signal?.throwIfAborted()
        const decoded = sample.toAudioBuffer(), start = Math.round((sample.timestamp - from) * rate)
        const skip = Math.max(0, -start), target = Math.max(0, start), count = Math.min(decoded.length - skip, length - target)
        if (count > 0) for (let channel = 0; channel < channels; channel++) buffer.copyToChannel(decoded.getChannelData(channel).subarray(skip, skip + count), channel, target)
      } finally { sample.close() }
    }
    signal?.throwIfAborted()
    return buffer
  } finally { input.dispose() }
}

export async function capabilities() {
  const canvas = document.createElement('canvas'), gl = canvas.getContext('webgl2')
  const gpu = !!gl; gl?.getExtension('WEBGL_lose_context')?.loseContext()
  const aac = await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000 }).catch(() => false)
  const h264 = gpu && aac && await canEncodeVideo('avc', { width: 1920, height: 1080, frameRate: 30, latencyMode: 'realtime' }).catch(() => false)
  const hevc = gpu && aac && await canEncodeVideo('hevc', { width: 1920, height: 1080, frameRate: 30, latencyMode: 'realtime' }).catch(() => false)
  return { gpu, aac, h264, hevc }
}

export async function peaks(file) {
  const input = inputFor(file), values = new Uint8Array(2048)
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track || !await track.canDecode()) return { peaks: [] }
    const duration = await track.computeDuration(), sink = new AudioSampleSink(track)
    for await (const sample of sink.samples()) {
      try {
        const audio = sample.toAudioBuffer()
        for (let frame = 0; frame < audio.length; frame += 32) {
          const bin = Math.min(values.length - 1, Math.floor((sample.timestamp + frame / audio.sampleRate) / duration * values.length))
          if (bin < 0) continue
          for (let channel = 0; channel < audio.numberOfChannels; channel++) values[bin] = Math.max(values[bin], Math.min(255, Math.round(Math.abs(audio.getChannelData(channel)[frame]) * 255)))
        }
      } finally { sample.close() }
    }
    return { peaks: [...values], perSec: values.length / duration }
  } finally { input.dispose() }
}
