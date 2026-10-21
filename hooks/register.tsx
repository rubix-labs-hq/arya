// Reel: a video editor you can direct. This mod runs the Reel editor (a local web app
// with a GPU compositor, timeline, color, audio and delivery pages), gives Claude tools
// that edit the same project live. Editor chat starts a separate CLI run.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ReelLogEntry, ReelRef, ReelServer } from '../types'

type $ = EngineInterface

const PANE = 'reel'
const TOOL_PREFIX = 'mcp__reel__'
const BASE_PORT = 4870
const PATH_ENV = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'

const isOn = atom({ plugin: 'reel', key: 'isOn' } as const, false)
const serverAtom = atom({ plugin: 'reel', key: 'server' } as const, null)
const log = atom({ plugin: 'reel', key: 'log' } as const, [])
const isWorking = atom({ plugin: 'reel', key: 'isWorking' } as const, false)

const TOOLS = [
  {
    name: 'reel_get',
    description:
      "Reel video editor: read the timeline the user is editing. Returns an outline (tracks, clip ids, times, sources, effects), the editor's playhead and selection, the full op reference for reel_edit, and the project JSON. Call this first.",
    inputSchema: { type: 'object', properties: { json: { type: 'boolean', description: 'Include the full project JSON (default true)' } } },
  },
  {
    name: 'reel_edit',
    description:
      'Reel video editor: apply editing operations to the timeline, all or nothing; the user sees them land live in the editor and can undo them. Ops include append/insert/overwrite/connect, blade, trim (ripple), roll, slip, slide, move, lift/ripple_delete/delete_range, speed, freeze, transition, effect, keyframe (with easing), update (transform, crop, blend, opacity, volume, pan, eq, fades, grade with lift/gamma/gain/offset/curves/LUT/looks, chroma key), add_title, add_color, adjustment, markers, tracks, range, project. Linked video and audio move together: trim, roll or slide a linked clip once, not once per partner; a second call for the partner moves the pair twice (unlinked:true edits one side). The exact op shapes are in reel_get output.',
    inputSchema: {
      type: 'object',
      properties: {
        ops: { type: 'array', items: { type: 'object' }, description: 'Operations to apply in order' },
        summary: { type: 'string', description: "One line describing the edit, shown in the editor's activity" },
      },
      required: ['ops'],
    },
  },
  {
    name: 'reel_frame',
    description: 'Reel video editor: render the composited frame at a timeline time to a PNG (same renderer as export) and return its path. Read the PNG to see the frame. Pass comp to render one composition on its own (time is then composition time).',
    inputSchema: { type: 'object', properties: { at: { type: 'number', description: "Timeline seconds; default the editor's playhead" }, width: { type: 'number', description: 'Pixel width, default 1280' }, comp: { type: 'string', description: 'A composition id (k1, …) to render instead of the main timeline' } } },
  },
  {
    name: 'reel_import',
    description: 'Reel video editor: add media to the project (files or whole folders, relative to the project folder); returns duration, size, fps, codec and audio for each. With list=true, only lists media files in the folder.',
    inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } }, folder: { type: 'string' }, list: { type: 'boolean' } } },
  },
  {
    name: 'reel_analyze',
    description: "Reel video editor: analyze a media file. kind: scenes (cut times), silence (silent ranges), beats (beat times and BPM), loudness (integrated LUFS), transcript (word timings; needs whisper.cpp). Times are source seconds; map them to the timeline through the clip's start/in/speed.",
    inputSchema: { type: 'object', properties: { src: { type: 'string' }, kind: { type: 'string', enum: ['scenes', 'silence', 'beats', 'loudness', 'transcript'] }, threshold: { type: 'number' }, noise: { type: 'number' }, min: { type: 'number' } }, required: ['src', 'kind'] },
  },
  {
    name: 'reel_render',
    description: 'Reel video editor: export the timeline (or its in/out range) and wait for it. preset: h264-high (default), h264-web, h264-fast, hevc, prores-422, prores-422hq, prores-4444, gif, audio-wav, audio-m4a, png-seq.',
    inputSchema: { type: 'object', properties: { preset: { type: 'string' }, name: { type: 'string' }, width: { type: 'number' }, from: { type: 'number' }, to: { type: 'number' } } },
  },
  {
    name: 'reel_figma',
    description: 'Reel video editor: read Figma connection status, browse frames, or import copies as editable compositions. Uses the user\'s connected account for frames/import; import-mcp accepts XML or a node tree from Figma MCP without an account token. These actions never change the source Figma file. Set mode=smartAnimate and a second frame to animate A to B.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'frames', 'import', 'import-mcp'] },
        url: { type: 'string' }, fileKey: { type: 'string' }, nodeId: { type: 'string' }, toNodeId: { type: 'string' },
        mode: { type: 'string', enum: ['comp', 'smartAnimate'] },
        xml: { type: 'string' }, nodes: { type: 'object' }, toXml: { type: 'string' }, toNodes: { type: 'object' },
        assets: { type: 'object', description: 'Map of Figma node ids to exported asset URLs' },
        compName: { type: 'string' }, duration: { type: 'number' }, transition: { type: 'number' }, ease: { type: 'string' },
        placeOnTimeline: { type: 'boolean' }, start: { type: 'number' },
      }, required: ['action'],
    },
  },
  {
    name: 'reel_interchange',
    description: 'Reel video editor: export FCPXML, OpenTimelineIO, a CMX 3600 EDL (one video track, named by track), SRT or WebVTT; list project interchange files; preview or apply an import; or generate captions from a clip transcript. Import and captions default to a preview. Set apply=true to make an undoable edit; timeline imports replace the project. Return warnings and missing media to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['files', 'export', 'import', 'captions'] },
        format: { type: 'string', enum: ['fcpxml', 'otio', 'edl', 'srt', 'vtt'] }, name: { type: 'string' },
        path: { type: 'string' }, dir: { type: 'string' }, kind: { type: 'string', enum: ['timeline', 'captions', 'all'] },
        apply: { type: 'boolean' }, replace: { type: 'boolean' }, track: { type: 'string' },
        src: { type: 'string' }, id: { type: 'string' }, maxChars: { type: 'number' }, maxLines: { type: 'number' }, maxDur: { type: 'number' }, minGap: { type: 'number' },
      }, required: ['action'],
    },
  },
  {
    name: 'reel_new',
    description: 'Reel video editor: start a new empty project (replaces the current one; the old one stays in undo history).',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' }, fps: { type: 'number' } } },
  },
] as const

