import { CATALOG_MAX_AGE_MS } from '../../core/assistant-routing.mjs'

export const ASSISTANT_PROVIDERS = [
  { id: 'claude-code', name: 'Claude Code', account: 'Claude subscription', suggested: true },
  { id: 'codex', name: 'Codex', account: 'ChatGPT subscription' },
  { id: 'gemini-cli', name: 'Gemini CLI · retired', account: 'Retired individual account connection' },
  { id: 'antigravity', name: 'Google Antigravity', account: 'Google account' },
  { id: 'custom', name: 'Custom agent', account: 'Server-configured adapter' },
]

export function providerName(id) {
  return ASSISTANT_PROVIDERS.find(p => p.id === id)?.name ?? (id === 'anthropic' ? 'Anthropic API' : 'Assistant')
}

export function assistantState(status, provider = status?.provider ?? 'claude-code') {
  const detail = status?.providers?.find(p => p.id === provider)
  const selected = status?.provider === provider
  const auto = status?.mode === 'auto' && selected
  const retired = provider === 'gemini-cli'
  const ready = !retired && selected && status?.configured === true && (auto || detail?.available !== false)
  const needsLogin = ['claude-code', 'codex', 'antigravity'].includes(provider) && detail?.installed === true && detail?.authenticated === false
  const now = Date.now()
  const catalog = status?.catalogs?.find(item => item.provider === provider)
  const expired = catalog?.complete === true && ['provider-cli', 'provider-sdk', 'provider-docs', 'verified-custom-adapter'].includes(catalog.source?.kind) && Number.isSafeInteger(catalog.checkedAt) && catalog.checkedAt <= now && now - catalog.checkedAt > CATALOG_MAX_AGE_MS
  const refreshRequired = selected && !ready && (auto
    ? status?.autoPreview?.ok === false && status.autoPreview.blocked?.length > 0 && status.autoPreview.blocked.every(item => item.reason === 'The model catalog needs a refresh.')
    : detail?.available === true && status?.manualPreview?.recovery === 'refresh-model-efforts' && expired)
  const refreshing = refreshRequired && status?.loading === true
  const label = retired ? 'Retired connection' : refreshRequired ? refreshing ? 'Refreshing model availability…' : 'Model availability needs a refresh' : auto ? ready ? 'Auto ready' : status?.reason ?? 'Choose Auto models' : !status ? 'Status unavailable' : needsLogin ? 'Sign-in needed' : detail?.available === false ? 'Unavailable' : ready ? 'Ready' : !selected && detail?.authenticated === true ? 'Signed in, not selected' : detail?.installed === false ? 'Not installed' : detail?.authenticated === false ? 'Sign-in needed' : 'Setup needed'
  if (refreshRequired) return { detail, ready, label, refreshRequired: true, refreshing, reason: 'The saved model catalog has expired. Arya will recheck the account and exact model before sending.' }
  return { detail, ready, label, refreshRequired: false, refreshing: false, reason: (selected && !ready ? status?.reason : '') || detail?.reason || (selected ? status?.reason : '') || 'Refresh status to check this provider.' }
}

export function assistantPrompt(text, state, playhead, inputKind) {
  if (inputKind !== undefined && !['prompt', 'script', 'screenplay'].includes(inputKind)) throw new Error('Choose Prompt, Script or Screenplay.')
  for (const ref of state.refs ?? []) {
    if (!['motion', 'marker'].includes(ref.kind) || !ref.context) continue
    if (ref.kind === 'marker' && (ref.context.projectRoot !== state.root || ref.context.projectVersion !== state.version)) throw new Error('The project changed since this marker was attached. Attach the current marker again.')
    if (ref.context.projectRoot !== state.root || ref.context.projectVersion !== state.version) throw new Error('The project changed since this motion request was attached. Select the current layers and attach the request again.')
  }
  return { type: 'prompt', text, ...(inputKind === undefined ? {} : { inputKind }), refs: structuredClone(state.refs ?? []), ids: [...(state.selection ?? [])], comp: state.openComp ?? null, playhead: Number.isFinite(playhead) ? playhead : 0 }
}

export function safeInstallURL(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null } catch { return null }
}
