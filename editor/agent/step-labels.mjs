// Names for the step an agent's tool call performs. The assistant publishes them as its phase,
// and the panel prints the last one when nothing has arrived for a while, so each must say what
// the editor is doing in words a user reads. A label is built from the route, a count and a
// time only: never from request text, file names, paths or anything else in the call body.

const count = (number, noun) => `${number} ${noun}${number === 1 ? '' : 's'}`
const seconds = value => `${Math.round(value * 10) / 10}s`
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const GENERIC = { doing: 'Working with the project', done: 'worked with the project' }
const step = (doing, done) => ({ doing, done })
const JOB_WAIT = step('Waiting for a processing job', 'checked a processing job')

const ROUTES = {
  'GET /api/outline': step('Reading the project outline', 'read the project outline'),
  'GET /api/project': step('Reading the project', 'read the project'),
  'GET /api/describe': step('Reading clip details', 'read clip details'),
  'GET /api/caps': step('Checking what this editor can do', 'checked what this editor can do'),
  'GET /api/files': step('Listing project files', 'listed project files'),
  'GET /api/transcript': step('Reading the transcript', 'read the transcript'),
  'POST /api/transcript/import': step('Saving a supplied transcript', 'saved a supplied transcript'),
  'GET /api/assistant/history': step('Reading earlier messages', 'read earlier messages'),
  'GET /api/jobs/wait': JOB_WAIT, 'GET /api/analysis/jobs/wait': JOB_WAIT, 'GET /api/video/jobs/wait': JOB_WAIT,
  'POST /api/export': step('Starting an export', 'started an export'),
  'POST /api/audio/measure-mix': step('Measuring the mix', 'started measuring the mix'),
  'POST /api/undo': step('Undoing an edit', 'undid an edit'),
  'POST /api/redo': step('Redoing an edit', 'redid an edit'),
  'POST /api/ui/show': step('Showing a moment in the editor', 'showed a moment in the editor'),
  'GET /api/jobs': step('Checking processing jobs', 'checked processing jobs'),
  'GET /api/analysis/jobs': step('Checking processing jobs', 'checked processing jobs'),
  'GET /api/video/jobs': step('Checking processing jobs', 'checked processing jobs'),
  'POST /api/jobs/cancel': step('Stopping a processing job', 'stopped a processing job'),
  'POST /api/analysis/jobs/cancel': step('Stopping a processing job', 'stopped a processing job'),
  'POST /api/video/jobs/cancel': step('Stopping a processing job', 'stopped a processing job'),
  'GET /api/luts': step('Listing LUTs', 'listed LUTs'),
  'POST /api/luts/inspect': step('Reading a LUT', 'read a LUT'),
  'POST /api/luts/apply': step('Applying a LUT', 'applied a LUT'),
  'GET /api/interchange/files': step('Listing timeline files', 'listed timeline files'),
  'POST /api/interchange/export': step('Exporting a timeline file', 'exported a timeline file'),
  'POST /api/interchange/import': step('Importing a timeline file', 'imported a timeline file'),
  'GET /api/figma/status': step('Checking the Figma connection', 'checked the Figma connection'),
  'POST /api/figma/frames': step('Listing Figma frames', 'listed Figma frames'),
  'POST /api/figma/import': step('Importing from Figma', 'imported from Figma'),
  'POST /api/figma/import-mcp': step('Importing from Figma', 'imported from Figma'),
  'GET /api/audio/compose/capabilities': step('Checking what music can be made', 'checked what music can be made'),
  'POST /api/import': step('Importing media', 'imported media'),
  'POST /api/new': step('Starting a new project', 'started a new project'),
  'POST /api/transcript': step('Saving transcript corrections', 'saved transcript corrections'),
  'POST /api/transcript/edit': step('Cutting the video from the transcript', 'cut the video from the transcript'),
  'POST /api/captions/from-transcript': step('Making captions from the transcript', 'made captions from the transcript'),
  'POST /api/shorts/propose': step('Picking moments for shorts', 'picked moments for shorts'),
  'POST /api/shorts/build': step('Building the shorts', 'built the shorts'),
  'POST /api/audio/clean': step('Cleaning up the sound', 'cleaned up the sound'),
  'POST /api/audio/loudnorm': step('Levelling loudness', 'levelled loudness'),
  'POST /api/audio/compose': step('Composing music', 'composed music'),
  'POST /api/audio/compose/place': step('Placing music', 'placed music'),
  'POST /api/retime': step('Rendering a speed change', 'rendered a speed change'),
  'POST /api/stabilize/render': step('Rendering a steadied copy', 'rendered a steadied copy'),
  'POST /api/video/denoise': step('Reducing video noise', 'reduced video noise'),
  'POST /api/analysis/track': step('Tracking motion', 'tracked motion'),
  'POST /api/analysis/autoreframe': step('Working out a reframe', 'worked out a reframe'),
  'POST /api/analysis/saliency': step('Finding the subject', 'found the subject'),
  'POST /api/analysis/person-mask': step('Masking a person', 'masked a person'),
  'POST /api/looks/match': step('Matching a look', 'matched a look'),
  'POST /api/multicam/sync': step('Syncing camera angles', 'synced camera angles'),
}
const ANALYSES = {
  scenes: step('Finding scene changes', 'looked for scene changes'),
  silence: step('Finding silence', 'looked for silence'),
  beats: step('Finding beats', 'looked for beats'),
  loudness: step('Measuring loudness', 'measured loudness'),
  transcript: step('Starting a transcript', 'started a transcript'),
  stabilization: step('Measuring camera shake', 'measured camera shake'),
}

