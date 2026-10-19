import { createRecoveryJournal } from '../core/project-persistence.mjs'
import { createTranscriptDraftStore } from '../core/transcript-draft-store.mjs'

export default ctx => {
  const store = createTranscriptDraftStore({ root: ctx.ROOT, resolveMedia: ctx.resolveMedia, readTranscript: (src, locale) => ctx.transcripts.get({}, new URLSearchParams({ src, locale })), assertPublication: ctx.assertCurrent, assertLock: ctx.assertDraftLock })
  const journal = ctx.draftJournal ?? createRecoveryJournal()
  const mutate = (action, body) => {
    ctx.assertCurrent?.()
    const encoded = JSON.stringify(body)
    if (Buffer.byteLength(encoded) > 16 * 1024 * 1024) throw new Error('The recovery request is larger than 16 MB')
    return journal(ctx.ROOT, { operation: 'transcriptDrafts', action }, [encoded]).result
  }
  return { routes: {
    'GET /api/transcript/drafts': (_body, query) => store.context(query.get('src'), query.get('locale')),
    'POST /api/transcript/drafts/checkpoint': body => mutate('checkpoint', body),
    'POST /api/transcript/drafts/read': body => store.read(body),
    'POST /api/transcript/drafts/recover': body => store.recover(body),
    'POST /api/transcript/drafts/discard': body => mutate('discard', body),
  } }
}
