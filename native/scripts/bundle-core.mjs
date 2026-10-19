#!/usr/bin/env node
// Turns the shared core (editor/core/project.js and expr.js, ES modules) into one plain
// script for JavaScriptCore, which has no module loader. The script defines a global
// `ReelCore` with every export of project.js, plus a JSON-string API the Swift side calls
// (strings cross the JSContext boundary faster and without number mangling).
//
// node native/scripts/bundle-core.mjs --out <reel-core.js> [--parity <core-parity.json>]
//
// --parity also writes test cases: op sequences run through the ES modules in Node, with
// the exact JSON they produce, so ReelKit's tests can check JavaScriptCore gives the same.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE = path.resolve(HERE, '../../editor/core')
const ENTRY = 'project.js'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []))

/** Rewrites one module's import/export syntax into a function body that returns its exports. */
function linkModule(name, source) {
  const deps = []
  const exported = []
  const lines = source.split('\n').map((line, i) => {
    const where = `${name}:${i + 1}`
    const imp = /^import\s*\{([^}]*)\}\s*from\s*'\.\/([\w.-]+\.js)'\s*;?\s*$/.exec(line)
    if (imp) {
      deps.push(imp[2])
      const bindings = imp[1].split(',').map(s => s.trim()).filter(Boolean).map(b => {
        const m = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(b)
        if (!m) throw new Error(`${where}: unsupported import binding "${b}"`)

        return m[2] ? `${m[1]}: ${m[2]}` : m[1]
      })

      return `const { ${bindings.join(', ')} } = __modules[${JSON.stringify(imp[2])}]`
    }
    if (/^\s*import\b/.test(line) || /\bimport\s*\(/.test(line)) throw new Error(`${where}: only named imports of sibling modules are supported`)
    const exp = /^export\s+(async\s+function\*?|function\*?|const|let|var|class)\s+(\w+)/.exec(line)
    if (exp) {
      exported.push(exp[2])

      return line.replace(/^export\s+/, '')
    }
    if (/^\s*export\b/.test(line)) throw new Error(`${where}: unsupported export form`)

    return line
  })

  return { deps, exported, body: lines.join('\n') }
}

function collect(entries) {
  const order = []
  const seen = new Set()
  const visit = name => {
    if (seen.has(name)) return
    seen.add(name)
    const linked = linkModule(name, fs.readFileSync(path.join(CORE, name), 'utf8'))
    for (const dep of linked.deps) visit(dep)
    order.push({ name, ...linked })
  }
  for (const entry of entries) visit(entry)

  return order
}

// structuredClone is a WebCore API, not part of JavaScriptCore. The core only clones plain
// JSON-like data; this keeps `undefined` members the way structuredClone does.
const PRELUDE = `
const structuredClone = typeof globalThis.structuredClone === 'function' ? globalThis.structuredClone : function clone(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(clone)
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [clone(k), clone(v)]))
  if (value instanceof Set) return new Set([...value].map(clone))
  if (value instanceof Date) return new Date(value.getTime())
  const out = {}
  for (const key of Object.keys(value)) out[key] = clone(value[key])
  return out
}
`