// Module variables reset on reload; what the pane draws lives in $.state.
let root = ''
let port = BASE_PORT
let configOn = true
let toolsRegistered = false
let statusTimer: { cancel: () => void } | null = null

// ---------------------------------------------------------------- server

/** The nearest folder at or above the working directory holding a reel.project.json, else the working directory. */
async function projectRoot($: $): Promise<string> {
  const cwd = await $.session.cwd()
  let dir = cwd
  while (dir && dir !== '/') {
    if (await $.fs.exists(`${dir}/reel.project.json`)) return dir
    dir = dir.slice(0, dir.lastIndexOf('/')) || '/'
  }

  return cwd
}

function url(path = '') {
  return `http://127.0.0.1:${port}${path}`
}

async function call($: $, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await $.http.fetch(url(path), body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(res.text) as Record<string, unknown>
  } catch {
    data = { error: res.text.slice(0, 300) }
  }
  if (!res.ok) throw new Error(String(data.error ?? `${path} → HTTP ${res.status}`))

  return data
}

async function stateAt($: $, p: number): Promise<{ root?: string; editors?: number; version?: number; pid?: number } | null> {
  try {
    const res = await $.http.fetch(`http://127.0.0.1:${p}/api/state`)

    return res.ok ? (JSON.parse(res.text) as { root?: string }) : null
  } catch {
    return null
  }
}

