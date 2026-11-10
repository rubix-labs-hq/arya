// Website support link for the local browser editor (node editor/server.mjs).
//
//   GET /api/support-link   → { url }
//
// This file is not bundled into the native apps (bundle-editor.sh copies only web/, core/ and
// agent/), so the website link never reaches the App Store builds. Payment happens on the
// website; the editor never sees it.

export const SUPPORT_URL = 'https://editwitharya.app/support/?channel=local-editor'

export default function supportRoutes() {
  return { routes: { 'GET /api/support-link': () => ({ url: SUPPORT_URL }) } }
}
