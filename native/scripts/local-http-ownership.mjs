// Preload only for legacy local render harnesses. Refuse HTTP until the spawned
// server's on-disk receipt AND live project root prove ownership. No source rewrite.
import cp from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import {EventEmitter} from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import {syncBuiltinESMExports} from 'node:module'
import {pathToFileURL, urlToHttpOptions} from 'node:url'

const owned = new Map()
const rawSpawn = cp.spawn
const rawFetch = globalThis.fetch
const rawTemp = fs.mkdtempSync
const temporary = path.resolve(process.env.TMPDIR)
const ownershipLog = process.env.ARYA_OWNERSHIP_LOG
function record(event, state) {
  if (!ownershipLog) return
  if (fs.existsSync(ownershipLog) && fs.lstatSync(ownershipLog).isSymbolicLink()) throw Error('Unsafe ownership evidence log')
  fs.appendFileSync(ownershipLog, JSON.stringify({event, at: new Date().toISOString(), harnessPID: process.pid, serverPID: state.child.pid ?? null, root: state.root, port: state.port})+'\n')
}
const expectedServer = path.resolve(process.env.ARYA_OWNED_SERVER)
const within = (root, base) => root !== base && !path.relative(base, root).startsWith('..') && !path.isAbsolute(path.relative(base, root))
// Redirect temporary directories into this run's owned tree. A prefix whose real parent is
// already inside it, such as export staging in a temporary project, stays where it is; a
// symlink inside the tree cannot carry a directory out of it.
const realTemporary = fs.realpathSync(temporary)
fs.mkdtempSync = (prefix, ...rest) => {
  let parent
  try { parent = fs.realpathSync(path.dirname(path.resolve(String(prefix)))) } catch { parent = null }
  const owned = parent !== null && (parent === realTemporary || within(parent, realTemporary))
  return rawTemp(owned ? prefix : path.join(temporary, path.basename(String(prefix))), ...rest)
}
// A test may run a copy of the server that it wrote into the owned tree. The copy
// gets the same root, receipt and live-root proofs as the original server.
const ownedServerCopy = arg => {
  const file = path.resolve(String(arg))
  return within(file, temporary) && /\.m?js$/.test(file) && fs.existsSync(file) && fs.realpathSync(file) === file && fs.statSync(file).isFile()
}
// libxml's --dtdvalid argument is a URI. Relocated fixture directories can have
// spaces even though the original test copied its DTD to a space-free tmpdir.
// Encode only real files in this run's owned temporary tree; keep validation,
// DTD bytes, XML input, all other commands and external fixture paths unchanged.
const rawExecFileSync = cp.execFileSync
cp.execFileSync = function(command, args = [], options) {
  let forwarded = args
  if (path.basename(String(command)) === 'xmllint' && Array.isArray(args)) {
    const index = args.indexOf('--dtdvalid') + 1
    if (index > 0 && typeof args[index] === 'string' && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(args[index])) {
      const target = path.resolve(args[index])
      if (within(target, temporary) && fs.existsSync(target) && fs.realpathSync(target) === target && fs.statSync(target).isFile()) {
        forwarded = [...args]
        forwarded[index] = pathToFileURL(target).href
      }
    }
  }
  return rawExecFileSync.call(this, command, forwarded, options)
}

