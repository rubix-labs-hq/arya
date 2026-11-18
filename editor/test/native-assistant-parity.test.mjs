import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { FOCUS_GUIDE, INSTRUCTIONS, READS, REVIEW_GUIDE, TOOLS, WRITES } from '../agent/protocol.mjs'

const swift = name => fs.readFileSync(new URL(`../../native/${name}`, import.meta.url), 'utf8')
const assistant = swift('ReelKit/Sources/ReelKit/Assistant.swift')

/** A Swift raw multi-line string literal, with the closing delimiter's indentation removed. */
function rawLiteral(source, name) {
  const start = source.indexOf(`static let ${name} = #"""\n`)
  assert.ok(start >= 0, `${name} literal`)
  const body = source.slice(start + `static let ${name} = #"""\n`.length, source.indexOf('"""#', start))
  const lines = body.split('\n'), indent = lines.pop()
  assert.match(indent, /^ *$/)
  return lines.map(line => line.startsWith(indent) ? line.slice(indent.length) : line).join('\n')
}

test('the native API-key assistant gives agents the same instructions and guides as protocol.mjs', () => {
  assert.equal(rawLiteral(assistant, 'instructions'), INSTRUCTIONS)
  assert.equal(rawLiteral(assistant, 'focusGuide'), FOCUS_GUIDE)
  assert.equal(rawLiteral(assistant, 'reviewGuide'), REVIEW_GUIDE)
  assert.match(assistant, /\(\[instructions\] \+ \(focus \? \[focusGuide\] : \[\]\) \+ \(review \? \[reviewGuide\] : \[\]\)\)\.joined\(separator: "\\n"\)/, 'joined as promptFor joins them')
  assert.match(assistant, /<immutable_reel_context>\\n\{\\"context\\":\\\(JSON\(any: contextFields\)\.text\),\\"outline\\":\\\(context\.text\)\}\\n<\/immutable_reel_context>\\n\\n<user_request>\\n\\\(prompt\)\\n<\/user_request>/, 'and wraps the request as promptFor does')
})

test('the native tools describe themselves as the shared tools do', () => {
  const start = assistant.indexOf('private static let tools: JSON = .raw(#"') + 'private static let tools: JSON = .raw(#"'.length
  const tools = JSON.parse(assistant.slice(start, assistant.indexOf('"#)', start)))
  assert.deepEqual(tools.map(tool => tool.name), TOOLS.map(tool => tool.name))
  for (const tool of tools) {
    const shared = TOOLS.find(item => item.name === tool.name)
    assert.equal(tool.description, shared.description, tool.name)
    assert.deepEqual(Object.keys(tool.input_schema.properties).sort(), Object.keys(shared.inputSchema.properties).sort(), tool.name)
  }
})