/** Finds this project's running server, or starts one on a free port. */
async function ensureServer($: $): Promise<ReelServer> {
  for (let p = BASE_PORT; p < BASE_PORT + 20; p++) {
    const st = await stateAt($, p)
    if (st?.root === root) {
      port = p
      const server = { port: p, url: url('/'), isRunning: true, editors: st.editors ?? 0, version: st.version ?? 0, pid: st.pid }
      await update($, serverAtom, () => server)
      watchServer($)

      return server
    }
  }
  let free = BASE_PORT
  while (free < BASE_PORT + 20 && (await stateAt($, free))) free++
  port = free
  const editor = `${$.plugin.root}/editor/server.mjs`
  await $.process.run(['/bin/mkdir', '-p', `${root}/.reel`])
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  await $.process.run(['/bin/sh', '-c', `PATH=${PATH_ENV}:$PATH nohup node ${q(editor)} --root ${q(root)} --port ${free} --plugin true >> ${q(`${root}/.reel/server.log`)} 2>&1 &`])
  for (let i = 0; i < 50; i++) {
    const st = await stateAt($, free)
    if (st?.root === root) {
      const server = { port: free, url: url('/'), isRunning: true, editors: 0, version: st.version ?? 0, pid: st.pid }
      await update($, serverAtom, () => server)
      watchServer($)
      await note($, 'reel', `editor server started on port ${free}`)

      return server
    }
    await pause($, 0.15)
  }
  throw new Error(`the Reel server did not start; see ${root}/.reel/server.log`)
}

/** Waits by running `sleep`: unlike $.clock.sleep, a $ call in flight costs no hook budget. */
async function pause($: $, seconds: number) {
  await $.process.run(['/bin/sleep', String(seconds)])
}

async function stopServer($: $) {
  try {
    await call($, '/api/shutdown', {})
  } catch {}
  await update($, serverAtom, () => null)
}

async function note($: $, who: ReelLogEntry['who'], text: string) {
  await update($, log, list => [...list, { who, text }].slice(-20))
}

async function openEditor($: $) {
  const server = await ensureServer($)
  await claudeStatus($, 'idle')
  await $.process.run(['/usr/bin/open', server.url])

  return server
}

async function registerTools($: $) {
  if (toolsRegistered) return
  for (const tool of TOOLS) await $.tool.register({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })
  toolsRegistered = true
}

/** Keeps the pane's server status current. It reads /api/state only and accepts it only for this project. */
async function refreshServer($: $) {
  const server = await read($, serverAtom)
  if (!server) return
  const st = await stateAt($, server.port)
  // A server for this project answers here, even if another session restarted it under a new pid.
  const next = st?.root === root ? { ...server, isRunning: true, editors: st.editors ?? 0, version: st.version ?? 0, pid: st.pid } : { ...server, isRunning: false }
  // A stop or restart may have replaced the server while this check ran; leave that state alone.
  if (next.isRunning !== server.isRunning || next.editors !== server.editors || next.version !== server.version || next.pid !== server.pid) await update($, serverAtom, current => (current?.port === server.port && current?.pid === server.pid ? next : current))
}

function watchServer($: $) {
  if (!statusTimer) statusTimer = $.clock.every(5000, () => void refreshServer($))
}

async function setOn($: $, enabled: boolean) {
  await $.store.set('reel:on', enabled)
  await update($, isOn, () => enabled)
  if (enabled) {
    await registerTools($)
    await ensureServer($)
    watchServer($)
    await $.ui.open({ id: PANE, title: 'Reel' })
  } else {
    statusTimer?.cancel()
    statusTimer = null
    await stopServer($)
    await $.ui.close({ id: PANE })
  }
  $.ui.status(enabled ? '🎬 Reel' : undefined)
}

// ---------------------------------------------------------------- bridge


