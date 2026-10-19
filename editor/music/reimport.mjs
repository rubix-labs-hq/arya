import { hasMusicByteIdentity, musicImportDecision } from '../core/music-score.js'
import { musicFileIdentity } from './file-identity.mjs'

// Admission precedes a potentially blocking media probe. Legacy scores need no file
// access to give their non-destructive receipt; new scores reject links/FIFOs first.
export async function prepareMusicReimport(root, src, existing, { assertCurrent } = {}) {
  const identity = hasMusicByteIdentity(existing) ? await musicFileIdentity(root, src, { allowOversized: true, assertCurrent }) : null
  return { decide: probed => musicImportDecision(existing, probed, identity), validate: identity?.validate }
}
export async function reimportMusicAsset(root, src, existing, probed, options) {
  const prepared = await prepareMusicReimport(root, src, existing, options)
  return { ...prepared.decide(probed), ...(prepared.validate ? { validate: prepared.validate } : {}) }
}
