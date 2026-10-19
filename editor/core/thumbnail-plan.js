// Larger media-bin previews use a separate, bounded sprite from timeline thumbnails.
export function thumbnailPlan(asset, high = false) {
  const width = Number.isFinite(asset.width) && asset.width > 0 ? asset.width : 16
  const height = Number.isFinite(asset.height) && asset.height > 0 ? asset.height : 9
  const scale = Math.min((high ? 360 : 72) / height, (high ? 640 : 288) / width, high ? 1 : Infinity)
  const w = Math.max(2, Math.round(width * scale / 2) * 2)
  const h = Math.max(2, Math.round(height * scale / 2) * 2)
  const seconds = Number.isFinite(asset.duration) && asset.duration > 0 ? asset.duration : 0
  const count = asset.still || !seconds ? 1 : Math.max(1, Math.min(high ? 24 : 120, Math.ceil(seconds)))
  return { w, h, count, interval: count === 1 && !seconds ? 0 : seconds / count }
}