cp.spawn = function(command, args = [], options) {
  const index = args.findIndex(arg => path.resolve(String(arg)) === expectedServer || ownedServerCopy(arg) && args.includes('--root') && args.includes('--port'))
  if (index < 0) return rawSpawn.call(this, command, args, options)
  const root = path.resolve(args[args.indexOf('--root') + 1] ?? '')
  const port = Number(args[args.indexOf('--port') + 1])
  if (!within(root, temporary) || fs.realpathSync(root) !== root || !Number.isInteger(port) || port < 1 || port > 65535) throw Error('Unsafe verification server root/port')
  const child = rawSpawn.call(this, command, args, options)
  const state = {child, root, port, error: null, closing: false, proven: false}
  record('spawn', state)
  const fail = () => { record('exit-or-error', state); if (process.env.ARYA_GUARD_FAILFAST === '1' && !state.closing) { console.error('Owned verification server exited or failed'); process.exit(1) } }
  child.once('error', error => { state.error = error; fail() })
  child.once('exit', fail)
  owned.set(`http://127.0.0.1:${port}`, state)
  return child
}
// The opt-in hook accepts only a successful numeric loopback port-zero bind.
// Its proof belongs to that binding generation, never an attempted listen or a
// fixture's replaceable address()/listening facade.
const ephemeralBindings = new WeakMap(), mockListeners = new Map()
const rawListen = net.Server.prototype.listen, rawClose = net.Server.prototype.close
const rawAddress = net.Server.prototype.address
const rawListening = Object.getOwnPropertyDescriptor(net.Server.prototype, 'listening').get
const rawOnce = EventEmitter.prototype.once, rawRemoveListener = EventEmitter.prototype.removeListener
const rawEmit = EventEmitter.prototype.emit
const loopback = address => address && typeof address !== 'string' && ['127.0.0.1', '::1'].includes(address.address) && Number.isInteger(address.port) && address.port > 0 && address.port <= 65535
function invalidateBinding(server, state) {
  if (!state) return
  if (ephemeralBindings.get(server) === state) ephemeralBindings.delete(server)
  if (state.binding && mockListeners.get(state.binding.origin)?.binding === state.binding) mockListeners.delete(state.binding.origin)
  for (const [event, listener] of state.listeners) rawRemoveListener.call(server, event, listener)
}
function nativeListeningFacade(server) {
  for (let prototype = server; prototype; prototype = Object.getPrototypeOf(prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'listening')
    if (descriptor) return prototype === net.Server.prototype && descriptor.get === rawListening
  }
  return false
}
function genuineBinding(server, binding) {
  if (!(server instanceof http.Server) || server.address !== rawAddress || !nativeListeningFacade(server)) return false
  const state = ephemeralBindings.get(server), address = rawAddress.call(server)
  return state?.binding === binding && rawListening.call(server) && loopback(address) && address.address === binding.address && address.port === binding.port && address.family === binding.family
}
http.Server.prototype.listen = function(...args) {
  // A rejected second listen leaves the existing generation unchanged.
  if (rawListening.call(this)) return rawListen.apply(this, args)
  invalidateBinding(this, ephemeralBindings.get(this))
  const bindArgs = [...args]
  if (args[0] && typeof args[0] === 'object') {
    const settings = {...args[0]}
    for (const key of ['port', 'host', 'path', 'fd', 'handle', '_handle']) if (!Object.hasOwn(settings, key) && key in args[0]) settings[key] = args[0][key]
    bindArgs[0] = settings
  }
  const spec = bindArgs[0], port = typeof spec === 'object' ? spec?.port : spec
  const host = typeof spec === 'object' ? spec?.host : bindArgs[1]
  const direct = typeof spec !== 'object' || ['path', 'fd', 'handle', '_handle'].every(key => spec?.[key] == null)
  const state = {eligible: direct && port === 0 && ['127.0.0.1', '::1'].includes(host), binding: null, listeners: []}
  ephemeralBindings.set(this, state)
  const onListening = () => {
    const address = rawAddress.call(this)
    if (ephemeralBindings.get(this) !== state || !state.eligible || !rawListening.call(this) || !loopback(address) || address.address !== host) return
    const origin = `http://${address.address === '::1' ? '[::1]' : address.address}:${address.port}`
    state.binding = Object.freeze({origin, address: address.address, port: address.port, family: address.family})
  }
  const onClose = () => invalidateBinding(this, state)
  state.listeners = [['listening', onListening], ['close', onClose]]
  for (const [event, listener] of state.listeners) rawOnce.call(this, event, listener)
  try { return rawListen.apply(this, bindArgs) }
  catch (error) { invalidateBinding(this, state); throw error }
}
// Observe failure without adding an error listener or swallowing Node errors.
http.Server.prototype.emit = function(event, ...args) {
  if (event === 'error') invalidateBinding(this, ephemeralBindings.get(this))
  return rawEmit.call(this, event, ...args)
}
http.Server.prototype.close = function(...args) {
  // Invalidate on close admission, including while connections delay 'close'.
  invalidateBinding(this, ephemeralBindings.get(this))
  return rawClose.apply(this, args)
}
Object.defineProperty(globalThis, Symbol.for('arya.verification.registerOwnedEphemeralHTTP'), {
  value(server) {
    const binding = server instanceof http.Server && ephemeralBindings.get(server)?.binding
    if (!binding || !genuineBinding(server, binding)) throw Error('Fixture must own a live ephemeral loopback HTTP listener')
    if (mockListeners.get(binding.origin)?.binding !== binding) {
      mockListeners.set(binding.origin, Object.freeze({server, binding}))
      record('ephemeral-fixture-admitted', {child: {pid: process.pid}, root: null, port: binding.port})
    }
    return binding.origin
  }, writable: false, configurable: false,
})
syncBuiltinESMExports()
const alive = state => {
  if (state.error || state.child.exitCode !== null || state.child.signalCode !== null || !state.child.pid) throw Error('Owned verification server exited or failed')
}
function authorizeMock(url) {
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('External HTTP is forbidden during local verification')
  if (url.pathname.startsWith('/api/')) {
    const admitted = mockListeners.get(url.origin)
    if (!admitted || !genuineBinding(admitted.server, admitted.binding)) throw Error('Editor API has no owned verification server')
    return Object.freeze({kind: 'ephemeral', origin: url.origin, admitted})
  }
  return Object.freeze({kind: 'broker', url: url.href})
}
function recheckAuthorization(token) {
  if (token.kind === 'ephemeral') {
    const {admitted} = token
    if (mockListeners.get(token.origin) !== admitted || !genuineBinding(admitted.server, admitted.binding)) throw Error('Editor API has no owned verification server')
  } else if (token.kind === 'owned') {
    const {state} = token
    if (owned.get(token.origin) !== state || state.child.pid !== token.pid || state.root !== token.root || state.port !== token.port) throw Error('Owned verification server changed')
    alive(state)
    const receipt = JSON.parse(fs.readFileSync(path.join(token.root, '.reel/server.json'), 'utf8'))
    if (receipt.pid !== token.pid || receipt.port !== token.port || receipt.root !== token.root) throw Error('Owned server receipt changed')
  } else {
    authorizeMock(new URL(token.url)) // Preserve the ordinary mock-broker policy.
  }
}
async function authorize(url) {
  const state = owned.get(url.origin)
  if (!state) {
    return authorizeMock(url) // Capture the exact admitted generation before yielding.
  }
  alive(state)
  const receipt = JSON.parse(fs.readFileSync(path.join(state.root, '.reel/server.json'), 'utf8'))
  if (receipt.pid !== state.child.pid || receipt.port !== state.port || receipt.root !== state.root) throw Error('Owned server receipt mismatch')
  const proof = await rawFetch(`${url.origin}/api/project`, {signal: AbortSignal.timeout(2000), redirect: 'error'})
  if (!proof.ok || (await proof.json()).root !== state.root) throw Error('Live server project root mismatch')
  alive(state)
  // Re-read immediately before the original request, including the first /api/new.
  const current = JSON.parse(fs.readFileSync(path.join(state.root, '.reel/server.json'), 'utf8'))
  if (current.pid !== state.child.pid || current.port !== state.port || current.root !== state.root) throw Error('Owned server receipt changed')
  if (!state.proven) { record('receipt-and-live-root-proven', state); state.proven = true }
  return Object.freeze({kind: 'owned', origin: url.origin, state, pid: state.child.pid, root: state.root, port: state.port})
}
globalThis.fetch = async function(input, options) {
  // Snapshot the actual request before async proof. Reject caller transport
  // routing; a redirect can never leave the authorized listener.
  const init = {...options}
  if (init.dispatcher != null) throw Error('Custom fetch dispatcher is forbidden during local verification')
  if (init.redirect != null && !['error', 'manual'].includes(init.redirect)) throw Error('Fetch redirects are forbidden during local verification')
  const request = new Request(input, {...init, redirect: 'error'})
  const url = new URL(request.url)
  const token = await authorize(url)
  recheckAuthorization(token) // No await between this same-generation check and dispatch.
  if (token.kind === 'owned' && url.pathname === '/api/shutdown') token.state.closing = true
  return rawFetch(request, {redirect: 'error'})
}
// URL secondary options may configure the request body/headers, but cannot
// change routing. Object-form destinations are snapshotted and normalized once.
const rawRequest = http.request
function verificationRequest(args) {
  const first = args[0], hasURL = typeof first === 'string' || first instanceof URL
  let options, callback
  if (hasURL) {
    const url = new URL(String(first)), secondary = typeof args[1] === 'function' ? {} : {...args[1]}
    for (const key of ['protocol', 'hostname', 'host', 'port', 'path', 'defaultPort']) if (secondary[key] !== undefined) throw Error('Secondary HTTP options cannot override verification routing')
    options = {...urlToHttpOptions(url), ...secondary}
    callback = typeof args[1] === 'function' ? args[1] : args[2]
  } else {
    options = {...first}; callback = args[1]
  }
  for (const key of ['createConnection', 'lookup', 'socketPath', '_defaultAgent']) if (options[key] != null) throw Error('Custom HTTP transport is forbidden during local verification')
  if (options.agent != null && options.agent !== false) throw Error('Custom HTTP agent is forbidden during local verification')
  const protocol = options.protocol || 'http:', host = options.hostname || options.host || 'localhost', port = Number(options.port || options.defaultPort || 80), requestPath = options.path || '/'
  if (protocol !== 'http:' || typeof host !== 'string' || !['127.0.0.1', 'localhost', '::1'].includes(host)) throw Error('External HTTP is forbidden during local verification')
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof requestPath !== 'string' || !requestPath.startsWith('/') || requestPath.startsWith('//')) throw Error('Invalid verification HTTP destination')
  const url = new URL(`http://${host === '::1' ? '[::1]' : host}:${port}${requestPath}`)
  return {url, options: {...options, protocol, hostname: host, port, path: requestPath}, callback}
}
http.request = function(...args) {
  const {url, options, callback} = verificationRequest(args)
  if (!owned.has(url.origin)) {
    // Preserve partial writes/flushHeaders for admitted fixtures and mock brokers.
    // All denied routing/transport requests fail before a ClientRequest/socket.
    authorizeMock(url)
    return rawRequest.call(this, options, callback)
  }
  const request = rawRequest.call(this, options, callback)
  const write = request.write.bind(request), end = request.end.bind(request), flush = request.flushHeaders.bind(request)
  const buffered = []; let ended = false; let headers = false
  request.write = (...values) => { buffered.push(values); return true }
  request.flushHeaders = () => { headers = true }
  request.end = (...values) => {
    if (ended) throw Error('Verification request ended twice')
    ended = true
    authorize(url).then(token => {
      if (request.destroyed) return
      recheckAuthorization(token)
      if (token.kind === 'owned' && url.pathname === '/api/shutdown') token.state.closing = true
      if (headers) flush()
      for (const values of buffered) write(...values)
      end(...values)
    }).catch(error => request.destroy(error))
    return request
  }
  return request
}
http.get = function(...args) { const request = http.request(...args); request.end(); return request }
syncBuiltinESMExports()
process.once('exit', () => {
  for (const {child} of owned.values()) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
})