test('the native allowlist includes the assistant routes the shared guides name', () => {
  const reads = assistant.match(/let reads: Set<String> = \[([^\]]*)\]/)[1], writes = assistant.match(/let writes: Set<String> = \[([^\]]*)\]/)[1]
  const list = text => [...text.matchAll(/"([^"]+)"/g)].map(match => match[1])
  for (const route of ['/api/describe']) assert.ok(list(reads).includes(route) && READS.has(route), route)
  for (const route of ['/api/assistant/propose', '/api/ui/show', '/api/luts/inspect', '/api/luts/apply']) assert.ok(list(writes).includes(route) && WRITES.has(route), route)
  const panel = swift('App/Shared/NativeAssistant.swift')
  assert.match(panel, /if route == "\/api\/assistant\/propose" \{ return try await stageProposal/)
  assert.match(panel, /if route == "\/api\/ui\/show" \{ return try showInEditor/)
  const backend = swift('ReelKit/Sources/ReelKit/ReelBackend.swift')
  assert.match(backend, /case \("GET", "\/api\/describe"\):/)
  assert.match(backend, /\("focus", project\.flatMap \{ try\? core\.describeFocus/)
})

test('native preview steps are the shared preview step routes', async () => {
  const { PREVIEW_STEP_ROUTES } = await import('../core/assistant-steps.js')
  const native = swift('App/Shared/NativeAssistant.swift').match(/static let previewStepRoutes = \[([^\]]*)\]/)[1]
  assert.deepEqual([...native.matchAll(/"([^"]+)"/g)].map(match => match[1]), PREVIEW_STEP_ROUTES)
})

// The app target has no XCTest bundle, so these check its wiring in source. ReelKit's
// AssistantChangeTests cover AssistantBase and the processing owners themselves.
const between = (source, from, to) => {
  const start = source.indexOf(from)
  assert.ok(start >= 0, from)
  return source.slice(start, source.indexOf(to, start + from.length))
}

test('closing a project clears native previews, and a preview applies only to the project it was made on', () => {
  const app = swift('App/Shared/NativeAssistant.swift'), panel = swift('App/Shared/NativeEditor/NativeAssistantPanel.swift')
  assert.match(between(app, '    func reset() {', '\n    }\n'), /clearPreviewState\(\)/)
  const clear = between(app, '    func clearPreviewState() {', '\n    }\n')
  for (const field of ['proposal = nil', 'applyingProposal = nil', 'lastChange = nil', 'previewRunID = nil', 'runBaseline = nil']) assert.ok(clear.includes(field), field)
  const apply = between(app, '    func applyProposal() async {', '\n    }\n')
  const check = apply.indexOf('await backend.isCurrent(staged.base)')
  assert.ok(check > 0 && apply.indexOf('staged.base.belongs(to: backend)') < check, 'apply checks the backend and the exact project')
  assert.ok(check < apply.indexOf('backend.handle('), 'before anything commits')
  assert.ok(apply.indexOf('request["who"] = "agent"') > 0, 'steps run as the assistant')
  assert.ok(apply.indexOf('guard self.session?.backend === backend else { return }') < apply.indexOf('lastChange = '), 'a switched project gets no change')
  assert.match(between(app, '    func canUndoLastChange(version: Int) -> Bool {', '\n    }\n'), /session\?\.backend\.map\(ObjectIdentifier\.init\) == change\.backend/)
  assert.match(panel, /stale: assistant\.proposalStale \|\| proposal\.baseVersion != model\.version/)
  assert.match(panel, /\.task\(id: proposalKey\) \{ await assistant\.refreshProposalCurrency\(\) \}/)
})

test('native proposals keep the agent’s step request and fill the range again on every call, as the browser does', () => {
  const stage = between(swift('App/Shared/NativeAssistant.swift'), '    private func stageProposal(', '\n    }\n')
  assert.match(stage, /"body": \$0\["request"\] \?\? \$0\["body"\] \?\? \[:\]/, 'earlier steps go back to their request')
  assert.match(stage, /allSteps\[index\]\["request"\] = allSteps\[index\]\["body"\]; allSteps\[index\]\["body"\] = completed/)
  assert.match(stage, /let summaries = held \+ \(summary\.isEmpty \|\| held\.contains\(summary\) \? \[\] : \[summary\]\)/, 'a repeated summary is kept once, as the browser keeps it')
})

test('a native request that only pressed Undo or Redo is recorded as a history move and titled by it', () => {
  const app = swift('App/Shared/NativeAssistant.swift'), panel = swift('App/Shared/NativeEditor/NativeAssistantPanel.swift')
  assert.match(app, /agentAttributed: Set<String> = \["\/api\/ops", "\/api\/undo", "\/api\/redo",/, 'the agent’s Undo and Redo are its own commits')
  assert.match(app, /guard agentAttributed\.contains\(route\), var fields = try\? JSON\.parse\(body \?\? "\{\}"\)/, 'Undo and Redo send no body, so one is made')
  const record = between(app, '    func recordRunChange(', '\n    }\n')
  assert.match(record, /let moves = await backend\.historyMoves\(after: baseline\.version\) \?\? \[\]/)
  assert.match(record, /kind: moves\.isEmpty \? "request" : "history"/)
  assert.match(panel, /\$0\.kind == "history" \? ReelBackend\.historyChangeTitle\(moves: \$0\.moves\)/)
})

test('a stopped native request that changed nothing says so', () => {
  const app = swift('App/Shared/NativeAssistant.swift'), panel = swift('App/Shared/NativeEditor/NativeAssistantPanel.swift')
  const record = between(app, '    func recordRunChange(', '\n    }\n')
  assert.ok(record.indexOf('lastRunEdited = nil') < record.indexOf('guard let baseline'), 'an unknown run is not reported as unchanged')
  assert.match(record, /lastRunEdited = version > baseline\.version/)
  // A Stop clears activeID first, so the run's task returns before recordRunChange; Stop measures the run itself.
  const cancel = between(app, '    func cancel() {', '\n    }\n')
  assert.ok(cancel.indexOf('let stoppedRun = activeID') >= 0 && cancel.indexOf('let stoppedRun = activeID') < cancel.indexOf('activeID = nil'), 'Stop notes the run before clearing it')
  assert.ok(cancel.indexOf('lastRunEdited = nil') < cancel.indexOf('stoppingTask = Task'), 'an earlier run’s answer is cleared at once')
  const measured = cancel.indexOf('self.lastRunEdited = version > baseline.version')
  assert.ok(measured > cancel.indexOf('await runningTask?.value') && measured < cancel.indexOf('self.state = failed'), 'after the run ends and before it reads Stopped')
  assert.match(cancel, /let baseline = self\.runBaseline, baseline\.id == stoppedRun/, 'only for the run that was stopped')
  const send = between(app, '        activeID = id\n', 'publish()')
  assert.match(send, /lastRunEdited = nil/, 'a new run starts unknown')
  assert.match(between(app, '    func clearPreviewState() {', '\n    }\n'), /lastRunEdited = nil/)
  // Undo then Redo in one request leaves the project as it was, so there is no change to undo.
  assert.match(record, /guard version > baseline\.version, let after = await backend\.currentProject\(\), after != baseline\.project else \{ return \}/)
  assert.match(panel, /let stoppedNote = assistant\.lastRunEdited == false \? "Nothing was changed\." : "Review or undo any committed edits\."/)
  assert.match(panel, /stopped \? stoppedNote : ""/)
  assert.match(panel, /assistant\.state == "cancelled" \? "Stopped\. \\\(stoppedNote\)"/)
})

test('a native request waits while a preview is applying, as the browser does', () => {
  const app = swift('App/Shared/NativeAssistant.swift'), panel = swift('App/Shared/NativeEditor/NativeAssistantPanel.swift')
  const send = between(app, '    func send(_ text: String', 'let referenceText')
  assert.match(send, /guard applyingProposal\.map\(\{ \$0\.finished \}\) \?\? true else \{ throw ReelBackend\.APIError\("Wait for the preview to finish applying/)
  assert.match(between(panel, '    private var canSendDraft: Bool {', '\n    }\n'), /assistant\.applyingProposal\.map \{ \$0\.finished \} \?\? true/)
})
