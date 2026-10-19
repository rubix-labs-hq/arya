// Source fixtures load UI modules through data URLs. Resolve their added browser-host dependencies.
import { registerHooks } from 'node:module'
const files = {
  '../host.js': '../../web/host.js',
  './media-label.js': '../../web/ui/media-label.js',
  './layout.js': '../../web/ui/layout.js',
  '../browser-local/delivery-preview.js': '../../web/browser-local/delivery-preview.js',
  './delivery-preview.js': '../../web/ui/delivery-preview.js',
}
registerHooks({ resolve(specifier, context, next) {
  const file = context.parentURL?.startsWith('data:') && files[specifier]
  return next(file ? new URL(file, import.meta.url).href : specifier, context)
} })
