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
  'POST /api/undo': step('Undoing an edit', 'undid an edit'),
  'POST /api/redo': step('Redoing an edit', 'redid an edit'),
  'POST /api/ui/show': step('Showing a moment in the editor', 'showed a moment in the editor'),
}
const ANALYSES = {
  scenes: step('Finding scene changes', 'looked for scene changes'),
  silence: step('Finding silence', 'looked for silence'),
  beats: step('Finding beats', 'looked for beats'),
  loudness: step('Measuring loudness', 'measured loudness'),
  transcript: step('Starting a transcript', 'started a transcript'),
  stabilization: step('Measuring camera shake', 'measured camera shake'),
}

/** {doing, done} for a tool event from the bridge: "Applying 3 edits" and "applied 3 edits". */
export function stepLabel(event) {
  try {
    if (!object(event)) return GENERIC
    if (object(event.frame)) {
      if (typeof event.frame.src === 'string') return step('Opening a reference image', 'opened a reference image')
      const at = Number.isFinite(event.frame.at) && event.frame.at >= 0 ? ` at ${seconds(event.frame.at)}` : ''
      return step(`Rendering a frame${at}`, `rendered a frame${at}`)
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

/** The phase after a tool call, while the agent decides what to do next. No final period. */
export const waitingAfter = (label, failed = false) => failed
  ? `Waiting for the agent’s next step after a step that failed: ${label.doing.charAt(0).toLowerCase()}${label.doing.slice(1)}`
  : `Waiting for the agent’s next step after it ${label.done}`

/** A progress label from an adapter, made safe to show: one line, at most 80 characters. */
export function progressLabel(value) {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
}
