// Editor requests use one backend boundary. HTTP and native retain their existing transport.
// The explicit browser-local bootstrap supplies a third host for device-owned browser storage.
// - http: the Node server (server.mjs), used by the Claude Code mod and in development.
// - native: the Reel app (SwiftUI + WKWebView). JSON calls go through the `reel` script
//   message handler (WKScriptMessageHandlerWithReply), pushes arrive on window.__reelEvent,
//   and GET resources (media, cache, vendor, core) load from the page's own reel:// origin.
// Everything in the editor talks to the backend through this module, so a host swap
// touches nothing else. See docs/format.md for the API both hosts implement.

const native = typeof window !== 'undefined' && window.webkit?.messageHandlers?.reel
const session = typeof window !== 'undefined' ? window.__reelSessionID : undefined
const browser = typeof window !== 'undefined' ? window.__aryaBrowserHost : undefined

// Native: bodies go as JSON text and answers come back as JSON text, so the project keeps
// its key order and numbers exactly (no Foundation dictionaries in between).
async function post(message) {
  const reply = await native.postMessage({ ...message, session })
  const data = typeof reply === 'string' ? JSON.parse(reply) : reply
  if (data && data.error) throw new Error(data.error)

  return data
}

// Bytes cross the message channel as base64 text, in chunks this size (before encoding).
const CHUNK = 4 * 1024 * 1024

export const host = {
  kind: browser ? 'browser-local' : native ? 'native' : 'http',
  browser,

  /** GETs (no body) or POSTs JSON to an API path; resolves the JSON answer or throws its error. */
  async request(path, body) {
    if (browser) return browser.request(path, body)
    if (native) return post({ type: 'request', path, method: body === undefined ? 'GET' : 'POST', body: body === undefined ? null : JSON.stringify(body) })
    const res = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw Object.assign(new Error(data.error ?? `${path} ${res.status}`), { status: res.status })

    return data
  },

  /** A URL the page can load directly (media, thumbnails, vendor code). Relative on both hosts. */
  url(path) {
    if (browser) return browser.url(path)
    return path
  },

  fileForURL(url) { return browser?.fileForURL(url) ?? null },
  resource(path, options) { return browser ? browser.resource(path, options) : fetch(path, options) },
  audioBuffer(...args) { if (!browser) throw new Error('Browser audio decoding is unavailable.'); return browser.audioBuffer(...args) },

  /** Presents native sharing UI for a confined delivery, anchored to this WebView. */
  shareDelivery(id, root) {
    if (!native) throw new Error('Sharing is available in the Arya app')
    return post({ type: 'deliveryShare', id, root })
  },

  /** Subscribes to server pushes: handlers is { eventName: data => void }. Returns unsubscribe. */
  events(handlers, role = 'ui') {
    if (browser) return browser.events(handlers)
    if (native) {
      const prev = window.__reelEvent
      window.__reelEvent = (name, data) => handlers[name]?.(data)
      post({ type: 'subscribe', role }).catch(error => handlers.error?.(error))
      handlers.hello?.({ role })

      return () => {
        window.__reelEvent = prev
      }
    }
    const es = new EventSource(`/api/events?role=${role}`)
    for (const [name, fn] of Object.entries(handlers)) {
      if (name === 'error') es.onerror = fn
      else es.addEventListener(name, e => fn(JSON.parse(e.data)))
    }

    return () => es.close()
  },

  /** Uploads a dropped or picked file into the project's media folder; resolves { path }. */
  async upload(file) {
    if (browser) return browser.upload(file)
    if (native) {
      // The macOS app imports files dropped on its window itself; this path carries files the
      // page receives (iOS drops, pickers) in chunks that share an id.
      const id = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
      let offset = 0
      let answer
      do {
        const end = Math.min(file.size, offset + CHUNK)
        const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer())
        answer = await post({ type: 'upload', name: file.name, base64: toBase64(bytes), id, done: end >= file.size })
        offset = end
      } while (offset < file.size)

      return answer
    }
    const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file })

    return res.json()
  },

  /**
   * Native app only: writes bytes the page made (export-webcodecs.js) into the project.
   * `{ job, position }` writes into an export job's file; `{ name }` writes a file under
   * renders/ or .reel/frames/. Resolves the app's answer.
   */
  async save(bytes, target) {
    if (browser) return browser.save(bytes, target)
    if (!native) throw new Error('saving bytes from the page needs the Arya app')
    let answer
    for (let offset = 0; offset < bytes.length || offset === 0; offset += CHUNK) {
      const part = bytes.subarray(offset, Math.min(bytes.length, offset + CHUNK))
      answer = await post({ type: 'saveExport', ...target, position: (target.position ?? 0) + offset, done: !target.job && (target.done ?? true) && offset + part.length >= bytes.length, base64: toBase64(part) })
      if (answer?.cancelled || bytes.length === 0) break
    }

    return answer
  },
}

export const api = (path, body) => host.request(path, body)

function toBase64(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))

  return btoa(out)
}
