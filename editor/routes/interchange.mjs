// Interchange routes: export the timeline as FCPXML, OpenTimelineIO, a CMX 3600 EDL, SRT or WebVTT into
// renders/, read those formats back (a preview, or a replacement of the project through
// an op), list interchange files in the project folder, and turn a clip's transcript into
// captions placed where the clip sits on the timeline.
//
//   POST /api/interchange/export { format: fcpxml|otio|edl|srt|vtt, track?, name? }  → { path, warnings }
//        (track names the caption track for srt/vtt and the video track for edl)
//   POST /api/interchange/import { path, apply?, track?, replace?, expectedVersion?, expectedInputHash? }
//        timeline files → { project, missing, warnings } (with apply: the project replaces the current one)
//        .srt/.vtt      → { captions } (with apply: a captions op on `track`, replacing it when `replace`)
//   GET  /api/interchange/files?dir=&kind=timeline|captions|all                   → { dir, entries }
//   POST /api/captions/from-transcript { src | id, apply?, track?, replace?, maxChars?, maxLines?, maxDur?, minGap? }
//        → { src, items, placed, clips, words }

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { captionItems, fromFCPXML, fromOTIO, parseSRT, parseVTT, toFCPXML, toOTIO, toSRT, toVTT, transcriptToCaptions } from '../core/interchange.js'
import { compView, findClip } from '../core/project.js'
import { guardedOutput } from '../core/output-path.js'
import { toEDL } from '../core/edl.js'
import { createExportDestination, exportSourceReferences } from '../core/export-cohort.mjs'

const EXTENSIONS = { fcpxml: 'fcpxml', otio: 'otio', edl: 'edl', srt: 'srt', vtt: 'vtt' }
const LISTED = {
  captions: /\.(srt|vtt)$/i,
  timeline: /\.(fcpxml|fcpxmld|otio|xml)$/i,
  all: /\.(srt|vtt|fcpxml|fcpxmld|otio|xml)$/i,
}
const MAX_BYTES = 64 * 1024 * 1024

