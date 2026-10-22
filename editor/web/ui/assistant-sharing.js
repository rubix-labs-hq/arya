import { h } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import htm from 'htm'
import { normalizeSharingScope, normalizeSharingEnvelope, sameSharingScope } from '../../core/assistant-sharing.mjs'

const html = htm.bind(h)
const gates = new Set()
let withdrawalBlocked = false
let withdrawalGeneration = 0

export async function withdrawAssistantSharing(api) {
  const attempt = ++withdrawalGeneration
  withdrawalBlocked = true
  for (const gate of gates) gate.cancel()
  const result = await api('/api/assistant/sharing/revoke', {})
  if (result?.version !== 1 || result?.revoked !== true || result?.approved !== false) throw new Error('Sharing withdrawal could not be confirmed. Retry Withdraw sharing permission in Settings before sending.')
  if (attempt === withdrawalGeneration) withdrawalBlocked = false
  return result
}
const PROVIDERS = { 'claude-code': 'Anthropic · Claude Code', codex: 'OpenAI · Codex', 'gemini-cli': 'Google · Gemini CLI (beta)', anthropic: 'Anthropic API' }
const CLASSES = {
  prompt: ['Your request', 'Message text, scripts or screenplays you ask the assistant to use.'],
  project_context: ['Project context', 'Project name, local paths, version, structure, selection, playhead and references.'],
  project_content: ['Project content', 'Titles, clip metadata, settings, transcripts and edit history available through project tools.'],
  tool_results: ['Tool results', 'Requested project data, processing results and generated assets.'],
  rendered_frames: ['Rendered frames', 'Video and image frames the assistant requests to inspect the project.'],
  reference_images: ['Attached references', 'Reference descriptions and image contents you attach.'],
  conversation_history: ['Conversation history', 'Previous assistant messages available in this project.'],
}

export function verifiedSharingReview(review) {
  if (review?.version !== 1) throw new Error('This assistant host needs an update before it can review sharing permission.')
  const scope = normalizeSharingScope(review.scope)
  if (review.approved !== true && (typeof review.reviewID !== 'string' || !review.reviewID || review.reviewID.length > 128)) throw new Error('This assistant host needs an update before it can save sharing permission.')
  return { version: 1, approved: true, scope }
}

// The attempt generation stops an awaited review or grant from submitting after Stop.
export function createAssistantSharingGate({ api, present, busy }) {
  let generation = 0, current = null
  const finish = (attempt, value, error) => {
    if (current !== attempt) return
    current = null; present(null); busy(false)
    if (error) attempt.reject(error)
    else attempt.resolve(value)
  }
  const cancel = () => {
    generation++
    if (current) finish(current, null)
  }
  const request = () => {
    if (withdrawalBlocked) throw new Error('Sharing withdrawal could not be confirmed. Retry Withdraw sharing permission in Settings before sending.')
    if (current) throw new Error('Finish the current sharing review first.')
    const attempt = { generation: ++generation }
    const result = new Promise((resolve, reject) => { attempt.resolve = resolve; attempt.reject = reject })
    current = attempt; busy(true)
    Promise.resolve().then(() => api('/api/assistant/sharing')).then(review => {
      if (current !== attempt || attempt.generation !== generation) return
      attempt.sharing = verifiedSharingReview(review)
      attempt.review = review
      if (review.approved === true) {
        if (!sameSharingScope(normalizeSharingEnvelope(review.sharing).scope, attempt.sharing.scope)) throw new Error('Saved sharing permission does not match the current recipients. Review again.')
        finish(attempt, { sharing: attempt.sharing, valid: () => generation === attempt.generation })
      } else { busy(false); present({ ...review, scope: attempt.sharing.scope }) }
    }).catch(error => finish(attempt, null, error))
    return result
  }
  const allow = async () => {
    const attempt = current
    if (!attempt?.review || attempt.granting) return
    attempt.granting = true; busy(true)
    try {
      const granted = await api('/api/assistant/sharing/grant', { sharing: attempt.sharing, reviewID: attempt.review.reviewID })
      if (current !== attempt || generation !== attempt.generation) return
      if (granted.approved !== true || !sameSharingScope(normalizeSharingEnvelope(granted.sharing).scope, attempt.sharing.scope)) throw new Error('The recipients changed during review. Send again to review the current destination.')
      finish(attempt, { sharing: attempt.sharing, valid: () => generation === attempt.generation })
    } catch (error) { finish(attempt, null, error) }
  }
  const gate = { request, allow, cancel, dispose: () => { cancel(); gates.delete(gate) } }
  gates.add(gate)
  return gate
}

export function AssistantSharingReview({ review, busy = false, onAllow, onDecline, onStop }) {
  const dialog = useRef(null)
  useEffect(() => {
    const previous = document.activeElement
    dialog.current?.querySelector('[data-sharing-decline]')?.focus()
    return () => previous?.focus?.()
  }, [])
  const scope = review.scope, endpoint = new URL(scope.companion)
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
  const directAPI = scope.providers.length === 1 && scope.providers[0] === 'anthropic' && endpoint.origin === 'https://api.anthropic.com'
  const trap = event => {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); if (busy) onStop(); else onDecline(); return }
    if (event.key !== 'Tab') return
    const elements = [...dialog.current.querySelectorAll('button:not(:disabled), summary, a[href], [tabindex="0"]')].filter(element => element.getClientRects().length)
    const first = elements[0], last = elements.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  return html`<div class="modal-back assistant-sharing-back">
    <section class="assistant-sharing-dialog" role="dialog" aria-modal="true" aria-labelledby="assistant-sharing-title" aria-describedby="assistant-sharing-purpose" ref=${dialog} onKeyDown=${trap}>
      <h2 id="assistant-sharing-title">Review assistant sharing</h2>
      <p id="assistant-sharing-purpose">These recipients use your request and project data to answer and edit your project.</p>
      <h3>AI recipients</h3><ul>${scope.providers.map(provider => html`<li><b>${PROVIDERS[provider]}</b></li>`)}</ul>
      <details open><summary>Current models ${scope.models.length > 1 ? 'Auto may use' : 'for this destination'}</summary><ul>${scope.models.map(model => html`<li>${PROVIDERS[model.provider]} · <code>${model.model || 'Provider default'}</code></li>`)}</ul></details>
      <h3>${directAPI ? 'Provider destination' : local ? 'Local companion' : 'Remote companion operator'}</h3><p class="assistant-sharing-endpoint">${scope.companion}</p>
      <p>${directAPI ? 'The request goes directly to Anthropic through its API. AI processing leaves the device.' : local ? 'The companion runs on this computer and forwards the request to the AI recipients above. AI processing leaves the device.' : 'This HTTPS companion receives the data before forwarding it to the AI recipients above. Continue only if you recognize its operator.'}</p>
      <h3>Data these recipients may receive</h3><ul class="assistant-sharing-classes">${scope.classes.map(id => html`<li><b>${CLASSES[id][0]}</b><span>${CLASSES[id][1]}</span></li>`)}</ul>
      <p>Permission applies to these destinations, this model pool and these data categories. A change requires another review. Provider retention and use depend on your account and the companion operator; Arya has not verified those terms.</p>
      <p>You can withdraw permission in Settings. Stop prevents further work; it cannot recall data already shared.</p>
      <div class="assistant-sharing-actions"><button class="ghost" data-sharing-decline onClick=${busy ? onStop : onDecline}>${busy ? 'Stop request' : 'Keep draft'}</button><button disabled=${busy} onClick=${onAllow}>${busy ? 'Saving permission…' : 'Allow sharing and send'}</button></div>
    </section>
  </div>`
}
