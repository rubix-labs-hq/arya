import * as core from '/core/project.js'
import { validateExportSpec } from '/core/processing-export.js'
import { BrowserStorage } from './storage.js'
import { BrowserBackend } from './backend.js'
import * as media from './media.js'

const element = document.getElementById('app')
try {
  const storage = await new BrowserStorage().open()
  const backend = await new BrowserBackend({ storage, media, core, validateExportSpec }).initialize()
  if (!backend.codecCaps.gpu) throw new Error('Arya needs WebGL 2 for GPU preview. Enable hardware acceleration or use another current browser.')
  window.__aryaBrowserHost = backend
  window.addEventListener('beforeunload', event => {
    if (backend.importController || [...backend.jobs.values()].some(job => ['running', 'queued', 'cancelling', 'committing'].includes(job.state))) { event.preventDefault(); event.returnValue = '' }
  })
  await import('../main.js')
} catch (error) {
  element.replaceChildren()
  const section = document.createElement('section'); section.className = 'browser-start-error'
  const heading = document.createElement('h1'); heading.textContent = 'Arya could not open this browser workspace'
  const message = document.createElement('p'); message.textContent = error.message
  const guidance = document.createElement('p'); guidance.textContent = 'Keep website data and original media. Try reopening in a current Safari, Chrome or Edge browser. Private windows and storage restrictions can prevent project storage.'
  const retry = document.createElement('button'); retry.textContent = 'Retry opening'; retry.onclick = () => location.reload()
  section.append(heading, message, guidance, retry); element.append(section)
}