// The JSON-string API ReelKit calls. Every function takes and returns strings.
const BRIDGE = `
  const core = __modules[${JSON.stringify(ENTRY)}]
  const interchange = __modules['interchange.js']
  const render = __modules['render-plan.js']
  const figma = __modules['figma-native.js']
  const audio = __modules['audio-plan.js']
  const shorts = __modules['shorts.js']
  const bridge = {
    /** Parses a project file's text and migrates it to the current format; compact JSON. */
    migrateJSON: text => JSON.stringify(core.migrate(JSON.parse(text))),
    /** Applies ops; returns { project, log, created } as compact JSON. Throws on a bad op. */
    applyOpsJSON: (projectJSON, opsJSON) => JSON.stringify(core.applyOps(JSON.parse(projectJSON), JSON.parse(opsJSON))),
    /** The same, as [projectJSON, logJSON, createdJSON], so the project text stays the core's own. */
    applyOpsParts: (projectJSON, opsJSON) => {
      const r = core.applyOps(JSON.parse(projectJSON), JSON.parse(opsJSON))
      return [JSON.stringify(r.project), JSON.stringify(r.log), JSON.stringify(r.created)]
    },
    /** One member of a JSON object, as JSON (null when absent). */
    field: (json, key) => JSON.stringify(JSON.parse(json)?.[key] ?? null),
    /** Media paths the ops name (src, set.src) that the project has not imported yet. */
    unknownSources: (projectJSON, opsJSON) => {
      const p = JSON.parse(projectJSON)
      const ops = JSON.parse(opsJSON) ?? []
      const srcs = new Set(ops.flatMap(o => [o?.src, o?.set?.src].filter(s => typeof s === 'string' && s)))
      const supplied = new Set(ops.filter(o => o?.op === 'import').flatMap(o => Object.keys(o.assets ?? {})))
      return JSON.stringify([...srcs].filter(s => !p.assets?.[s] && !supplied.has(s)))
    },
    /** Ops with an import of freshly probed assets in front, as the Node server does. */
    portableLibraryPlan: (itemJSON, resourcesJSON) => JSON.stringify(__modules['library-portable.js'].portableLibraryPlan(JSON.parse(itemJSON), JSON.parse(resourcesJSON))),
    remapPortableLibraryItem: (itemJSON, pathsJSON) => JSON.stringify(__modules['library-portable.js'].remapPortableLibraryItem(JSON.parse(itemJSON), JSON.parse(pathsJSON))),
    libraryLUTDependencies: (projectJSON, opJSON) => JSON.stringify(__modules['library.js'].libraryLUTDependencies(JSON.parse(projectJSON), JSON.parse(opJSON))),
    prependImport: (opsJSON, assetsJSON) => JSON.stringify([{ op: 'import', assets: JSON.parse(assetsJSON) }, ...(JSON.parse(opsJSON) ?? [])]),
    /** The project without the given assets (POST /api/forget). */
    forget: (projectJSON, pathsJSON) => {
      const p = structuredClone(JSON.parse(projectJSON))
      for (const src of JSON.parse(pathsJSON) ?? []) delete p.assets[src]
      return JSON.stringify(p)
    },
    /** One asset record as JSON, or null. */
    asset: (projectJSON, src) => JSON.stringify(JSON.parse(projectJSON).assets?.[src] ?? null),
    validateRecoveryProject: text => JSON.stringify(__modules['native-recovery-policy.js'].validateRecoveryProject(text)),
    mediaRestoreSource: (projectJSON, src) => JSON.stringify(__modules['media-restore.js'].mediaRestoreSource(JSON.parse(projectJSON), src)),
    mediaRestorePlan: (projectJSON, src, assetJSON, digest) => JSON.stringify(__modules['media-restore.js'].mediaRestorePlan(JSON.parse(projectJSON), src, JSON.parse(assetJSON), digest)),
    assetKeys: projectJSON => JSON.stringify(Object.keys(JSON.parse(projectJSON).assets ?? {})),
    newProjectJSON: (name, optionsJSON) => JSON.stringify(core.newProject(name, JSON.parse(optionsJSON || '{}'))),
    outline: projectJSON => core.outline(JSON.parse(projectJSON)),
    duration: projectJSON => core.duration(JSON.parse(projectJSON)),
    opsDocJSON: () => JSON.stringify(core.OPS_DOC),
    /** The file text the Node server writes: two-space JSON and a trailing newline. */
    fileText: projectJSON => JSON.stringify(JSON.parse(projectJSON), null, 2) + '\\n',
    exportInterchange: (projectJSON, root, bodyJSON) => {
      const project = JSON.parse(projectJSON), b = JSON.parse(bodyJSON), warnings = []
      const p = b.comp ? { ...core.compView(project, b.comp), name: project.comps[b.comp].name } : project
      let text
      if (b.format === 'fcpxml') text = interchange.toFCPXML(p, root, { warnings })
      else if (b.format === 'otio') text = JSON.stringify(interchange.toOTIO(p, root, { warnings }), null, 4) + '\\n'
      else if (b.format === 'srt' || b.format === 'vtt') {
        if (!interchange.captionItems(p, b.track).length) throw new Error('the caption track has no captions to export')
        text = b.format === 'srt' ? interchange.toSRT(p, b.track) : interchange.toVTT(p, b.track)
      } else throw new Error('format must be fcpxml, otio, srt or vtt')
      return JSON.stringify({ text, warnings })
    },
    importInterchange: (text, format, root) => {
      if (format === 'srt' || format === 'vtt') return JSON.stringify({ captions: format === 'srt' ? interchange.parseSRT(text) : interchange.parseVTT(text) })
      const warnings = []
      const project = format === 'otio' ? interchange.fromOTIO(text, root, { warnings }) : interchange.fromFCPXML(text, root, { warnings })
      return JSON.stringify({ project, warnings })
    },
    transcriptCaptions: (projectJSON, src, wordsJSON, bodyJSON) => JSON.stringify(shorts.captionItems(JSON.parse(projectJSON), src, JSON.parse(wordsJSON), JSON.parse(bodyJSON))),
    clipSource: (projectJSON, id) => core.findClip(JSON.parse(projectJSON), id)?.clip?.src ?? '',
    framePlan: (projectJSON, at, comp) => JSON.stringify(render.framePlan(core.migrate(JSON.parse(projectJSON)), at, comp || null)),
    transcriptDeleteOps: (projectJSON, bodyJSON) => JSON.stringify(shorts.transcriptDeleteOps(core.migrate(JSON.parse(projectJSON)), JSON.parse(bodyJSON))),
    proposeShorts: (wordsJSON, bodyJSON) => JSON.stringify(shorts.proposeShorts(JSON.parse(wordsJSON), JSON.parse(bodyJSON))),
    buildShortsOps: (projectJSON, bodyJSON) => JSON.stringify(shorts.buildShortsOps(core.migrate(JSON.parse(projectJSON)), JSON.parse(bodyJSON))),
    audioPlan: (projectJSON, from, to) => JSON.stringify(audio.audioPlan(core.migrate(JSON.parse(projectJSON)), from, to)),
    figmaAssets: (nodesJSON, optionsJSON) => JSON.stringify(figma.nativeFigmaAssets(JSON.parse(nodesJSON), JSON.parse(optionsJSON || '{}'))),
    figmaImport: (projectJSON, nodesJSON, bodyJSON) => JSON.stringify(figma.nativeFigmaImport(JSON.parse(projectJSON), JSON.parse(nodesJSON), JSON.parse(bodyJSON || '{}'))),
    lookLUT: optionsJSON => JSON.stringify(__modules['look-lut.js'].lookLUT(JSON.parse(optionsJSON))),
    /** The assistant's plain description of the selection, playhead, layers and mix. */
    describeFocus: (projectJSON, optionsJSON) => __modules['describe.js'].describeFocus(core.migrate(JSON.parse(projectJSON)), JSON.parse(optionsJSON || '{}')),
    describeRequest: (projectJSON, optionsJSON) => __modules['describe.js'].describeRequest(core.migrate(JSON.parse(projectJSON)), JSON.parse(optionsJSON || '{}')),
    /** Requests that fit the selection or the timeline, shared with the web panel. */
    /** A preview step's plain description, or {error} when it cannot run against the project. */
    describeStep: (projectJSON, stepJSON) => { try { return JSON.stringify(__modules['assistant-steps.js'].describeStep(core.migrate(JSON.parse(projectJSON)), JSON.parse(stepJSON))) } catch (error) { return JSON.stringify({ error: String(error.message ?? error) }) } },
    previewStepRoutesJSON: () => JSON.stringify({ routes: __modules['assistant-steps.js'].PREVIEW_STEP_ROUTES, waits: __modules['assistant-steps.js'].PREVIEW_STEP_WAITS }),
    assistantSuggestions: (projectJSON, optionsJSON) => JSON.stringify(__modules['assistant-suggestions.js'].assistantSuggestions(core.migrate(JSON.parse(projectJSON)), JSON.parse(optionsJSON || '{}'))),
  }
  return Object.freeze(Object.assign({}, core, { expr: __modules['expr.js'], bridge }))
`