async function describeRefs($: $, refs: readonly ReelRef[]): Promise<string[]> {
  if (!refs.length) return []
  type Track = { id: string; clips: { id: string }[] }
  const data = (await call($, '/api/project')) as { project?: { tracks: Track[]; comps?: Record<string, { tracks?: Track[] }>; markers: { id: string }[]; assets: Record<string, unknown>; fps: number } }
  const p = data.project
  const lines: string[] = []
  // Clips inside compositions are found too, and described as the inspector shows them.
  const scopes: [string | null, Track[]][] = [[null, p?.tracks ?? []], ...Object.entries(p?.comps ?? {}).map(([id, comp]): [string, Track[]] => [id, comp.tracks ?? []])]
  for (const ref of refs) {
    if (ref.kind === 'clip') {
      const found = scopes.flatMap(([comp, tracks]) => tracks.flatMap(track => track.clips.filter(c => c.id === ref.id).map(clip => ({ comp, track, clip }))))[0]
      let detail = ''
      try { detail = String(((await call($, `/api/describe?ids=${encodeURIComponent(ref.id)}`)) as { text?: string }).text ?? '') } catch {}
      lines.push(`- clip ${ref.id} on ${found?.track.id ?? '?'}${found?.comp ? ` in composition ${found.comp}` : ''}: ${JSON.stringify(found?.clip)}${detail ? `\n  ${detail.replace(/\n/g, '\n  ')}` : ''}`)
    } else if (ref.kind === 'frame' || ref.kind === 'time' || ref.kind === 'scope') {
      // ids: "12.5", "12.5@640,360" (frame point), "V1@12.5" (track time), "waveform@12.5"
      const parts = ref.id.split('@')
      const numeric = parts.map(Number).find(n => Number.isFinite(n))
      const point = ref.kind === 'frame' ? parts[1] : undefined
      let shot = ''
      if (numeric !== undefined) {
        try {
          const r = (await call($, '/api/frame', { at: numeric, width: 1280 })) as { path?: string }
          shot = r.path ? ` The frame is rendered at ${r.path} (read it to see it).` : ''
        } catch {}
      }
      lines.push(`- ${ref.label}${point ? ` (pixel ${point} in project coordinates)` : ''}.${shot}`)
    } else if (ref.kind === 'track') {
      const track = p?.tracks.find(t => t.id === ref.id)
      lines.push(`- track ${ref.id}: ${JSON.stringify({ ...track, clips: track?.clips.map(c => c.id) })}`)
    } else if (ref.kind === 'marker') {
      lines.push(`- marker ${ref.id}: ${JSON.stringify(p?.markers.find(m => m.id === ref.id))}`)
    } else if (ref.kind === 'media') {
      lines.push(`- media ${ref.id}: ${JSON.stringify(p?.assets[ref.id])}`)
    } else {
      lines.push(`- ${ref.kind} ${ref.id} (${ref.label})`)
    }
  }

  return lines
}

async function claudeStatus($: $, state: string, text = '') {
  try {
    await call($, '/api/bridge/claude', { state, text })
  } catch {}
}

// ---------------------------------------------------------------- tools

