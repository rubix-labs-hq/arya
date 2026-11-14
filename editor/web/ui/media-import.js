// Shared browser import outcomes. Only the backend's imported assets count as imports.
function importReceipt(result, expectedCount) {
  if (result?.error) throw new Error(result.error)
  if (!result?.assets || typeof result.assets !== 'object' || Array.isArray(result.assets)) {
    throw new Error('The import service did not return an import result. Try again.')
  }
  const count = Object.keys(result.assets).length
  const expected = Number.isSafeInteger(expectedCount) && expectedCount >= 0 ? expectedCount : null
  const failures = Array.isArray(result.failures) ? result.failures.filter(item => item?.stage === 'identity' && typeof item.error === 'string') : []
  const warnings = Array.isArray(result.warnings) ? result.warnings.filter(item => item?.stage === 'identity' && typeof item.message === 'string') : []
  return { count, expected, partial: expected !== null && count < expected, assets: result.assets, failures, warnings }
}

function reportImport(receipt, notify) {
  if (receipt.count === 0) {
    notify('No media was imported. The files may be unsupported or unreadable.', 'error')
  } else if (receipt.partial) {
    notify(`Imported ${receipt.count} of ${receipt.expected} files. Some files could not be imported.`)
  } else {
    notify(`Imported ${receipt.count} file${receipt.count === 1 ? '' : 's'}`)
  }
  for (const item of receipt.failures.slice(0, 3)) notify(`${item.name || 'Music'}: ${item.error}`, 'error')
  for (const item of receipt.warnings.slice(0, 3)) notify(`${item.name || 'Music'}: ${item.message}`, 'info')
}

function reportFailure(error, notify) {
  notify(`Import failed: ${error?.message || String(error)}`, 'error')
}

/** Resolves a receipt or null on failure, so event handlers cannot lose API rejections. */
export async function importMediaPaths(paths, { request, notify, expectedCount } = {}) {
  if (!paths.length) return null
  try {
    const receipt = importReceipt(await request('/api/import', { paths }), expectedCount)
    reportImport(receipt, notify)
    return receipt
  } catch (error) {
    reportFailure(error, notify)
    return null
  }
}

/** Uploaded files can fail probing. Success reports only the later import result. */
export async function uploadMediaFiles(files, { upload, request, notify, assets = {} } = {}) {
  if (!files.length) return null
  const paths = []
  let failed = 0
  // The existing import metadata has byte size and filename, but no content hash.
  const known = new Set(Object.entries(assets).filter(([, asset]) => Number.isSafeInteger(asset.size)).map(([path, asset]) => `${path.split('/').pop()}\0${asset.size}`))
  for (const file of files) {
    const identity = `${file.name}\0${file.size}`
    if (Number.isSafeInteger(file.size) && known.has(identity)) {
      notify(`Skipped ${file.name}. A file with the same name and size is already in this project.`, 'info')
      continue
    }
    try {
      notify(`Uploading ${file.name}…`)
      const result = await upload(file)
      if (result?.error) throw new Error(`Could not upload ${file.name}: ${result.error}`)
      if (typeof result?.path !== 'string' || !result.path.length) {
        throw new Error(`Could not upload ${file.name}. The upload service did not return a file.`)
      }
      paths.push(result.path)
      if (Number.isSafeInteger(file.size)) known.add(identity)
    } catch (error) {
      failed++
      reportFailure(new Error(`${file.name}: ${error?.message || String(error)}`), notify)
    }
  }
  // Completed uploads are durable files. A later failure must not strand them
  // outside the project catalog, or prevent the rest of the selection importing.
  const uniquePaths = [...new Set(paths)]
  if (!uniquePaths.length) return null
  return await importMediaPaths(uniquePaths, { request, notify, expectedCount: uniquePaths.length + failed })
}
