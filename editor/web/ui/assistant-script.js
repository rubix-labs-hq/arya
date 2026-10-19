export const SCRIPT_BYTE_LIMIT = 512 * 1024
export const SCRIPT_CHARACTER_LIMIT = 128000

export function assistantDraft(state) {
  return state.assistantDraft?.root === state.root ? state.assistantDraft : { root: state.root, text: '', inputKind: 'prompt' }
}

export function updatedAssistantDraft(state, text, inputKind = assistantDraft(state).inputKind) {
  if (!['prompt', 'script', 'screenplay'].includes(inputKind)) throw new Error('Choose Prompt, Script or Screenplay.')
  return { root: state.root, text, inputKind }
}

export function assistantDraftContext(state) {
  return { root: state.root, project: state.project, version: state.version, comp: state.openComp ?? null, draft: state.assistantDraft }
}

export function assistantDraftIsCurrent(context, state) {
  return state.root === context.root && state.project === context.project && state.version === context.version &&
    (state.openComp ?? null) === context.comp && state.assistantDraft === context.draft
}

export async function readAssistantScript(file) {
  if (!file || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > SCRIPT_BYTE_LIMIT) throw new Error('Choose a nonempty text file no larger than 512 KiB.')
  if (!/\.(txt|md|fountain|script|screenplay)$/i.test(file.name ?? '') || file.type && !['text/plain', 'text/markdown', 'text/x-markdown', 'application/octet-stream'].includes(file.type)) throw new Error('Use a plain UTF-8 .txt, .md, .fountain, .script or .screenplay file.')
  const bytes = await file.arrayBuffer()
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 1 || bytes.byteLength > SCRIPT_BYTE_LIMIT) throw new Error('Choose a nonempty text file no larger than 512 KiB.')
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new Error('The file must contain valid UTF-8 text.') }
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text)) throw new Error('The file contains binary or unsupported control characters. Export it as plain UTF-8 text.')
  if (!text.trim() || text.length > SCRIPT_CHARACTER_LIMIT) throw new Error('Use nonempty text with at most 128000 characters.')
  return text
}

export function createAssistantScriptImport({ state, commit, report, reading, read = readAssistantScript }) {
  let request = null, disposed = false
  const current = captured => !disposed && request === captured && state().chatOpen !== false && assistantDraftIsCurrent(captured.context, state())
  const cancel = (captured = request) => { if (request !== captured) return; request = null; if (!disposed) reading(false) }
  return {
    begin() {
      cancel()
      if (disposed || !state().project) return
      request = { context: assistantDraftContext(state()), inputKind: assistantDraft(state()).inputKind }
      return request
    },
    async consume(file, captured = request) {
      if (!captured || !current(captured)) { cancel(captured); return }
      if (!file) { cancel(captured); return }
      reading(true)
      try {
        const text = await read(file)
        if (!current(captured)) return
        const inputKind = captured.inputKind === 'screenplay' ? 'screenplay' : 'script'
        commit(updatedAssistantDraft(state(), text, inputKind))
        report('The file is in your draft. Review it before sending.')
      } catch (error) {
        if (current(captured)) report(error.message || 'The text file could not be read.', 'error')
      } finally {
        if (request === captured) cancel()
      }
    },
    cancel,
    dispose() { cancel(); disposed = true },
  }
}
