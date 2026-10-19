// Built-in titles use a 1920 by 1080 layout. Fit that layout to the active canvas.
export function titlePresetOp(project, preset, { start, track } = {}) {
  const width = Number.isFinite(project?.width) && project.width > 0 ? project.width : 1920
  const height = Number.isFinite(project?.height) && project.height > 0 ? project.height : 1080
  const scale = Math.min(width / 1920, height / 1080)
  const title = structuredClone(preset.title ?? {})
  if (title.shadow === undefined) title.shadow = { color: '#00000099', blur: 18, x: 0, y: 6 }
  for (const key of ['size', 'tracking', 'padding', 'radius']) {
    if (typeof title[key] === 'number') title[key] *= scale
  }
  if (title.stroke && typeof title.stroke.width === 'number') title.stroke.width *= scale
  if (title.shadow && typeof title.shadow === 'object') {
    for (const key of ['blur', 'x', 'y']) if (typeof title.shadow[key] === 'number') title.shadow[key] *= scale
  }
  const set = structuredClone(preset.set ?? {})
  if (typeof set.x === 'number') set.x *= width / 1920
  if (typeof set.y === 'number') set.y *= height / 1080
  return { op: 'add_title', ...(track ? { track } : {}), start, dur: 4, text: preset.text, title, ...(preset.set ? { set } : {}) }
}
