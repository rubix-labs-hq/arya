// Shared browser/native companion contract. Credentials stay in host-local grant matching.
export const SHARING_VERSION = 1
export const SHARING_CLASSES = Object.freeze(['prompt', 'project_context', 'project_content', 'tool_results', 'rendered_frames', 'reference_images', 'conversation_history'])
const recipients = Object.freeze({
  'claude-code': { name: 'Anthropic · Claude Code', destination: 'Anthropic through the signed-in Claude Code CLI' },
  codex: { name: 'OpenAI · Codex', destination: 'OpenAI through the signed-in Codex CLI' },
  anthropic: { name: 'Anthropic API', destination: 'https://api.anthropic.com/' },
})
const descriptions = {
  prompt: ['Your request', 'Message text, scripts and screenplays.'],
  project_context: ['Project context', 'Project name, local paths, structure, version, selection, playhead and reference descriptions.'],
  project_content: ['Project content', 'Whole-project metadata, titles, settings, transcripts and edit history available through project tools.'],
  tool_results: ['Tool results', 'Requested project data, processing results and generated assets.'],
  rendered_frames: ['Rendered frames', 'Video and image frames requested to inspect the project.'],
  reference_images: ['Attached references', 'Reference descriptions and image contents.'],
  conversation_history: ['Conversation history', 'Previous assistant messages available in this project.'],
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const failure = message => Object.assign(new Error(message), { status: 403 })
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key))
const modelKey = item => `${item.provider}:${item.model}`

export function canonicalCompanion(value) {
  if (typeof value !== 'string' || value.length > 2048) throw failure('The assistant companion destination cannot be verified.')
  let url
  try { url = new URL(value) } catch { throw failure('The assistant companion destination cannot be verified.') }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw failure('Use a credential-free HTTPS root companion address, or HTTP on loopback.')
  if (url.protocol === 'http:' && loopback) url.hostname = '127.0.0.1'
  return url.href
}

export function normalizeSharingScope(value) {
  if (!exactKeys(value, ['providers', 'models', 'companion', 'classes'])) throw failure('Review the current assistant recipients and data categories before sending.')
  if (!Array.isArray(value.providers) || !value.providers.length || value.providers.some(id => !Object.hasOwn(recipients, id)) || new Set(value.providers).size !== value.providers.length) throw failure('This assistant recipient is unknown. Choose Claude Code, Codex or the Anthropic API before sharing.')
  if (!Array.isArray(value.models) || !value.models.length || value.models.length > 256 || value.models.some(item => !exactKeys(item, ['provider', 'model']) || !value.providers.includes(item.provider) || typeof item.model !== 'string' || item.model.length > 128 || item.model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+\[\]-]{0,127}$/.test(item.model))) throw failure('Review the exact assistant model pool before sharing.')
  const models = value.models.map(item => ({ provider: item.provider, model: item.model })).sort((a, b) => {
    const aKey = modelKey(a), bKey = modelKey(b)
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0
  })
  if (new Set(models.map(modelKey)).size !== models.length || value.providers.some(id => !models.some(item => item.provider === id))) throw failure('The assistant recipient pool cannot be verified.')
  if (!Array.isArray(value.classes) || value.classes.length !== SHARING_CLASSES.length || new Set(value.classes).size !== SHARING_CLASSES.length || SHARING_CLASSES.some(id => !value.classes.includes(id))) throw failure('The assistant must disclose every supported project data category before sharing.')
  return { providers: [...value.providers].sort(), models, companion: canonicalCompanion(value.companion), classes: [...SHARING_CLASSES] }
}

export function normalizeSharingEnvelope(value) {
  if (!exactKeys(value, ['version', 'approved', 'scope']) || value.version !== SHARING_VERSION || value.approved !== true) throw failure('Sharing permission is required. Review assistant sharing before sending.')
  return { version: SHARING_VERSION, approved: true, scope: normalizeSharingScope(value.scope) }
}

export function sameSharingScope(a, b) {
  try { return JSON.stringify(normalizeSharingScope(a)) === JSON.stringify(normalizeSharingScope(b)) } catch { return false }
}

export function sharingScopeForRoute(route, companion) {
  if (!route?.ok) throw failure(route?.reason || 'The assistant recipient is unavailable. Refresh account status before sharing.')
  const models = route.mode === 'auto' ? route.considered : [{ provider: route.provider, model: route.model ?? '' }]
  return normalizeSharingScope({ providers: [...new Set(models.map(item => item.provider))], models, companion, classes: SHARING_CLASSES })
}

export function assertSharingRoute(sharing, route, companion) {
  const envelope = normalizeSharingEnvelope(sharing)
  if (!sameSharingScope(envelope.scope, sharingScopeForRoute(route, companion))) throw failure('The assistant destination or eligible model pool changed. Review sharing permission again.')
  return envelope
}

export function sharingDisclosure(scope) {
  const value = normalizeSharingScope(scope), local = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value.companion).hostname)
  return { purpose: 'These recipients use your request and project data to answer and edit your project.',
    recipients: value.providers.map(provider => ({ provider, ...recipients[provider] })),
    companion: { endpoint: value.companion, local, description: local ? 'The companion runs on this computer and forwards data to the AI recipients. AI processing leaves the device.' : 'This HTTPS companion receives data before forwarding it to the AI recipients. Its operator must be someone you recognize.' },
    classes: value.classes.map(id => ({ id, label: descriptions[id][0], description: descriptions[id][1] })),
    withdrawal: 'Withdraw permission in Settings. Stop prevents further work and cannot recall data already shared.' }
}
