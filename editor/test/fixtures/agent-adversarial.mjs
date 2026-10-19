import { spawn } from 'node:child_process'
import fs from 'node:fs'
for await (const chunk of process.stdin) {}
const mode = process.argv[2], marker = process.argv[3]
if (marker) fs.writeFileSync(marker, String(process.pid))
if (mode === 'flood') {
  for (let i = 0; i < 4300; i++) process.stdout.write(JSON.stringify({ type: 'text', text: 'x'.repeat(1800) }) + '\n')
} else if (mode === 'done') {
  const proxy = spawn(process.execPath, [process.argv[4]], { stdio: ['pipe', 'ignore', 'inherit'], env: process.env })
  fs.writeFileSync(marker + '.mcp', String(proxy.pid))
  process.stdout.write(JSON.stringify({ type: 'done', text: 'Complete' }) + '\n')
} else if (mode === 'calls') {
  const base = process.env.REEL_AGENT_ENDPOINT, id = process.env.REEL_AGENT_RUN_ID
  const headers = { authorization: `Bearer ${process.env.REEL_AGENT_RUN_TOKEN}`, 'content-type': 'application/json' }
  for (let i = 0; i < 8; i++) await fetch(new URL(`/v1/runs/${id}/calls`, base), { method: 'POST', headers, body: JSON.stringify({ frame: { at: i, width: 320 } }) })
}
setInterval(() => {}, 1000)
