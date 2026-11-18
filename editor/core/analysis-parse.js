// Reads what ffmpeg prints for the loudness and silence analyses of POST /api/analyze, and holds
// the help text GET /api/caps gives for them. Kept apart from server.mjs so both are tested
// against recorded ffmpeg output without starting a process.

/** The summary `ebur128=peak=true:framelog=quiet` prints once a run ends. */
export function parseLoudness(stderr) {
  const summary = String(stderr ?? '').split('Summary:').pop() ?? ''
  const number = pattern => { const match = pattern.exec(summary); return match && Number.isFinite(Number(match[1])) ? Number(match[1]) : undefined }
  // ffmpeg prints the peak of silence as -inf, which JSON cannot carry.
  const silent = /Peak:\s*-inf dBFS/.test(summary)
  return { lufs: number(/\bI:\s*([-\d.]+) LUFS/), lra: number(/\bLRA:\s*([-\d.]+) LU\b/), truePeak: number(/\bPeak:\s*([-\d.]+) dBFS/), ...(silent ? { silent: true } : {}) }
}

/**
 * The [start, end] pairs `silencedetect` logs. With a range, ffmpeg counts from the start of the
 * range, so `offset` (the range's `in`) puts the pairs back in source seconds.
 */
export function parseSilence(stderr, offset = 0) {
  const at = value => Math.round((value + offset) * 1e6) / 1e6
  const ranges = []
  let open = null
  for (const line of String(stderr ?? '').split('\n')) {
    const start = /silence_start:\s*([-\d.]+)/.exec(line)
    const end = /silence_end:\s*([\d.]+)/.exec(line)
    if (start) open = Math.max(0, Number(start[1]))
    if (end && open !== null) {
      ranges.push([at(open), at(Number(end[1]))])
      open = null
    }
  }
  return ranges
}

/** True when ffmpeg read no sound at all, as it does for a range past the end of the file. */
export const measuredNothing = stderr => /Output file is empty, nothing was encoded/.test(String(stderr ?? ''))

// What GET /api/caps says about measuring sound. test/analysis-range.test.mjs checks each
// statement against the server and the edit model.
export const ANALYSIS_HELP = Object.freeze({
  loudness: 'POST /api/analyze {src, kind:"loudness", in?, dur?} measures the sound of one media file and writes no file. It returns lufs (integrated loudness, LUFS), lra (loudness range, LU) and truePeak (dBTP), or silent:true with no truePeak when that part has no sound. in and dur are source seconds and limit the measurement to that part of the file.',
  silence: 'POST /api/analyze {src, kind:"silence", noise?, min?, in?, dur?} returns ranges [[start,end]] in source seconds and writes no file. Sound below noise (dB, default -32) for at least min seconds (default 0.45) counts as silence. Raise noise toward -25 for a noisy recording; lower min to catch shorter pauses. in and dur limit the search to that part of the file.',
  clip: 'A timeline clip that is not reversed or frozen plays its source from clip.in for clip.dur * speed seconds, and speed is 1 unless set. Source second s plays at timeline second clip.start + (s - clip.in) / speed.',
  mix: 'Both measure one source file, not the timeline mix with its volumes and effects. To measure the mix, export it with the audio-wav preset and analyze the output of the finished job.',
})