async function runTool($: $, name: string, input: Record<string, unknown>): Promise<string> {
  await ensureServer($)
  switch (name) {
    case 'reel_get': {
      const o = (await call($, '/api/outline')) as { outline: string; opsDoc: string; uiState: unknown; focus?: string }
      const parts = [o.outline, ...(o.focus ? [`Editor focus (selection, playhead and the layers under it):\n${o.focus}`] : []), `Editor state: ${JSON.stringify(o.uiState)}`, o.opsDoc]
      if (input.json !== false) {
        const p = await call($, '/api/project')
        parts.push(`Project JSON (${root}/reel.project.json):\n${JSON.stringify(p.project)}`)
      }

      return parts.join('\n\n')
    }
    case 'reel_edit': {
      const ops = input.ops
      if (!Array.isArray(ops) || ops.length === 0) throw new Error('ops must be a non-empty array')
      await claudeStatus($, 'working', String(input.summary ?? `editing (${ops.length} ops)…`))
      const r = (await call($, '/api/ops', { ops, who: 'claude', summary: input.summary, returnProject: false })) as { log: string[]; created: string[]; version: number }
      const o = (await call($, '/api/outline')) as { outline: string }
      await note($, 'claude', String(input.summary ?? r.log.at(-1) ?? 'edited'))

      return `${r.log.join('\n')}\ncreated: ${r.created.join(', ') || 'none'}\n\n${o.outline}`
    }
    case 'reel_frame': {
      await claudeStatus($, 'working', 'looking at a frame…')
      const r = (await call($, '/api/frame', { at: input.at, width: input.width ?? 1280, comp: input.comp })) as { path: string; at: number }

      return `Rendered ${r.at}s to ${r.path}. Read that file to see the frame.`
    }
    case 'reel_import': {
      if (input.list) {
        const r = (await call($, `/api/files?dir=${encodeURIComponent(String(input.folder ?? '.'))}`)) as { entries: { name: string; dir: boolean }[] }

        return r.entries.map(e => `${e.dir ? '[dir] ' : ''}${e.name}`).join('\n') || 'no media here'
      }
      const paths = (input.paths as string[] | undefined) ?? (input.folder ? [String(input.folder)] : [])
      const r = (await call($, '/api/import', { paths, who: 'claude' })) as { assets: Record<string, unknown> }

      return Object.entries(r.assets).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n') || 'nothing imported'
    }
    case 'reel_analyze': {
      await claudeStatus($, 'working', `analyzing ${String(input.src).split('/').pop()} (${String(input.kind)})…`)
      const r = await call($, '/api/analyze', input)

      return JSON.stringify(r).slice(0, 20000)
    }
    case 'reel_render': {
      await claudeStatus($, 'working', 'rendering…')
      const range = typeof input.from === 'number' && typeof input.to === 'number' ? { in: input.from, out: input.to } : undefined
      const job = (await call($, '/api/export', { preset: input.preset ?? 'h264-high', name: input.name, width: input.width, range })) as { id: string }
      // Long-polls the server: time inside a $ call does not count against the hook's budget.
      for (let i = 0; i < 80; i++) {
        const j = (await call($, `/api/jobs/wait?id=${job.id}&timeout=25000`)) as { state: string; output?: string; error?: string; progress?: number }
        if (j.state === 'done') return `Exported ${root}/${j.output}`
        if (j.state === 'failed') throw new Error(j.error ?? 'render failed')
        await claudeStatus($, 'working', `rendering ${Math.round((j.progress ?? 0) * 100)}%…`)
      }
      throw new Error('render still running after 30 minutes; check the Deliver page')
    }
    case 'reel_new': {
      const r = (await call($, '/api/new', { ...input, who: 'claude' })) as { project: { name: string } }

      return `New project ${r.project.name}.`
    }
    case 'reel_figma': {
      const { action, ...body } = input
      if (!['status', 'frames', 'import', 'import-mcp'].includes(String(action))) throw new Error('unknown Figma action')
      const r = await call($, `/api/figma/${action}`, action === 'status' ? undefined : { ...body, who: 'claude' })
      return JSON.stringify(r)
    }
    case 'reel_interchange': {
      const { action, ...body } = input
      if (!['files', 'export', 'import', 'captions'].includes(String(action))) throw new Error('unknown interchange action')
      const query = new URLSearchParams({ dir: String(body.dir ?? '.'), kind: String(body.kind ?? 'all') })
      const route = action === 'files' ? `/api/interchange/files?${query}` : action === 'captions' ? '/api/captions/from-transcript' : `/api/interchange/${action}`
      const r = await call($, route, action === 'files' ? undefined : { ...body, apply: body.apply === true, who: 'claude' })
      return JSON.stringify(r)
    }
  }
  throw new Error(`unknown Reel tool ${name}`)
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on, options) => {
  configOn = (options as { enabled?: boolean }).enabled !== false

  on('session.start', async ($, e, next) => {
    root = await projectRoot($)
    const stored = await $.store.get('reel:on')
    const enabled = configOn && stored !== false
    await update($, isOn, () => enabled)
    await $.command.register({
      name: 'reel',
      description: 'Reel video editor: open it, or on | off | restart | status',
      argumentHint: '[on|off|open|restart|status]',
    })
    if (enabled) {
      await registerTools($)
      $.ui.status('🎬 Reel')
      // Reconnect to a server this project already runs; do not start one unasked.
      for (let p = BASE_PORT; p < BASE_PORT + 20; p++) {
        const st = await stateAt($, p)
        if (st?.root === root) {
          port = p
          await update($, serverAtom, () => ({ port: p, url: url('/'), isRunning: true, editors: st.editors ?? 0, version: st.version ?? 0, pid: st.pid }))
          watchServer($)
          break
        }
      }
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {

    return next(e)
  })

  on('command.run', { command: 'reel' }, async ($, e) => {
    const verb = e.args.trim().split(/\s+/)[0] ?? ''
    if (!configOn && verb !== 'status') return { text: 'Reel is turned off in the config menu (reel.enabled). Turn it on there first.' }
    try {
      if (verb === 'off') {
        await setOn($, false)

        return { text: 'Reel is off: the editor server stopped, Claude has no Reel tools to use, and editor chat is unavailable. /reel on brings it back.' }
      }
      if (verb === 'status') {
        await refreshServer($)
        const server = await read($, serverAtom)

        return { text: `Reel is ${(await read($, isOn)) ? 'on' : 'off'}. ${server?.isRunning ? `Editor at ${server.url} (${server.editors} open).` : 'Editor server not running.'}` }
      }
      if (verb === 'restart') {
        await stopServer($)
        await pause($, 0.4)
      }
      if (!(await read($, isOn))) await setOn($, true)
      const server = await openEditor($)
      await $.ui.open({ id: PANE, title: 'Reel' })

      return { text: `Reel editor open at ${server.url} (project: ${root}).` }
    } catch (error) {
      return { text: `Reel: ${error instanceof Error ? error.message : String(error)}`, exitCode: 1 }
    }
  })

  on('tool.check', async ($, e, next) => {
    if (typeof e.tool === 'string' && e.tool.startsWith(TOOL_PREFIX) && (await read($, isOn))) return { decision: 'allow', reason: 'Reel editor tool' }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (!tool.startsWith(TOOL_PREFIX)) return next(e)
    if (!(await read($, isOn))) return { deny: 'The Reel editor is turned off. The user can run /reel on to enable it.' }
    await update($, isWorking, () => true)
    try {
      return { result: await runTool($, tool.slice(TOOL_PREFIX.length), e as Record<string, unknown>) }
    } catch (error) {
      return { isError: true, result: `Reel: ${error instanceof Error ? error.message : String(error)}` }
    } finally {
      await update($, isWorking, () => false)
      await claudeStatus($, 'idle')
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!(await read($, isOn))) return next(e)
    const fromEditor = e.origin.kind === 'plugin' && e.origin.name === 'reel'
    const context = [...(e.context ?? [])]
    if (!fromEditor) {
      // @c3, @m1, @V2 in a typed prompt attach that item from the editor's project.
      const ids = [...e.text.matchAll(/@([cm]\d+a?|[VA]\d+)\b/g)].map(m => m[1]!)
      if (ids.length) {
        try {
          const refs: ReelRef[] = ids.map(id => ({ kind: /^[VA]/.test(id) ? 'track' : id.startsWith('m') ? 'marker' : 'clip', id, label: id }))
          context.push(`Reel editor references:\n${(await describeRefs($, refs)).join('\n')}`)
        } catch {}
      }
    }

    return next(context.length === (e.context?.length ?? 0) ? e : { ...e, context })
  })

  // ---------------------------------------------------------------- launcher pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const enabled = await read($, isOn)
    const server = await read($, serverAtom)
    const entries = await read($, log)
    const working = await read($, isWorking)
    if (!enabled) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>Reel is off.</Text>
          <Button key="on" label="Turn Reel on" variant="primary" onPress={() => void setOn($, true)} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Text bold color="#f5b942">
            🎬 REEL
          </Text>
          <Text dimColor>{server?.isRunning ? `editor at ${server.url}` : 'editor not running'}</Text>
        </Box>
        <Text dimColor>
          {server?.isRunning ? `${server.editors} editor window${server.editors === 1 ? '' : 's'} open · project v${server.version}` : 'Open it to start editing.'}
          {working ? ' · Claude is editing' : ''}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button key="open" label="Open editor" variant="primary" hotkey="o" onPress={() => void openEditor($).catch(err => $.ui.toast(`Reel: ${String(err)}`))} />
          <Button key="restart" label="Restart server" onPress={() => void stopServer($).then(() => openEditor($)).catch(err => $.ui.toast(`Reel: ${String(err)}`))} />
          <Button key="off" label="Turn off" dimColor onPress={() => void setOn($, false)} />
        </Box>
        <Box flexDirection="column">
          {entries.slice(-6).map(entry => (
            <Text dimColor wrap="truncate">
              {entry.who === 'claude' ? '✦' : entry.who === 'you' ? '•' : '·'} {entry.text}
            </Text>
          ))}
        </Box>
        <Text dimColor>The editor's ✦ Claude panel talks to this session. ⌥-click anything in the editor to attach it.</Text>
      </Box>
    )
  })
}
