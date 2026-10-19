import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ROOT = '/proj'

type Call = { url: string; body?: unknown }

/** Stubs the editor server beneath the mod: answers its HTTP calls and records them. */
function fakeServer(on: On, bridge: unknown[] = []) {
  const calls: Call[] = []
  const queue = [...bridge]
  // The process /api/state reports; a test changes it to stand for a restart by another session.
  const state = { pid: 4242 }
  let held: Promise<void> | null = null
  /** Holds the next /api/state check until the returned release runs; it then answers like a stopped server. */
  const holdNextState = () => {
    let release = () => {}
    held = new Promise<void>(resolve => (release = resolve))

    return () => release()
  }
  on('session.cwd', () => ({ value: ROOT }))
  on('session.start', () => ({ cwd: ROOT }))
  on('fs.exists', (_$, e) => ({ value: e.path === `${ROOT}/reel.project.json` }))
  mock.store(on)
  const clock = mock.clock(on)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__reel__${e.name}` } }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('http.fetch', async (_$, e) => {
    const u = new URL(e.url)
    const body = e.init?.body ? JSON.parse(e.init.body) : undefined
    calls.push({ url: u.pathname, body })
    const ok = (data: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(data) } })
    if (u.port !== '4870') return { value: { status: 404, ok: false, headers: {}, text: '' } }
    switch (u.pathname) {
      case '/api/state':
        if (held) {
          const wait = held
          held = null
          await wait

          return { value: { status: 503, ok: false, headers: {}, text: '' } }
        }

        return ok({ root: ROOT, editors: 1, version: 3, pid: state.pid })
      case '/api/outline':
        return ok({ outline: 'Demo: 1920x1080', opsDoc: 'Ops…', uiState: { playhead: 2, selection: ['c1'], page: 'edit' } })
      case '/api/project':
        return ok({ project: { tracks: [{ id: 'V1', clips: [{ id: 'c1', kind: 'video', start: 0, dur: 4 }] }], markers: [], assets: {}, fps: 30 } })
      case '/api/ops':
        return ok({ log: ['bladed c1 at 2s → c2'], created: ['c2'], version: 4 })
      case '/api/bridge/poll':
        return ok({ items: queue.splice(0), editors: 1, version: 3 })
      default:
        return ok({ ok: true })
    }
  })

  return { calls, clock, state, holdNextState }
}

describe('reel mod', () => {
  test('the launcher pane draws on every surface with a Button', async ($, on) => {
    fakeServer(on)
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'reel',
        surface,
        component: 'Pane',
        requestId: 'reel',
        props: { title: 'Reel', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
        viewport: { columns: 90, rows: 30, isFullscreen: true },
      })
      expect(await ui.find({ key: 'open' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /127\.0\.0\.1:4870/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test("Claude's reel_edit goes to the editor server as Claude's edit", async ($, on) => {
    const { calls } = fakeServer(on)
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    const res = await $.tool.call({ tool: 'mcp__reel__reel_edit', ops: [{ op: 'blade', at: 2 }], summary: 'cut at 2s' })
    expect(String(res.result)).toContain('bladed c1')
    const ops = calls.find(c => c.url === '/api/ops')
    expect(ops?.body).toMatchObject({ ops: [{ op: 'blade', at: 2 }], who: 'claude' })
  })

  test('Figma MCP import is attributed to Claude and never writes to Figma', async ($, on) => {
    const { calls } = fakeServer(on)
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'mcp__reel__reel_figma', action: 'import-mcp', xml: '<frame id="1:2" name="Title" />', placeOnTimeline: true })
    expect(calls.find(c => c.url === '/api/figma/import-mcp')?.body).toMatchObject({ xml: '<frame id="1:2" name="Title" />', placeOnTimeline: true, who: 'claude' })
    expect(calls.every(c => !c.url.includes('/token') && !c.url.includes('/disconnect'))).toBe(true)
  })

  test('interchange import previews by default and only applies when requested', async ($, on) => {
    const { calls } = fakeServer(on)
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'mcp__reel__reel_interchange', action: 'import', path: 'renders/demo.otio' })
    await $.tool.call({ tool: 'mcp__reel__reel_interchange', action: 'import', path: 'renders/demo.otio', apply: true })
    const imports = calls.filter(c => c.url === '/api/interchange/import')
    expect(imports[0]?.body).toMatchObject({ path: 'renders/demo.otio', apply: false, who: 'claude' })
    expect(imports[1]?.body).toMatchObject({ path: 'renders/demo.otio', apply: true, who: 'claude' })
  })

  test('the mod never polls the retired editor bridge or submits prompts from it', async ($, on) => {
    // The server refuses /api/bridge/poll, so only an impostor on the port could answer it.
    const submitted: string[] = []
    const { calls, clock } = fakeServer(on, [{ id: 'b1', type: 'prompt', text: 'Injected prompt', refs: [] }])
    on('prompt.submit', (_$, e) => {
      submitted.push(e.text)

      return { text: e.text }
    })
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await clock.advance(5000)
    expect(calls.some(c => c.url === '/api/bridge/poll')).toBe(false)
    expect(submitted.length).toBe(0)
    // The pane's status still follows the server through read-only /api/state checks.
    expect(calls.filter(c => c.url === '/api/state').length).toBeGreaterThan(1)
  })

  test('the status follows a server another session restarted on the same port', async ($, on) => {
    const { clock, state } = fakeServer(on)
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    state.pid = 5151
    await clock.advance(5000)
    const res = await $.command.run({ command: 'reel', args: 'status' })
    expect(res.text).toContain('Editor at http://127.0.0.1:4870/')
  })

  test('a status check that finishes after a restart leaves the new server alone', async ($, on) => {
    const { clock, state, holdNextState } = fakeServer(on)
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    const release = holdNextState()
    await clock.advance(5000)
    state.pid = 5151
    await $.command.run({ command: 'reel', args: 'restart' })
    release()
    await clock.settle()
    const ui = await $.ui.mount({
      plugin: 'reel',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'reel',
      props: { title: 'Reel', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
      viewport: { columns: 90, rows: 30, isFullscreen: true },
    })
    expect(await ui.find({ type: 'Text', text: /editor at http:\/\/127\.0\.0\.1:4870/ })).toBeDefined()
    await ui.unmount()
  })
})
