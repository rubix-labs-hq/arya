// The occasional tip card after a successful export, for the two browser editors. main.js mounts
// it only after the host resolves a website support link, so the native apps, which bundle this
// file, never load it: they have their own card with App Store tips or a Mac link.
// The rules live in core/support-prompt.js. This device stores only counts and dates.

import { h, render } from 'preact'
import htm from 'htm'
import { exportJustFinished, recordSupportChoice, successfulExport, supportPromptState } from '/core/support-prompt.js'
import { set, store, subscribe, useStore } from './store.js'

const html = htm.bind(h)
const KEY = 'arya.supportPrompt'

function load() {
  try { return supportPromptState(JSON.parse(globalThis.localStorage?.getItem(KEY) ?? 'null')) } catch { return supportPromptState(null) }
}
function save(state) {
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(state)) } catch {}
}

function choose(choice) {
  save(recordSupportChoice(load(), choice))
  set({ supportPromptOpen: false })
}

function SupportPrompt() {
  const s = useStore()
  if (!s.supportPromptOpen || !s.supportURL) return null
  return html`<aside class="support-prompt" role="dialog" aria-modal="false" aria-labelledby="support-prompt-title">
    <div class="support-prompt-body">
      <span class="support-prompt-icon" aria-hidden="true">♥</span>
      <div>
        <strong id="support-prompt-title">Enjoying Arya?</strong>
        <p>Arya is free, with no ads and no account. If it saves you time, an optional tip helps keep it that way. It unlocks nothing.</p>
      </div>
    </div>
    <div class="support-prompt-actions">
      <a class="button primary" href=${s.supportURL} target="_blank" rel="noopener noreferrer" onClick=${() => choose('support')}>Leave a tip ↗</a>
      <button onClick=${() => choose('notNow')}>Not now</button>
      <button class="ghost" onClick=${() => choose('never')}>Don't ask again</button>
    </div>
  </aside>`
}

/** Watches exports this tab sees finish and shows the card when the rules allow. */
export function mountSupportPrompt(supportURL) {
  let seen = new Map(store.jobs.map(job => [job.id, job.state]))
  subscribe(() => {
    for (const job of store.jobs) {
      if (!exportJustFinished(seen.get(job.id), job)) continue
      const { state, show } = successfulExport(load(), { now: Date.now(), channelAvailable: Boolean(supportURL) })
      save(state)
      if (show) setTimeout(() => set({ supportPromptOpen: true }), 1200)
    }
    seen = new Map(store.jobs.map(job => [job.id, job.state]))
  })
  const root = document.createElement('div')
  document.body.append(root)
  render(h(SupportPrompt), root)
}
