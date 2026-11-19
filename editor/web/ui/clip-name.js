// The name chrome shows for a clip: its label, title text, composition or file name, on one line.
// Panels show this and keep the stored id in a tooltip.

import { clipName } from '../../core/describe.js'

export const shownClipName = (project, clip) => String(clipName(project ?? {}, clip) || clip.kind || 'Clip').split('\n')[0].trim() || 'Clip'
export const clipIdTitle = clip => `Clip id ${clip.id}`
