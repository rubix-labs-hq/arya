/// Script the app adds to the editor page before any of its own code runs.
enum HostScript {
    static func source(sessionID: String) -> String {
        "window.__reelSessionID = '\(sessionID)';\n" + source
    }
    static let source = #"""
    (() => {
      const native = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.reel
      if (!native) return

      // Console lines and uncaught errors go to the app's log.
      const text = v => {
        if (v instanceof Error) return `${v.name}: ${v.message}\n${v.stack || ''}`
        if (typeof v === 'string') return v
        try { return JSON.stringify(v) } catch { return String(v) }
      }
      const send = (level, parts) => { try { native.postMessage({ type: 'log', level, text: parts.map(text).join(' ') }).catch(() => {}) } catch {} }
      for (const level of ['log', 'info', 'warn', 'error']) {
        const original = console[level].bind(console)
        console[level] = (...parts) => { original(...parts); send(level, parts) }
      }
      window.addEventListener('error', e => send('error', [`${e.message} (${e.filename}:${e.lineno})`]))
      window.addEventListener('unhandledrejection', e => send('error', ['unhandled rejection', e.reason]))

      // WebKit refuses a video element's first script-started play() in Low Power Mode until a
      // user gesture. The editor starts playback from animation frames, after async seeks, so
      // a refused play() is retried by the app, whose script calls count as a gesture. Once an
      // element has played that way, WebKit lets the page play it again.
      const play = HTMLMediaElement.prototype.play
      const pending = new Map()
      let nextId = 1
      window.__reelMediaUnlock = id => {
        const entry = pending.get(id)
        pending.delete(id)
        if (!entry) return 'gone'
        return play.call(entry.el).then(() => { entry.resolve(); return 'ok' }, error => { entry.reject(error); return error.name })
      }
      HTMLMediaElement.prototype.play = function () {
        return play.call(this).catch(error => {
          if (!error || error.name !== 'NotAllowedError') throw error
          return new Promise((resolve, reject) => {
            const id = nextId++
            pending.set(id, { el: this, resolve, reject })
            native.postMessage({ type: 'unlockMedia', id, session: window.__reelSessionID }).catch(e => { pending.delete(id); reject(e) })
          })
        })
      }
    })()
    """#
}
