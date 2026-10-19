import { prepareAdapter } from '../../agent/adapters.mjs'
import { SHARING_CLASSES } from '../../core/assistant-sharing.mjs'

// Known provider metadata and local Node adapters only. No provider prompt or sign-in.
export const fixtureAccounts = async () => [{ id: 'claude-code', installed: true, authenticated: true }]
export const fixtureBridgeOptions = (options = {}) => ({ ...options,
  catalogOptions: { providerStatus: fixtureAccounts, ...options.catalogOptions },
  prepareAdapter: options.prepareAdapter ?? ((request, transport, custom) => prepareAdapter({ ...request, provider: 'custom' }, transport, custom)),
})
export const fixtureSharing = (endpoint, models = [{ provider: 'claude-code', model: '' }]) => ({ version: 1, approved: true, scope: { providers: [...new Set(models.map(item => item.provider))], models, companion: endpoint, classes: [...SHARING_CLASSES] } })
export async function approveFixture(service) {
  const review = await service.sharing()
  const granted = review.approved ? review : await service.grantSharing({ reviewID: review.reviewID, sharing: fixtureSharing(review.scope.companion, review.scope.models) })
  const sharing = granted.sharing
  const original = service.send.bind(service)
  if (!service.fixtureSharingSend) { service.send = body => original({ ...body, sharing }); service.fixtureSharingSend = true }
  return sharing
}
// Delayed transport fixtures map their owned outer address to their inner listener.
export function forwardedFixtureBody(bytes, endpoint) {
  const value = JSON.parse(bytes)
  if (value.sharing?.scope) value.sharing.scope.companion = endpoint
  return JSON.stringify(value)
}
