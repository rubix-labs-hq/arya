// Font families the editor can name with some confidence. Bundled fonts ship with the editor
// (web/fonts, loaded in web/engine/media.js) and draw the same everywhere. System fonts are the
// families the title inspector offers; they are not checked on this machine. Any family the
// machine lacks falls back to a system sans (FONT_FALLBACK in web/engine/media.js), with no error.

export const BUNDLED_FONTS = ['Inter', 'Mrs Saint Delafield']

export const SYSTEM_FONTS = ['Avenir Next', 'Helvetica Neue', 'SF Pro Display', 'Futura', 'Gill Sans', 'Optima', 'Didot', 'Georgia', 'Baskerville', 'Times New Roman', 'Menlo', 'Courier New', 'Impact', 'Arial Black', 'Copperplate', 'Marker Felt', 'Chalkboard', 'American Typewriter', 'Rockwell', 'Bodoni 72']

// Families the fallback stack and CSS resolve on their own.
const GENERIC = ['helvetica', 'arial', 'sans-serif', 'serif', 'monospace', 'system-ui', '-apple-system']

const KNOWN = new Set([...BUNDLED_FONTS, ...SYSTEM_FONTS].map(name => name.toLowerCase()).concat(GENERIC))

/** Whether a family is bundled, offered by the inspector or generic. No family (the default) is known. */
export function knownFont(name) {
  if (name === undefined || name === null || name === '') return true
  return typeof name === 'string' && KNOWN.has(name.trim().toLowerCase())
}
