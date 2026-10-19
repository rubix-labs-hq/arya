import { applyOps, outline } from '../core/project.js'
import { describeRequest } from '../core/describe.js'
import { describeStep, PREVIEW_STEP_WAITS } from '../core/assistant-steps.js'

const ID = /^[a-zA-Z0-9_-]{1,128}$/
const PAGES = ['media', 'edit', 'motion', 'color', 'audio', 'deliver']
const refused = (message, status = 409) => Object.assign(new Error(message), { status })

export default ctx => {
  const review = () => {
    const value = ctx.getAssistantReview?.()
    if (!value) throw refused('Assistant review is unavailable in this editor.', 501)
    return value
  }
  // Apply, discard and undo are the user's decisions. Agent tool calls run inside an
  // assistant call context and cannot reach them.
  const userOnly = () => { if (ctx.assertCurrent?.()) throw refused('Only the editor can apply, discard or undo assistant changes.', 403) }
  // Runs a preview's processing steps one at a time against the current project version.
  const runSteps = async (r, steps) => {
    let error = ''
    for (const [index, step] of steps.entries()) {
      r.applyProgress(index, step.preview?.title ?? step.path)
      try {
        const body = { ...step.body, expectedVersion: ctx.getVersion(), ...(PREVIEW_STEP_WAITS.includes(step.path) ? { wait: true } : {}) }
        const result = await ctx.callAPI('POST', step.path, body)
        const problem = ['failed', 'cancelled'].includes(result?.state) ? result.error ?? `The step was ${result.state}.`
          : result?.state === 'asset_ready' ? result.placement?.error ?? 'The music is saved in Media, but it was not placed.'
          : result?.registrationError ?? result?.applyError ?? ''
        if (problem) throw new Error(problem)
      } catch (failure) {
        error = `${step.preview?.title ?? step.path} did not finish: ${String(failure.message).replace(/\.?\s*$/, '.')}${index + 1 < steps.length ? ` The remaining ${steps.length - index - 1} step${steps.length - index - 1 === 1 ? ' was' : 's were'} not run.` : ''}`
        break
      }
    }
    r.finishApply(ctx.getProject(), error)
  }
  return { routes: {
    'GET /api/assistant/status': (_, query) => ctx.assistant.status({ refresh: query?.get('refresh') === '1' }),
    'GET /api/assistant/sharing': () => ctx.assistant.sharing(),
    'POST /api/assistant/sharing/grant': body => ctx.assistant.grantSharing(body),
    'POST /api/assistant/sharing/revoke': () => ctx.assistant.revokeSharing(),
    'POST /api/assistant/config': body => ctx.assistant.configure(body),
    'POST /api/assistant/login': body => ctx.assistant.login(body),
    'POST /api/assistant/cancel': () => ctx.assistant.cancel(),

    // Clips, the layers at a time, or the editor focus, described as an editor reads the inspector.
    'GET /api/describe': (_, query) => {
      const project = ctx.getProject()
      if (!project) throw refused('No project is open.', 404)
      const ids = String(query?.get('ids') ?? '').split(',').map(id => id.trim()).filter(Boolean)
      if (ids.length > 64 || ids.some(id => !ID.test(id))) throw refused('ids must be at most 64 comma-separated clip IDs.', 400)
      const at = query?.has('at') ? Number(query.get('at')) : undefined
      if (at !== undefined && (!Number.isFinite(at) || at < 0 || at >= 1000000)) throw refused('at must be timeline seconds from 0 to 1000000.', 400)
      const comp = query?.get('comp') || null
      if (comp !== null && !ID.test(comp)) throw refused('Invalid composition ID.', 400)
      return { text: describeRequest(project, { ids, at, comp }), version: ctx.getVersion() }
    },

    'GET /api/assistant/review': () => review().snapshot(),

    // Moves the user's view: playhead, selection, open composition or page, so the assistant
    // can show the moment or the layers it means. It never changes the project.
    'POST /api/ui/show': body => {
      const project = ctx.getProject()
      if (!project) throw refused('No project is open.', 404)
      const value = {}
      if (body?.comp !== undefined) {
        if (body.comp !== null && (!ID.test(String(body.comp)) || !Object.hasOwn(project.comps ?? {}, body.comp))) throw refused(`No composition ${body.comp}.`, 400)
        value.comp = body.comp
      }
      if (body?.ids !== undefined) {
        const scope = (value.comp ?? null) === null ? project : project.comps[value.comp]
        const ids = new Set((scope?.tracks ?? []).flatMap(track => (track.clips ?? []).map(clip => clip.id)))
        if (!Array.isArray(body.ids) || body.ids.length > 256 || body.ids.some(id => typeof id !== 'string' || !ids.has(id.startsWith('tr:') ? id.slice(3) : id))) throw refused('ids must name up to 256 clips in the shown timeline. Pass comp to show clips inside a composition.', 400)
        value.ids = body.ids
      }
      if (body?.at !== undefined) {
        if (!Number.isFinite(body.at) || body.at < 0 || body.at >= 1000000) throw refused('at must be timeline seconds from 0 to 1000000.', 400)
        value.at = body.at
      }
      if (body?.page !== undefined) {
        if (!PAGES.includes(body.page)) throw refused(`page must be one of ${PAGES.join(', ')}.`, 400)
        value.page = body.page
      }
      if (!Object.keys(value).length) throw refused('Pass at, ids, comp or page.', 400)
      ctx.broadcast('uiShow', { ...value, id: Date.now() }, 'ui')
      return { shown: true, ...value }
    },

    // Checks the ops against the current project without saving them, and stores them as the
    // preview the user sees. Agents use this when Preview changes is on.
    'POST /api/assistant/propose': async body => {
      const call = ctx.assertCurrent?.()
      const project = ctx.getProject()
      if (!project) throw refused('No project yet: create one first.', 404)
      const next = review().propose({ runId: call?.runId ?? null, ops: body?.ops ?? [], steps: body?.steps ?? [], summary: body?.summary, reset: body?.reset === true })
      const sources = new Set(next.ops.flatMap(op => [op.src, op.set?.src, ...(Array.isArray(op.srcs) ? op.srcs : [])].filter(src => typeof src === 'string')))
      for (const src of sources) if (!project.assets?.[src] && !next.assets[src]) next.assets[src] = await ctx.probe(src)
      ctx.assertCurrent?.()
      if (ctx.getProject() !== project) throw refused('The project changed while preparing the preview. Read the outline and propose again.')
      // Probed media travels with the preview so the editor can show it before /api/ops imports it.
      const imports = Object.fromEntries(Object.entries(next.assets).filter(([src]) => !project.assets?.[src]))
      next.assets = imports
      const trial = applyOps(project, [...(Object.keys(imports).length ? [{ op: 'import', assets: imports }] : []), ...next.ops])
      // Steps run after the ops, so each is checked against the project the ops would make.
      next.steps = next.steps.map((step, index) => {
        try { const { body, ...preview } = describeStep(trial.project, step); return { path: step.path, request: step.body, body, preview } }
        catch (error) { throw refused(`Step ${index + 1} (${step.path}): ${error.message}`, 400) }
      })
      const staged = review().stage(next)
      ctx.pushActivity?.('agent', `Preview ready: ${staged.summary || `${staged.ops.length} ops`}`.slice(0, 300))
      return { previewed: true, applied: false, proposal: staged.id, baseVersion: staged.baseVersion, ops: staged.ops.length, steps: staged.steps.map(step => step.preview),
        log: trial.log.filter(line => !line.startsWith('imported')), created: trial.created, outline: outline(trial.project),
        note: 'Not applied. The user reviews this preview and applies or discards it. Steps render only after the user applies.' }
    },

    'POST /api/assistant/proposal/apply': async body => {
      userOnly()
      const r = review(), proposal = r.proposal()
      if (!proposal || proposal.id !== body?.id) throw refused('This preview is no longer available.')
      if (r.active()) throw refused('Wait for the assistant to finish before applying its preview.')
      if (ctx.getVersion() !== proposal.baseVersion || ctx.getProjectGeneration() !== proposal.epoch) throw refused('The project changed after this preview. Ask the assistant again for a current preview.')
      const summary = proposal.summaries.join('; ') || `${proposal.ops.length} assistant ops`
      r.beginApply(proposal, ctx.getProject())
      const owned = work => ctx.asAssistantApply ? ctx.asAssistantApply(proposal.id, work) : work()
      try {
        if (proposal.ops.length) await owned(() => ctx.editOps(proposal.ops, 'agent', `Applied preview: ${summary}`.slice(0, 300), { expectedVersion: proposal.baseVersion }))
      } catch (error) {
        r.finishApply(ctx.getProject(), error.message)
        throw error
      }
      if (!proposal.steps.length) return { applied: true, version: ctx.getVersion(), change: r.finishApply(ctx.getProject()) }
      // Processing can take minutes. It runs in order after this answer; progress arrives as review events.
      owned(() => runSteps(r, proposal.steps)).catch(() => {})
      return { applied: true, running: true, steps: proposal.steps.length, version: ctx.getVersion() }
    },

    'POST /api/assistant/proposal/discard': body => {
      userOnly()
      return { discarded: review().discard(body?.id) }
    },

    // Restores the project from before the latest assistant change in one undoable step.
    'POST /api/assistant/change/undo': body => {
      userOnly()
      const r = review()
      if (r.active()) throw refused('Wait for the assistant to finish before undoing its change.')
      const target = r.undoTarget(body?.id)
      if (!target.change) throw refused(target.reason)
      ctx.commit(target.change.before, 'you', [`Undo ${target.change.label.toLowerCase()}`])
      r.undone(target.change.id)
      return { undone: true, version: ctx.getVersion() }
    },
  } }
}
