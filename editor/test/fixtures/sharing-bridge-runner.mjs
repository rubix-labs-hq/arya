import { startBridge } from '../../agent/bridge.mjs'
import { fixtureBridgeOptions } from './sharing-fixture.mjs'
const bridge = await startBridge(fixtureBridgeOptions({ custom: { executable: process.execPath, args: process.argv.slice(2) } }))
process.stdout.write(`${JSON.stringify(bridge.pairing)}\n`)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void bridge.close().then(() => process.exit(0)) })
