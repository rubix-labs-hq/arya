// Keyboard handling for a modal dialog: Escape closes it and Tab stays inside it.

const CONTROLS = 'button, input, select, textarea, summary, a[href], [tabindex]:not([tabindex="-1"])'

/** The controls in `element` that can take focus now, in document order. */
export function dialogControls(element) {
  return [...element.querySelectorAll(CONTROLS)].filter(control => !control.matches(':disabled') && control.getClientRects().length)
}

/**
 * Handle a key pressed in an open dialog. Escape calls `close`. Tab wraps from the last control to
 * the first and back, and pulls focus in when it was outside. Returns true when it handled the key.
 */
export function dialogKey(event, element, close, doc = globalThis.document) {
  if (!element) return false
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close?.(); return true }
  if (event.key !== 'Tab') return false
  const controls = dialogControls(element), first = controls[0], last = controls.at(-1)
  const outside = !element.contains(doc.activeElement) || doc.activeElement === element
  if (!first) { event.preventDefault(); element.focus(); return true }
  if (event.shiftKey && (doc.activeElement === first || outside)) { event.preventDefault(); last.focus(); return true }
  if (!event.shiftKey && (doc.activeElement === last || outside)) { event.preventDefault(); first.focus(); return true }
  return false
}
