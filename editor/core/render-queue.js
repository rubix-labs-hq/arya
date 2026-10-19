export function createRenderQueue(runJob, failed) {
  const queue = []
  const accepted = new Set()
  let busy = false

  async function pump() {
    if (busy) return
    busy = true
    try {
      while (queue.length) {
        const item = queue.shift()
        try { await runJob(item) }
        catch (error) { await failed(item, error) }
      }
    } finally {
      busy = false
    }
  }

  return item => {
    if (accepted.has(item.job.id)) return false
    accepted.add(item.job.id)
    queue.push(item)
    void pump()
    return true
  }
}
