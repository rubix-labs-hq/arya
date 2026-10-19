/** Reads a standalone 3D CUBE table. Domain bounds describe its input coordinates. */
export function parseCube(text) {
  if (typeof text !== 'string' || text.length > 128 * 1024 * 1024) throw new Error('CUBE file exceeds 128 MiB')
  let size = 0, domainMin = [0, 0, 0], domainMax = [1, 1, 1]
  const data = [], headers = new Set()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim()
    if (!line) continue
    const parts = line.split(/\s+/), key = parts[0]
    if (key === 'TITLE') { if (data.length) throw new Error('CUBE headers must precede data'); continue }
    if (['LUT_3D_SIZE', 'DOMAIN_MIN', 'DOMAIN_MAX', 'LUT_3D_INPUT_RANGE'].includes(key)) {
      if (data.length || headers.has(key)) throw new Error(`invalid CUBE header ${key}`)
      headers.add(key)
      const values = parts.slice(1).map(Number)
      if (!values.every(Number.isFinite)) throw new Error(`invalid CUBE header ${key}`)
      if (key === 'LUT_3D_SIZE') {
        size = values[0]
        if (values.length !== 1 || !Number.isInteger(size) || size < 2 || size > 128) throw new Error('CUBE size must be 2 through 128')
      } else if (key === 'LUT_3D_INPUT_RANGE') {
        if (values.length !== 2 || headers.has('DOMAIN_MIN') || headers.has('DOMAIN_MAX')) throw new Error('conflicting CUBE input domains')
        domainMin = Array(3).fill(values[0]); domainMax = Array(3).fill(values[1])
      } else {
        if (values.length !== 3 || headers.has('LUT_3D_INPUT_RANGE')) throw new Error('conflicting CUBE input domains')
        if (key === 'DOMAIN_MIN') domainMin = values
        else domainMax = values
      }
    } else {
      const values = parts.map(Number)
      if (!size || values.length !== 3 || !values.every(v => Number.isFinite(v) && Math.abs(v) <= 65504)) throw new Error('invalid or unsupported 3D CUBE data')
      data.push(...values)
      if (data.length > size ** 3 * 3) throw new Error('CUBE contains too many rows')
    }
  }
  if (!size || data.length !== size ** 3 * 3) throw new Error('CUBE row count does not match its size')
  if (domainMin.some((v, i) => v >= domainMax[i])) throw new Error('CUBE domain maximum must exceed its minimum')
  return { size, domainMin, domainMax, data: new Float32Array(data) }
}
