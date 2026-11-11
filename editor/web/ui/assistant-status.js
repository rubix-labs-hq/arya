import { api, set } from './store.js'

let statusRequest = 0
export async function refreshAssistantStatus({ refresh = false } = {}) {
  const request = ++statusRequest
  try {
    const status = await api(`/api/assistant/status${refresh ? '?refresh=1' : ''}`)
    if (request === statusRequest) set({ assistantStatus: status, assistantStatusError: '' })
    return status
  } catch (error) {
    const message = error.message === '/api/assistant/status 404' ? 'The Arya server needs a restart to load account settings.' : error.message
    if (request === statusRequest) set({ assistantStatus: null, assistantStatusError: message })
    throw error
  }
}

// Sign in with ChatGPT. The editor server opens the sign-in page in the default browser and
// keeps the tokens. The page only starts, follows, cancels and ends the sign-in.
let chatgptFollow = null
export function followChatGPTSignIn({ interval = 1500, limit = 10 * 60 * 1000 } = {}) {
  chatgptFollow ??= (async () => {
    const deadline = Date.now() + limit
    try {
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, interval))
        const status = await refreshAssistantStatus().catch(() => null)
        if (status && !['waiting', 'exchanging'].includes(status.chatgpt?.attempt?.state)) return status
      }
      return null
    } finally { chatgptFollow = null }
  })()
  return chatgptFollow
}

export async function startChatGPTSignIn(body = {}) {
  const result = await api('/api/assistant/chatgpt/sign-in', body)
  if (result?.started !== true) throw new Error('ChatGPT sign-in could not be started.')
  await refreshAssistantStatus().catch(() => {})
  followChatGPTSignIn()
  return result
}

export async function chatgptAccountAction(action, body = {}) {
  if (!['cancel', 'sign-out', 'welcome'].includes(action)) throw new Error('Unknown ChatGPT account action.')
  const result = await api(`/api/assistant/chatgpt/${action}`, body)
  await refreshAssistantStatus().catch(() => {})
  return result
}

// One click from the assistant panel. The saved Auto pool and limits stay as they are;
// ChatGPT plan models are Manual only.
export async function chooseChatGPTAssistant(status) {
  await api('/api/assistant/config', { provider: 'chatgpt', model: '', agent: '', effort: '', catalogBound: false, mode: 'manual', priority: status?.priority ?? 'balanced',
    enabledModels: status?.enabledModels ?? [], allowAdditionalSpend: status?.allowAdditionalSpend === true, allowAPIBilling: status?.allowAPIBilling === true })
  return refreshAssistantStatus()
}
