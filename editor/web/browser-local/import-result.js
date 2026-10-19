const signature = asset => JSON.stringify(asset)

/** Resolve only the currently acknowledged import in its original project. */
export function importedMediaNavigation(receipt, backend, ui) {
  const current = backend.importState, record = backend.record
  if (!record || !receipt?.requestID || current.requestID !== receipt.requestID ||
      !['done', 'partial'].includes(receipt.state) || receipt.projectID !== record.id ||
      receipt.generation !== backend.generation || receipt.version > record.version ||
      ui.root !== `browser:${record.id}` || ui.version !== record.version) return null
  const entry = receipt.registered?.find(entry =>
    backend.files.has(entry.path) && signature(record.project.assets[entry.path]) === entry.assetJSON &&
    signature(ui.project?.assets?.[entry.path]) === entry.assetJSON)
  if (!entry) return null
  return { page: 'media', browserTab: 'media', viewerMode: 'source',
    source: { src: entry.path, t: 0, seekToken: (ui.source?.seekToken ?? 0) + 1 },
    mediaReveal: { requestID: receipt.requestID, root: ui.root, src: entry.path, seekToken: (ui.source?.seekToken ?? 0) + 1 } }
}
