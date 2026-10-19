const sameScope = (a, b) => a.root === b.root && a.version === b.version && a.project === b.project && a.comp === b.comp

export function createDeliverRequest({ getScope, start, changed, started }) {
  let active = true, pending = null, state = { phase: 'idle' }
  const visible = () => {
    if (state.scope && !sameScope(state.scope, getScope())) return { phase: state.phase === 'pending' ? 'stale-pending' : 'idle' }
    return state
  }
  const notify = () => { if (active) changed(visible()) }
  return {
    state: visible,
    dispose() { active = false },
    async run(spec, project) {
      if (!active || pending) return
      const scope = { ...getScope() }, token = {}
      const isCurrent = () => active && sameScope(scope, getScope())
      const assertCurrent = () => { if (!isCurrent()) throw new Error('The project changed. Start the render again from its current timeline.') }
      pending = token
      state = { phase: 'pending', scope }
      notify()
      try {
        await start(structuredClone(spec), structuredClone(project), { isCurrent, assertCurrent })
        if (isCurrent()) started()
        state = { phase: 'idle' }
      } catch (error) {
        state = isCurrent() ? { phase: 'failed', scope, error: error?.message || 'Render could not start. Try again.' } : { phase: 'idle' }
      } finally {
        if (pending === token) pending = null
        notify()
      }
    },
  }
}
