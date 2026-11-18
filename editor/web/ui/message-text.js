// Chat text as safe HTML: code spans, bold, https links, simple pipe tables, lists and line breaks.
// Everything is escaped first, so a reply can never add its own markup. A local path never shows
// whole: a file in the project shows its path inside the project, and any other file its name.
// The text may be a reply that is still streaming, so half a table or link just stays text.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escape = value => String(value).replace(/[&<>"']/g, character => ESCAPES[character])
const MARK = '\u0000'

// Absolute paths in the places a Mac keeps files, and a home-relative path.
const LOCAL_PATH = /(^|[\s(\[{"'“‘=:*_|>])((?:~|\/(?:Users|Volumes|private|tmp|var|home|opt|Library|Applications|System))\/[^\s<>"'`)\]}”’]*)/g
const TRAILING = /[.,;:!?]+$/

function fileName(path) {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts.at(-1) || path
}

/** Shortens every local path in plain text. `root` is the open project's folder. */
export function shortenPaths(text, root = '') {
  let value = String(text)
  // file:// links first, decoded, so they read like the paths they name.
  value = value.replace(/file:\/\/[^\s<>"'`)\]}]+/g, link => {
    try { return decodeURI(link.slice(7)) } catch { return link.slice(7) }
  })
  // The project folder is matched as written, because a real folder name can hold spaces.
  const folder = typeof root === 'string' && root.length > 1 ? root.replace(/\/+$/, '') : ''
  if (folder) {
    const literal = folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    value = value.replace(new RegExp(`${literal}(?:\\/|(?=[\\s.,;:!?)\\]"'\`]|$))`, 'g'), match => match.endsWith('/') ? '' : 'the project folder')
  }
  return value.replace(LOCAL_PATH, (match, before, path) => {
    const tail = path.match(TRAILING)?.[0] ?? ''
    const bare = tail ? path.slice(0, -tail.length) : path
    return `${before}${fileName(bare)}${tail}`
  })
}

function inline(text, root) {
  const held = []
  const hold = html => `${MARK}${held.push(html) - 1}${MARK}`
  let value = String(text)
  // Code spans and links are set aside first, so bold and path rules never rewrite inside them.
  value = value.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${escape(shortenPaths(code, root))}</code>`))
  value = value.replace(/\[([^\]\n]{1,300})\]\(([^()\s]{1,2000})\)/g, (_, label, target) => {
    const text = escape(shortenPaths(label, root))
    return hold(/^https:\/\/[^\s]+$/i.test(target) ? `<a href="${escape(target)}" target="_blank" rel="noopener noreferrer">${text}</a>` : text)
  })
  value = value.replace(/https:\/\/[^\s<>"'`)\]}]+/gi, url => {
    const tail = url.match(TRAILING)?.[0] ?? ''
    const link = tail ? url.slice(0, -tail.length) : url
    return `${hold(`<a href="${escape(link)}" target="_blank" rel="noopener noreferrer">${escape(link)}</a>`)}${tail}`
  })
  value = escape(shortenPaths(value, root)).replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
  return value.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (_, index) => held[Number(index)] ?? '')
}

const cells = line => {
  const parts = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
  return parts.map(part => part.trim())
}
const isRow = line => /^\s*\|.*\|\s*$/.test(line)
const isRule = line => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-')
const BULLET = /^\s*[-*•]\s+(.*)$/, NUMBER = /^\s*\d{1,3}[.)]\s+(.*)$/

/** The HTML for one message. */
export function messageHTML(text, { root = '' } = {}) {
  const lines = String(text ?? '').replaceAll(MARK, '').split('\n')
  const out = []
  let plain = [], block = false
  // Blank lines next to a table or list add no extra break; the block has its own margin.
  const flush = (next = false) => {
    if (block) while (plain.length && !plain[0].trim()) plain.shift()
    if (next) while (plain.length && !plain.at(-1).trim()) plain.pop()
    if (plain.length) out.push(plain.map(line => inline(line, root)).join('<br>'))
    plain = []; block = next
  }
  for (let i = 0; i < lines.length;) {
    const line = lines[i]
    if (isRow(line) && i + 1 < lines.length && isRule(lines[i + 1])) {
      flush(true)
      const head = cells(line), rows = []
      i += 2
      while (i < lines.length && isRow(lines[i])) rows.push(cells(lines[i++]))
      const row = (values, tag) => `<tr>${head.map((_, index) => `<${tag}>${inline(values[index] ?? '', root)}</${tag}>`).join('')}</tr>`
      out.push(`<div class="msg-table"><table><thead>${row(head, 'th')}</thead><tbody>${rows.map(values => row(values, 'td')).join('')}</tbody></table></div>`)
      continue
    }
    const kind = BULLET.test(line) ? 'ul' : NUMBER.test(line) ? 'ol' : null
    if (kind) {
      flush(true)
      const pattern = kind === 'ul' ? BULLET : NUMBER, items = []
      // A numbered list split by a blank or detail line keeps counting from the number it was given.
      const first = kind === 'ol' ? Number(line.match(/\d+/)[0]) : 1
      while (i < lines.length && pattern.test(lines[i])) items.push(lines[i++].match(pattern)[1])
      out.push(`<${kind}${first > 1 ? ` start="${first}"` : ''}>${items.map(item => `<li>${inline(item, root)}</li>`).join('')}</${kind}>`)
      continue
    }
    plain.push(line)
    i++
  }
  flush()
  return out.join('')
}
