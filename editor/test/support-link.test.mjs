import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveSupportLink, validSupportURL } from '../web/ui/support-link.js'
import supportRoutes, { SUPPORT_URL } from '../routes/support.mjs'

const meta = content => ({ querySelector: selector => selector === 'meta[name="arya-support-url"]' && content !== undefined ? { content } : null })

test('native hosts never resolve a website link or ask the host', async () => {
  let asked = 0
  const request = async () => { asked++; return { url: SUPPORT_URL } }
  for (const kind of ['native', undefined, 'other']) {
    assert.equal(await resolveSupportLink({ kind, document: meta('https://editwitharya.app/support/?channel=web-beta'), request }), null)
  }
  assert.equal(asked, 0)
})

test('the local editor uses its server route and the route passes validation', async () => {
  const route = supportRoutes().routes['GET /api/support-link']
  const paths = []
  const url = await resolveSupportLink({ kind: 'http', request: async path => { paths.push(path); return route() } })
  assert.deepEqual(paths, ['/api/support-link'])
  assert.equal(url, 'https://editwitharya.app/support/?channel=local-editor')
})

test('the local editor shows no link when the server lacks the route', async () => {
  assert.equal(await resolveSupportLink({ kind: 'http', request: async () => { throw Error('Not found') } }), null)
  assert.equal(await resolveSupportLink({ kind: 'http', request: async () => ({}) }), null)
  assert.equal(await resolveSupportLink({ kind: 'http' }), null)
})

test('the hosted beta reads only its publish-time meta tag', async () => {
  let asked = 0
  const request = async () => { asked++; return { url: SUPPORT_URL } }
  assert.equal(await resolveSupportLink({ kind: 'browser-local', document: meta('https://editwitharya.app/support/?channel=web-beta'), request }), 'https://editwitharya.app/support/?channel=web-beta')
  assert.equal(await resolveSupportLink({ kind: 'browser-local', document: meta(undefined), request }), null)
  assert.equal(await resolveSupportLink({ kind: 'browser-local', document: undefined, request }), null)
  assert.equal(asked, 0)
})

test('only an https support page for the host channel is accepted', () => {
  const ok = 'https://editwitharya.app/support/?channel=web-beta'
  assert.equal(validSupportURL(ok, 'browser-local'), ok)
  for (const bad of [
    'http://editwitharya.app/support/?channel=web-beta',
    'https://editwitharya.app/support/?channel=local-editor',
    'https://editwitharya.app/support/?channel=web-beta&amount=5',
    'https://editwitharya.app/support/',
    'https://editwitharya.app/support?channel=web-beta',
    'https://editwitharya.app/download/?channel=web-beta',
    'https://buy.stripe.com/support/?channel=web-beta#x',
    'https://user:pass@editwitharya.app/support/?channel=web-beta',
    'https://editwitharya.app:8443/support/?channel=web-beta',
    'javascript:alert(1)', '', null, 42,
  ]) assert.equal(validSupportURL(bad, 'browser-local'), null, String(bad))
  assert.equal(validSupportURL(ok, 'native'), null)
})
