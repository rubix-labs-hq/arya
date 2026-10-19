import fs from 'node:fs'
for await (const chunk of process.stdin) {}
const mode = process.env.ARYA_STREAM_CASE
const write = bytes => new Promise((resolve, reject) => process.stdout.write(bytes, error => error ? reject(error) : resolve()))
const message = text => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })
if (mode === 'images') {
  const base = process.env.REEL_AGENT_ENDPOINT, id = process.env.REEL_AGENT_RUN_ID
  const headers = { authorization: `Bearer ${process.env.REEL_AGENT_RUN_TOKEN}`, 'content-type': 'application/json' }
  for (let i = 0; i < 3; i++) {
    const { callID } = await (await fetch(new URL(`/v1/runs/${id}/calls`, base), { method: 'POST', headers, body: JSON.stringify({ frame: { at: i, width: 320 } }) })).json()
    let result
    for (let n = 0; n < 300; n++) {
      result = await (await fetch(new URL(`/v1/runs/${id}/calls/${callID}`, base), { headers })).json()
      if (!result.pending) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    if (!result.image) throw Error('Fixture expected an accepted frame result')
    await write(JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', result: { content: [{ type: 'image', data: result.image.data, mimeType: result.image.mediaType }] } } }) + '\n')
  }
  await write(message('Inspected three frames.') + '\n')
} else if (mode === 'coalesced') {
  await write(Array.from({ length: 1024 }, () => JSON.stringify({ type: 'ignored', data: 'x'.repeat(2048) }) + '\n').join('') + message('Complete records drained.') + '\n')
} else if (mode === 'unicode-tail') {
  const bytes = Buffer.from(message('Edited café 🎬'))
  for (const byte of bytes) await write(Buffer.from([byte]))
} else if (mode === 'malformed') {
  await write('{invalid JSON}\n' + message('Valid record after malformed output.') + '\n')
} else if (mode === 'oversized-record') {
  await write(Buffer.alloc(9 * 1024 * 1024, 120))
  setInterval(() => {}, 1000)
} else if (mode === 'raw-flood') {
  const line = JSON.stringify({ type: 'ignored', data: 'x'.repeat(512 * 1024) }) + '\n'
  for (let i = 0; i < 132; i++) await write(line)
  setInterval(() => {}, 1000)
} else if (mode === 'hold') {
  await write('{"type":"ignored","data":"' + 'x'.repeat(2 * 1024 * 1024))
  fs.writeFileSync(process.env.ARYA_STREAM_MARKER, String(process.pid))
  setInterval(() => {}, 1000)
} else throw Error('Unknown fixture case')
