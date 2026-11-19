// Times the checks that run before an assistant request reaches its provider, so a slow
// "Preparing your request" can be traced to a step. A request runs the same round three times:
// for the sharing review, for the send, and again inside the agent process. A round is an account
// check for every provider and then the Codex model list. Only durations are logged, never what a
// check returned or why it failed.
const STEPS = { accounts: 'account check', models: 'Codex model list' }
export const SLOW_PROBE_MS = 1000

export function createProbeTiming({ log = () => {}, now = () => performance.now(), slowMs = SLOW_PROBE_MS } = {}) {
  const totals = { accounts: { calls: 0, ms: 0 }, models: { calls: 0, ms: 0 } }
  const say = message => { try { log(message) } catch {} }
  return {
    /** Wraps one check. `who` is 'editor' (this server) or 'agent' (the agent process's own round). */
    probe(who, step, check) {
      return async (...args) => {
        const started = now()
        try { return await check(...args) } finally {
          const ms = Math.round(now() - started)
          if (who === 'editor') { totals[step].calls++; totals[step].ms += ms }
          // The agent's round runs after the request is handed over, so it is reported on its own, and only when slow.
          else if (ms >= slowMs) say(`agent ${STEPS[step]} took ${ms} ms`)
        }
      }
    },
    /** Wraps a catalog so each route check logs one line with its total and the two steps inside it. */
    catalog(catalog) {
      return {
        ...catalog,
        async resolve(preferences, request) {
          const started = now(), before = { accounts: { ...totals.accounts }, models: { ...totals.models } }
          try { return await catalog.resolve(preferences, request) } finally {
            const part = step => `${STEPS[step]} ${totals[step].ms - before[step].ms} ms in ${totals[step].calls - before[step].calls} call${totals[step].calls - before[step].calls === 1 ? '' : 's'}`
            say(`${typeof request?.text === 'string' ? 'send' : 'sharing review'} route check took ${Math.round(now() - started)} ms (${part('accounts')}, ${part('models')})`)
          }
        },
      }
    },
  }
}
