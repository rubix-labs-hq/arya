export function formatFileSize(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return 'Size unavailable'
  if (bytes < 1024) return `${bytes} bytes`
  const units = ['KB', 'MB', 'GB', 'TB'], index = Math.min(units.length - 1, Math.floor(Math.log2(bytes) / 10) - 1)
  const amount = bytes / 1024 ** (index + 1)
  return `${amount.toFixed(amount < 10 ? 1 : 0)} ${units[index]}`
}

/** Own one completed-file preview through deferred reads and project changes. */
export function createDeliveryPreview({ open, release, getRoot, changed }) {
  let token = 0, disposed = false, state = { phase: 'idle' }
  const publish = next => { state = next; if (!disposed) changed(state) }
  const clear = () => { if (state.receipt) release(state.receipt.previewID) }
  return {
    snapshot: () => state,
    async show(id, root) {
      if (disposed || root !== getRoot()) return false
      const owned = ++token; clear(); publish({ phase: 'loading' })
      try {
        const receipt = await open(id, root)
        if (disposed || owned !== token || root !== getRoot() || receipt.root !== root) { release(receipt.previewID); return false }
        publish({ phase: 'ready', receipt }); return true
      } catch (error) {
        if (!disposed && owned === token && root === getRoot()) publish({ phase: 'error', error: error.message })
        return false
      }
    },
    close() { token++; clear(); publish({ phase: 'idle' }) },
    dispose() { disposed = true; token++; clear(); state = { phase: 'idle' } },
  }
}
