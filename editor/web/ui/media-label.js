// Names are display metadata. The original source path remains every media operation's identity.
export function mediaDisplayName(src, asset = {}) {
  const name = typeof asset?.name === 'string' ? asset.name.trim() : ''
  return name || String(src ?? '').split('/').pop()
}

export function mediaDisplayModel(src, asset = {}) {
  const filename = String(src ?? '').split('/').pop(), name = mediaDisplayName(src, asset)
  return { name, filename, tooltip: name === filename ? src : `${name}\n${src}` }
}

export function mediaMatchesQuery(src, asset, query = '') {
  const needle = String(query).toLowerCase()
  return String(src).toLowerCase().includes(needle) || mediaDisplayName(src, asset).toLowerCase().includes(needle)
}