export default ctx => {
  const { ROOT } = ctx

  const inside = rel => {
    const abs = path.resolve(ROOT, String(rel ?? ''))
    if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) throw new Error('that path is outside the project folder')
    // Follow symlinks before trusting the path; a missing file is checked through its folder.
    const present = file => { try { fs.lstatSync(file); return true } catch { return false } }
    let existing = abs
    while (!present(existing) && existing !== ROOT) existing = path.dirname(existing)
    const real = fs.realpathSync(existing), root = fs.realpathSync(ROOT)
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error('that path is outside the project folder')

    return abs
  }

  const current = () => {
    const p = ctx.getProject()
    if (!p) throw new Error('No project yet: create one first')

    return p
  }

  // Calls this server's own API, for what routeCtx does not expose (/api/analyze, /api/import).
  // node:http sends no Origin header, so the server's same-origin check lets it through.
  const callSelf = (req, route, body) => {
    if (ctx.callAPI) return ctx.callAPI('POST', route, body)
    let port = Number(String(req?.headers?.host ?? '').split(':').pop())
    if (!port) {
      try {
        port = JSON.parse(fs.readFileSync(path.join(ctx.DOT, 'server.json'), 'utf8')).port
      } catch {}
    }
    if (!port) return Promise.reject(new Error('cannot find the Reel server port'))

    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body)
      const request = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          let json = {}
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {}
          if (res.statusCode >= 400) reject(new Error(json.error ?? `${route} answered ${res.statusCode}`))
          else resolve(json)
        })
      })
      request.on('error', reject)
      request.end(data)
    })
  }

  /** Reads an interchange file inside the project; an .fcpxmld bundle reads its Info.fcpxml. */
  const readInterchange = rel => {
    let file = inside(rel)
    if (!fs.existsSync(file)) throw new Error(`no file ${rel}`)
    if (fs.statSync(file).isDirectory()) {
      if (!/\.fcpxmld$/i.test(file)) throw new Error(`${rel} is a folder: pick a file`)
      file = path.join(file, 'Info.fcpxml')
      if (!fs.existsSync(file)) throw new Error(`${rel} has no Info.fcpxml`)
    }
    ctx.checkAgentFile?.(file)
    // A bundle's inner file can itself be a link; it must stay inside the project too.
    inside(path.relative(ROOT, file))
    if (fs.statSync(file).size > MAX_BYTES) throw new Error(`${rel} is larger than 64 MB`)
    ctx.checkAgentFile?.(file)
    const text = fs.readFileSync(file, 'utf8')
    const sourceHash = createHash('sha256').update(text).digest('hex')
    const sourcePath = fs.realpathSync(file)
    const name = path.basename(rel)
    if (/\.(srt|vtt)$/i.test(name)) return { kind: 'captions', vtt: /\.vtt$/i.test(name), text, name, sourceHash, sourcePath }
    if (/\.otio$/i.test(name)) return { kind: 'otio', text, name, sourceHash, sourcePath }
    if (/\.(fcpxml|fcpxmld|xml)$/i.test(name)) {
      if (!/<fcpxml[\s>]/.test(text)) throw new Error(`${name} is not FCPXML (Final Cut Pro 7 and Premiere XML are not supported)`)

      return { kind: 'fcpxml', text, name, sourceHash, sourcePath }
    }
    throw new Error(`${name}: Reel reads .fcpxml, .fcpxmld, .otio, .srt and .vtt`)
  }

  const captionOptions = body => Object.fromEntries(['maxChars', 'maxLines', 'maxDur', 'minGap'].filter(k => Number.isFinite(Number(body[k])) && body[k] !== null && body[k] !== '').map(k => [k, Number(body[k])]))

  return {
    routes: {
      'POST /api/interchange/export': async body => {
        const project = current()
        const composition = body.comp ? project.comps?.[body.comp] : null
        const p = body.comp ? { ...compView(project, body.comp), name: composition.name } : project
        const format = String(body.format ?? '').toLowerCase()
        if (!EXTENSIONS[format]) throw new Error('format must be fcpxml, otio, edl, srt or vtt')
        const warnings = []
        let text
        if (format === 'fcpxml') text = toFCPXML(p, ROOT, { warnings })
        else if (format === 'otio') text = `${JSON.stringify(toOTIO(p, ROOT, { warnings }), null, 4)}\n`
        else if (format === 'edl') text = toEDL(p, ROOT, { warnings, track: body.track })
        else {
          if (!captionItems(p, body.track).length) throw new Error(body.track ? `caption track ${body.track} has no captions` : 'the project has no captions to export')
          text = format === 'srt' ? toSRT(p, body.track) : toVTT(p, body.track)
        }
        const base = String(body.name ?? p.name ?? 'reel').replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '') || 'reel'
        const dir = guardedOutput(ROOT, path.join(ROOT, 'renders'))
        fs.mkdirSync(dir, { recursive: true })
        const file = guardedOutput(ROOT, path.join(dir, `${base}.${EXTENSIONS[format]}`))
        ctx.assertCurrent?.()
        const destination = createExportDestination(ROOT, file, { references: exportSourceReferences(project) })
        try {
          fs.writeFileSync(destination.output, text, { flag: 'wx', mode: 0o600 })
          ctx.assertCurrent?.()
          destination.publish()
        } finally { destination.cleanup() }
        const rel = path.relative(ROOT, file)
        ctx.pushActivity('reel', `exported ${rel}${warnings.length ? ` (${warnings.length} note${warnings.length === 1 ? '' : 's'})` : ''}`)

        return { path: rel, warnings }
      },

      'POST /api/interchange/import': async (body, _query, req) => {
        if (body.expectedVersion !== undefined && (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0)) throw new Error('expectedVersion must be a nonnegative safe integer')
        const file = readInterchange(body.path)
        if (body.apply && body.expectedInputHash !== undefined && body.expectedInputHash !== file.sourceHash) throw new Error('The interchange input changed. Preview it again before applying.')
        const receipt = { sourceHash: file.sourceHash, sourcePath: path.relative(ROOT, file.sourcePath) }
        const validateInput = () => {
          const latest = readInterchange(body.path)
          if (latest.sourcePath !== file.sourcePath || latest.sourceHash !== file.sourceHash) throw new Error('The interchange input changed. Preview it again before applying.')
        }
        const who = body.who ?? 'you'
        // Applying reads media asynchronously. Commit only to the version the import started from,
        // so an edit made in the meantime is reported instead of silently replaced.
        const startVersion = ctx.getVersion?.()
        if (body.apply && body.expectedVersion !== undefined && body.expectedVersion !== startVersion) throw new Error('The project changed. Preview the import again before applying it.')
        const versioned = startVersion === undefined ? {} : { expectedVersion: startVersion }
        if (file.kind === 'captions') {
          const captions = file.vtt ? parseVTT(file.text) : parseSRT(file.text)
          if (!captions.length) throw new Error(`no captions found in ${file.name}`)
          if (!body.apply) return { captions, version: startVersion, ...receipt }
          validateInput()
          const res = await ctx.editOps([{ op: 'captions', items: captions, track: body.track, replace: Boolean(body.replace) }], who, `${captions.length} captions from ${file.name}`, versioned)

          return { captions, applied: true, version: res.version, ...receipt }
        }
        const warnings = []
        const project = file.kind === 'otio' ? fromOTIO(file.text, ROOT, { warnings }) : fromFCPXML(file.text, ROOT, { warnings })
        const absOf = key => (path.isAbsolute(key) ? key : path.join(ROOT, key))
        const missing = Object.keys(project.assets).filter(key => !fs.existsSync(absOf(key)))
        if (!body.apply) return { project, missing, warnings, version: startVersion, ...receipt }

        // Read the real media inside the project; media elsewhere keeps what the file declared.
        const probed = []
        for (const key of Object.keys(project.assets)) {
          const abs = absOf(key)
          if (missing.includes(key) || !abs.startsWith(ROOT + path.sep)) continue
          try {
            project.assets[key] = await ctx.probe(key)
            probed.push(key)
          } catch (error) {
            warnings.push(`could not read ${key}: ${error.message}`)
          }
        }
        const clips = project.tracks.reduce((n, t) => n + t.clips.length, 0)
        validateInput()
        const res = await ctx.editOps([{ op: 'replace', project }], who, `imported ${file.name} (${clips} clip${clips === 1 ? '' : 's'})`, versioned)
        let version = res.version
        // A replace op does not start proxies; /api/import does, for media whose codec needs one.
        const needProxy = probed.filter(key => project.assets[key].proxy && !fs.existsSync(path.join(ROOT, project.assets[key].proxy)))
        if (needProxy.length) {
          try {
            version = (await callSelf(req, '/api/import', { paths: needProxy, who: 'reel' })).version ?? version
          } catch (error) {
            warnings.push(`proxies were not started: ${error.message}`)
          }
        }

        return { project: ctx.getProject(), applied: true, version, missing, probed, warnings, ...receipt }
      },

      'GET /api/interchange/files': (_body, query) => {
        const dir = inside(query.get('dir') ?? '.')
        const match = LISTED[query.get('kind') ?? 'all'] ?? LISTED.all
        const rel = path.relative(ROOT, dir)
        const entries = fs.readdirSync(dir, { withFileTypes: true })
          .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
          .map(e => ({ name: e.name, dir: e.isDirectory() && !/\.fcpxmld$/i.test(e.name), path: path.join(rel, e.name) }))
          .filter(e => e.dir || match.test(e.name))
          .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))

        return { dir: rel, entries }
      },

      'POST /api/captions/from-transcript': async (body, _query, req) => {
        if (ctx.transcripts) return ctx.transcripts.captions(body)
        const p = current()
        const src = body.src ?? (body.id ? findClip(p, body.id)?.clip?.src : undefined)
        if (!src) throw new Error('give src (a media path) or id (a clip that plays media)')
        const transcript = await callSelf(req, '/api/analyze', { src, kind: 'transcript' })
        const words = transcript.words ?? []
        const { items, placed, clips } = transcriptToCaptions(p, src, words, { id: body.id, ...captionOptions(body) })
        if (!items.length) throw new Error(`the transcript of ${src} has no words${body.id ? ` inside ${body.id}` : ''}`)
        if (!body.apply) return { src, items, placed, clips, words: words.length }
        const res = await ctx.editOps([{ op: 'captions', items, track: body.track, replace: Boolean(body.replace) }], body.who ?? 'you', `${items.length} captions from the transcript of ${path.basename(src)}`)

        return { src, items, placed, clips, words: words.length, applied: true, version: res.version }
      },
    },
  }
}
