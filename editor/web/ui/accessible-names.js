// Screen readers name a button by its content, so a glyph button such as "⋯" is read as
// punctuation even when its title explains it, and a control beside a visual <label> in a
// .field row has no name at all. This fills in aria-label from the title or the label text
// for controls that have no accessible name, as they appear.

const NAMED = ['aria-label', 'aria-labelledby']
const glyphOnly = text => !/[\p{L}\p{N}]/u.test(text)
// Names this module wrote. They follow later title changes, such as "Hide layer" becoming
// "Show layer"; names an author wrote are never touched.
const written = new WeakSet()
const write = (el, name) => { el.setAttribute('aria-label', name); written.add(el) }

export function nameControl(el) {
  if (NAMED.some(name => el.hasAttribute(name)) && !written.has(el)) return
  if (el.matches('button, [role=button]')) {
    const title = el.getAttribute('title')?.trim()
    if (title && glyphOnly(el.textContent ?? '')) write(el, title)
    return
  }
  if (!el.matches('input:not([type=hidden]), select, textarea') || el.labels?.length) return
  // A field label names its control only when the field holds one control; several share no single name.
  const field = el.closest('.field'), label = field?.querySelector(':scope > label')
  const single = field?.querySelectorAll('input:not([type=hidden]), select, textarea').length === 1
  const text = single && label && !label.contains(el) ? label.textContent.trim() : ''
  if (text) write(el, text)
  else if (el.getAttribute('title')) write(el, el.getAttribute('title').trim())
}

export function nameControls(root) {
  if (root.nodeType !== 1) return
  if (root.matches('button, [role=button], input, select, textarea')) nameControl(root)
  for (const el of root.querySelectorAll('button, [role=button], input, select, textarea')) nameControl(el)
}

export function installAccessibleNames(root = document.body) {
  nameControls(root)
  let pending = new Set(), scheduled = false
  const flush = () => { scheduled = false; for (const node of pending) if (node.isConnected) nameControls(node); pending = new Set() }
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') pending.add(record.target)
      else for (const node of record.addedNodes) pending.add(node)
    }
    if (!scheduled && pending.size) { scheduled = true; requestAnimationFrame(flush) }
  })
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['title'] })
  return observer
}
