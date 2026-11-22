// Source fixtures load UI modules through data URLs. Resolve their added browser-host dependencies.
import { registerHooks } from 'node:module'
const files = {
  './magnetic.js': '../../web/ui/magnetic.js',
  './assistant-context.js': '../../web/ui/assistant-context.js',
  '../host.js': '../../web/host.js',
  './media-label.js': '../../web/ui/media-label.js',
  './layout.js': '../../web/ui/layout.js',
  '../browser-local/delivery-preview.js': '../../web/browser-local/delivery-preview.js',
  './delivery-preview.js': '../../web/ui/delivery-preview.js',
}
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('/core/')) return next(new URL('../..' + specifier, import.meta.url).href, context)
  const file = context.parentURL?.startsWith('data:') && files[specifier]
  return next(file ? new URL(file, import.meta.url).href : specifier, context)
} })
