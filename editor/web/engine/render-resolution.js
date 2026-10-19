// Policy bounds apply before allocation. They do not choose a smaller render size.
export const MAX_RENDER_EDGE = 8192
export const MAX_RASTER_BYTES = 256 * 1024 * 1024
export const MAX_GRAPH_BYTES = 512 * 1024 * 1024
export const MAX_RESIDENT_BYTES = 1024 * 1024 * 1024

export function rasterSize(width, height, scale = 1, { maxEdge = MAX_RENDER_EDGE, maxBytes = MAX_RASTER_BYTES, bytesPerPixel = 4, surfaces = 1, rounding = Math.ceil } = {}) {
  if (![width, height, scale, maxEdge, maxBytes, bytesPerPixel, surfaces].every(Number.isFinite) || width <= 0 || height <= 0 || scale <= 0 || maxEdge < 2 || maxBytes <= 0 || bytesPerPixel <= 0 || surfaces <= 0) throw new Error('Invalid render resolution or memory limit')
  const w = Math.max(2, rounding(width * scale)), h = Math.max(2, rounding(height * scale))
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w > maxEdge || h > maxEdge) throw new Error(`Render size ${w}×${h} exceeds the ${maxEdge}-pixel device or policy limit. Reduce the source or output size.`)
  const bytes = w * h * bytesPerPixel * surfaces
  if (!Number.isSafeInteger(bytes) || bytes > maxBytes) throw new Error(`Render size ${w}×${h} exceeds the memory limit. Reduce the source, output size or graph complexity.`)
  return { w, h, bytes }
}

export function graphSize(comp, source, width, height, scale, nodeCount) {
  if (!Number.isInteger(nodeCount) || nodeCount < 1 || nodeCount > 256) throw new Error('A node graph requires between 1 and 256 reachable nodes')
  // The pool retains each node plus at most three effect targets and one mixer target.
  return rasterSize(source.w ?? width * scale, source.h ?? height * scale, 1, {
    maxEdge: comp.renderMaxEdge?.() ?? MAX_RENDER_EDGE,
    maxBytes: MAX_GRAPH_BYTES, bytesPerPixel: comp.float ? 8 : 4, surfaces: nodeCount + 4, rounding: Math.round,
  })
}