/**
 * {doing, done} for a tool event from the bridge: "Applying 3 edits" and "applied 3 edits".
 * `frameOf` says what a frame shows: 'preview' for the request's pending preview, 'project' for
 * the saved project while a preview could be shown instead. A person can then tell which was drawn.
 */
export function stepLabel(event, { frameOf = null } = {}) {
  try {
    if (!object(event)) return GENERIC
    if (object(event.frame)) {
      if (typeof event.frame.src === 'string') return step('Opening a reference image', 'opened a reference image')
      const at = Number.isFinite(event.frame.at) && event.frame.at >= 0 ? ` at ${seconds(event.frame.at)}` : ''
      const of = frameOf === 'preview' ? ' of the preview' : frameOf === 'project' ? ' of the saved project' : ''
      return step(`Rendering a frame${of}${at}`, `rendered a frame${of}${at}`)
    }
    if (typeof event.path !== 'string' || !['GET', 'POST'].includes(event.method)) return GENERIC
    const route = event.path.split('?')[0], body = object(event.body) ? event.body : {}
    const ops = Array.isArray(body.ops) ? body.ops.length : 0
    if (event.method === 'POST' && route === '/api/ops') return step(`Applying ${count(ops, 'edit')}`, `applied ${count(ops, 'edit')}`)
    if (event.method === 'POST' && route === '/api/assistant/propose') {
      const steps = Array.isArray(body.steps) ? body.steps.length : 0
      const holds = [ops || !steps ? count(ops, 'edit') : '', steps ? count(steps, 'processing step') : ''].filter(Boolean).join(' and ')
      return step(`Preparing a preview of ${holds}`, `prepared a preview of ${holds}`)
    }
    if (event.method === 'POST' && route === '/api/analyze' && Object.hasOwn(ANALYSES, body.kind)) return ANALYSES[body.kind]
    const known = ROUTES[`${event.method} ${route}`]
    if (known) return known
    // Any other route is named by its own path words, such as "audio loudnorm".
    const words = route.replace(/^\/api\//, '').replace(/[^a-zA-Z0-9]+/g, ' ').trim().toLowerCase().slice(0, 40).trim()
    return words ? step(`Running ${words}`, `ran ${words}`) : GENERIC
  } catch {
    return GENERIC
  }
}

/** The phase after a tool call, while the agent decides what to do next. No final period. A failure comes first. */
export const waitingAfter = (label, failed = false) => failed
  ? `A step failed (${label.doing.charAt(0).toLowerCase()}${label.doing.slice(1)}). Waiting for the agent’s next step`
  : `Waiting for the agent’s next step after it ${label.done}`

/** A progress label from an adapter, made safe to show: one line, at most 80 characters. */
export function progressLabel(value) {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
}
