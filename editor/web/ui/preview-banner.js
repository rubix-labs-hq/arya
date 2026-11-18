// The banner over the viewer while it draws an assistant preview ("Show in viewer" on the
// preview card). The previewed project itself comes from store.js previewProject().

import { h } from 'preact'
import { useState } from 'preact/hooks'
import htm from 'htm'
import { api, set, toast, useStore } from './store.js'
import { assistantActivity } from './assistant-activity.js'

const html = htm.bind(h)

// Apply and Discard work here too, because on a phone the preview card is in the assistant
// sheet, which covers the viewer.
export function PreviewBanner() {
  const s = useStore()
  const [busy, setBusy] = useState('')
  const proposal = s.assistantReview?.proposal
  if (!proposal) return null
  const running = assistantActivity(s.claude, { connected: s.connected }).active
  const steps = proposal.steps?.length ?? 0
  const decide = async kind => {
    if (busy) return
    setBusy(kind)
    try { await api(`/api/assistant/proposal/${kind}`, { id: proposal.id }) } catch (error) { toast(error.message, 'error') } finally { setBusy('') }
  }
  return html`<div class="viewer-preview-banner" role="status" aria-label="Showing the preview">
    <p><b>Showing the preview</b> ${proposal.summary || 'Assistant preview'}. Not applied yet; editing is off.</p>
    ${steps ? html`<p class="viewer-preview-steps">The viewer shows the edits only. ${steps === 1 ? '1 processing step runs' : `${steps} processing steps run`} after you apply and ${steps === 1 ? 'is' : 'are'} not shown.</p>` : null}
    <div class="assistant-preview-actions">
      <button class="assistant-apply" disabled=${Boolean(running || busy)} title=${running ? 'Wait for the assistant to finish' : 'Apply these edits as one undo step'} onClick=${() => decide('apply')}>${busy === 'apply' ? 'Applying…' : 'Apply'}</button>
      <button class="ghost" disabled=${Boolean(busy)} onClick=${() => decide('discard')}>Discard</button>
      <button class="ghost" disabled=${Boolean(busy)} onClick=${() => set({ previewShown: null })}>Back to project</button>
    </div>
  </div>`
}
