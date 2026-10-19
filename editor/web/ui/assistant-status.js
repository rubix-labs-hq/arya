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
