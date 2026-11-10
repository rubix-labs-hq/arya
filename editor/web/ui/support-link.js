// Website support link for the two browser editors only. This file is also bundled into the
// native apps, so it holds no domain and returns nothing there: the iOS app offers App Store
// tips and the Mac app has its own menu item. The hosted beta reads the link from a meta tag
// added when the site is published; the local editor asks its own server.

// Channel each host may show. The channel only tells the website which editor sent the visit.
const CHANNEL_FOR_HOST = { 'browser-local': 'web-beta', http: 'local-editor' }

/** The URL when it is an https `/support/` page for this host's channel, otherwise null. */
export function validSupportURL(value, kind) {
  const channel = CHANNEL_FOR_HOST[kind]
  if (!channel || typeof value !== 'string') return null
  let url
  try { url = new URL(value) } catch { return null }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.pathname !== '/support/') return null
  if ([...url.searchParams.keys()].join() !== 'channel' || url.searchParams.get('channel') !== channel) return null
  return url.href
}

/** Resolves the link for `kind`, or null. Never throws, and never asks a native host. */
export async function resolveSupportLink({ kind, document: doc = globalThis.document, request }) {
  if (kind === 'browser-local') return validSupportURL(doc?.querySelector?.('meta[name="arya-support-url"]')?.content, kind)
  if (kind !== 'http' || typeof request !== 'function') return null
  try { return validSupportURL((await request('/api/support-link'))?.url, kind) } catch { return null }
}
