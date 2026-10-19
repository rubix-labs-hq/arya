// The editor owns unsaved corrections in memory. Recovery sessions checkpoint exact
// words on disk; applying a recovery copy and saving a transcript remain explicit.
export const transcriptDrafts = new Map()
export const transcriptDraftKey = (root, src, locale) => JSON.stringify([root, src, locale])
export function transcriptDraftMatches(draft, record) {
  return Number.isSafeInteger(draft.record?.revision) && draft.record.revision === record.revision &&
    draft.record.fingerprint === record.fingerprint && record.status !== 'stale'
}

const recoverySessions = new Map()
export function transcriptRecoverySession(key, api, owner, onState = () => {}) {
  let session = recoverySessions.get(key)
  if (session && !session.retiring) { session.listen(onState); return session }
  let basis = null, head = null, sequence = 0, pending = null, running = null, listener = onState, error = null, retiring = false, retirement = null
  const sessionID = globalThis.crypto.randomUUID()
  const status = message => listener(message)
  const pump = () => {
    if (running || !pending) return running ?? Promise.resolve()
    const words = pending; pending = null
    status('Updating the recovery copy...')
    running = api('/api/transcript/drafts/checkpoint', { ...owner, sessionID, sequence: sequence + 1, parent: head, basis, words }).then(receipt => {
      head = receipt.id; sequence = receipt.sequence; error = null
      status(receipt.warning ?? 'Recovery copy saved on disk.')
    }).catch(cause => { error = cause; status(`Recovery copy failed: ${cause.message}. Keep this editor open or save corrections.`) }).finally(() => { running = null; if (pending) pump() })
    return running
  }
  session = {
    listen(next) { listener = next },
    capture(context, record) {
      if (retiring || pending || running || head && !error) return
      if (error) { const observed = context.offers?.find(offer => offer.sessionID === sessionID); if (observed) { head = observed.id; sequence = observed.sequence }; error = null }
      if (context.basis?.revision !== record.revision || context.basis?.fingerprint !== (record.fingerprint ?? '')) { basis = null; status('Recheck the saved transcript before creating a recovery copy.'); return }
      basis = context.basis
    },
    update(words) { if (retiring) return; if (!basis) { status('No current recovery identity. Recheck or save your corrections.'); return }; pending = words.map(word => ({ t: word.t, end: word.end, text: word.text })); pump() },
    async flush() { while (running || pending) await (running ?? pump()); if (error) throw error },
    retire() {
      if (retirement) return retirement
      retiring = true
      retirement = (async () => {
        await this.flush()
        if (head) await api('/api/transcript/drafts/discard', { ...owner, id: head })
        if (recoverySessions.get(key) === session) recoverySessions.delete(key)
        head = null; basis = null; listener = () => {}
      })().finally(() => { retiring = false; retirement = null })
      return retirement
    },
    get retiring() { return retiring },
    detach() { if (recoverySessions.get(key) === session) recoverySessions.delete(key); listener = () => {} },
    get head() { return head },
    get basis() { return basis },
  }
  recoverySessions.set(key, session)
  return session
}