export function bundle() {
  const modules = collect([ENTRY, 'interchange.js', 'render-plan.js', 'figma-native.js', 'audio-plan.js', 'shorts.js', 'look-lut.js', 'media-restore.js', 'native-recovery-policy.js', 'library-portable.js', 'describe.js', 'assistant-suggestions.js', 'assistant-steps.js'])
  const parts = modules.map(m => `__modules[${JSON.stringify(m.name)}] = (function () {\n${m.body}\nreturn { ${m.exported.join(', ')} }\n})()\n`)

  return `// Generated by native/scripts/bundle-core.mjs from editor/core (${modules.map(m => m.name).join(', ')}). Do not edit.
var ReelCore = (function () {
'use strict'
${PRELUDE}
const __modules = {}
${parts.join('\n')}
${BRIDGE}
})()
`
}

/** Op sequences for the parity test, with what the ES modules make of them. */
async function parityCases() {
  const core = await import(pathToFileURL(path.join(CORE, ENTRY)).href)
  const base = core.newProject('Parity', { width: 1920, height: 1080, fps: 30 })
  base.assets = {
    'media/a.mp4': { duration: 10, width: 1920, height: 1080, fps: 30, codec: 'h264', hasVideo: true, hasAudio: true },
    'media/b.mp4': { duration: 8, width: 1280, height: 720, fps: 25, codec: 'h264', hasVideo: true, hasAudio: false },
    'media/m.m4a': { duration: 30, codec: 'aac', hasVideo: false, hasAudio: true },
  }
  const sequences = [
    [{ op: 'append', src: 'media/a.mp4', track: 'V1', dur: 4 }, { op: 'append', src: 'media/b.mp4', track: 'V1', dur: 3 }],
    [{ op: 'append', src: 'media/a.mp4', dur: 5 }, { op: 'blade', at: 1.5 }, { op: 'ripple_delete', ids: ['c1'] }],
    [{ op: 'append', src: 'media/a.mp4', dur: 5 }, { op: 'update', id: 'c1', set: { x: 400, scale: 1.5, opacity: 0.8, grade: { exposure: 0.5, look: 'warm' } } }],
    [{ op: 'add_title', text: 'Hello', start: 1, dur: 3, title: { anim: 'rise' } }, { op: 'expression', id: 'c1', prop: 'rotation', expr: 'wiggle(2, 10)' }],
    [{ op: 'append', src: 'media/a.mp4', dur: 4 }, { op: 'append', src: 'media/b.mp4', dur: 4 }, { op: 'precompose', ids: ['c1', 'c2'], name: 'Group' }],
    [{ op: 'add_shape', shape: { type: 'star', width: 300 }, start: 0, dur: 2 }, { op: 'add_mask', id: 'c1', mask: { type: 'ellipse', feather: 20 } }],
    [{ op: 'append', src: 'media/m.m4a', track: 'A1', dur: 6 }, { op: 'markers', markers: [{ t: 1, label: 'beat' }, { t: 2.5, label: 'drop' }] }],
    [{ op: 'captions', items: [{ t: 0, end: 1.2, text: 'Hello' }, { t: 1.2, end: 2, text: 'there' }] }],
  ]
  const cases = []
  for (const ops of sequences) {
    let expected
    try {
      expected = JSON.stringify(core.applyOps(base, ops))
    } catch (error) {
      expected = { error: String(error.message) }
    }
    cases.push({ ops: JSON.stringify(ops), expected })
  }
  const bad = [{ op: 'update', id: 'c999', set: { x: 1 } }]
  let badError = null
  try {
    core.applyOps(base, bad)
  } catch (error) {
    badError = String(error.message)
  }

  return {
    project: JSON.stringify(base),
    cases,
    failing: { ops: JSON.stringify(bad), error: badError },
    fileText: `${JSON.stringify(base, null, 2)}\n`,
    outline: core.outline(base),
    opsDoc: JSON.stringify(core.OPS_DOC),
    newProject: JSON.stringify(core.newProject('Fresh', { width: 1080, height: 1920, fps: 25 })),
    migrated: JSON.stringify(core.migrate({ version: 1, name: 'Old', width: 640, height: 360, fps: 24, tracks: [] })),
  }
}

async function main() {
  if (!args.out) throw new Error('usage: bundle-core.mjs --out <file> [--parity <file>]')
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true })
  const text = bundle()
  // Write only on change, so Xcode does not see a fresh resource on every build.
  if (!fs.existsSync(args.out) || fs.readFileSync(args.out, 'utf8') !== text) fs.writeFileSync(args.out, text)
  if (args.parity) {
    fs.mkdirSync(path.dirname(path.resolve(args.parity)), { recursive: true })
    fs.writeFileSync(args.parity, `${JSON.stringify(await parityCases(), null, 1)}\n`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`bundle-core: ${error.message}`)
    process.exit(1)
  })
}
