const transcriptStatuses = ['complete', 'ready', 'partial']
const navigationKey = s => JSON.stringify([s.page ?? null, s.openComp ?? null, s.selection ?? [], s.viewerMode ?? null])

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

export function shortsCapture(s, src, locale) {
  const asset = s.project?.assets?.[src]
  if (!asset?.hasAudio || !Number.isFinite(asset.duration) || asset.duration <= 0 || !Number.isSafeInteger(s.version) || s.version < 0) throw new Error('Open a project with a finite-duration audio source before making shorts.')
  return { root: s.root, project: s.project, version: s.version, scope: s.openComp ?? null, src, locale, asset: JSON.stringify(asset), navigation: navigationKey(s) }
}

export function shortsCaptureMatches(capture, s, src = capture.src, locale = capture.locale) {
  return s.root === capture.root && s.project === capture.project && s.version === capture.version && (s.openComp ?? null) === capture.scope && src === capture.src && locale === capture.locale && JSON.stringify(s.project?.assets?.[src]) === capture.asset
}

export function shortsNavigationMatches(capture, s) {
  return capture.root === s.root && capture.navigation === navigationKey(s)
}

export function shortsRanges(ranges, duration) {
  if (!Array.isArray(ranges) || !ranges.length || ranges.length > 20) throw new Error('Choose 1 to 20 source ranges.')
  return ranges.map((range, index) => {
    const from = Number(range.from), to = Number(range.to)
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || to - from > 600 || to > duration + 0.0001) throw new Error(`Clip ${index + 1} must stay inside the source and last at most 600 seconds.`)
    let name = ''
    for (const scalar of String(range.name ?? '').trim()) {
      if (name.length + scalar.length > 200) break
      name += scalar
    }
    return { from, to, name: name || `Clip ${index + 1}` }
  })
}

export function shortsTranscriptGuard(transcript, required = true) {
  const ready = transcriptStatuses.includes(transcript?.status) && Number.isSafeInteger(transcript?.revision) && transcript.revision > 0 && typeof transcript.fingerprint === 'string' && transcript.fingerprint.length > 0 && transcript.words?.length > 0
  if (!ready) {
    if (required) throw new Error('Reload a saved transcript before finding excerpts or including captions.')
    return {}
  }
  return { expectedSourceFingerprint: transcript.fingerprint, expectedTranscriptRevision: transcript.revision }
}

export function shortsReviewBody(capture, ranges, settings, transcript) {
  const [width, height] = settings.dimensions
  if (transcript && (transcript.src !== capture.src || transcript.locale !== Intl.getCanonicalLocales(capture.locale)[0])) throw new Error('Reload the transcript for this source and language before reviewing clips.')
  return { src: capture.src, locale: capture.locale, ranges: shortsRanges(ranges, JSON.parse(capture.asset).duration), width, height, captionStyle: settings.style, captions: settings.captions, reframe: 'subject', apply: false, expectedVersion: capture.version, ...shortsTranscriptGuard(transcript, settings.captions) }
}

export function shortsReview(capture, body, response) {
  const ranges = body.ranges, comps = response?.comps
  if (body.apply !== false || response?.version !== capture.version || !Array.isArray(comps) || comps.length !== ranges.length || !response.ops?.length || typeof response.sourceFingerprint !== 'string' || !response.sourceFingerprint || !Number.isSafeInteger(response.transcriptRevision) || response.transcriptRevision < 0 || (body.expectedSourceFingerprint !== undefined && response.sourceFingerprint !== body.expectedSourceFingerprint) || (body.expectedTranscriptRevision !== undefined && response.transcriptRevision !== body.expectedTranscriptRevision)) throw new Error('The project, source or transcript changed. Reload the transcript and review again.')
  for (let i = 0; i < ranges.length; i++) {
    const comp = comps[i], range = ranges[i]
    if (!comp.id || comp.name !== range.name || !Number.isFinite(comp.from) || !Number.isFinite(comp.to) || Math.abs(comp.from - range.from) > 0.0001 || Math.abs(comp.to - range.to) > 0.0001 || !Number.isFinite(comp.duration) || Math.abs(comp.duration - (range.to - range.from)) > 0.0001) throw new Error('The planned ranges changed. Review them again before creating.')
  }
  return { capture, version: response.version, body: freeze(structuredClone({ ...body, expectedSourceFingerprint: response.sourceFingerprint })), comps: freeze(structuredClone(comps)) }
}

export function shortsCreationBody(review, s, src, locale) {
  if (!review || !shortsCaptureMatches(review.capture, s, src, locale)) throw new Error('The project or source changed. Review the compositions again.')
  return { ...structuredClone(review.body), apply: true }
}

export function shortsEvidence(words, range) {
  return (words ?? []).filter(w => w.end > range.from && w.t < range.to).map(w => w.text).join(' ')
}
