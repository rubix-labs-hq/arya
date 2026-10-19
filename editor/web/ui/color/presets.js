// Built-in node graph presets. Each is plain JSON: { name, nodes: { list, links } }, and
// optionally `grade` (the clip's primary grade). These leave the primary grade alone, so
// applying one keeps the clip's own balance and adds the look on nodes after it.
// Every graph keeps the default ids n1 (Input), n2 (Primary) and n3 (Output).

export const BUILTIN_PRESETS = [
  {
    name: 'Teal & orange',
    nodes: {
      list: [
        { id: 'n1', type: 'source' },
        { id: 'n2', type: 'primary' },
        { id: 'n4', type: 'corrector', label: 'Teal', qualifier: { hue: [8, 55], sat: [0.12, 1], lum: [0, 1], soft: 0.06, invert: true }, grade: { lift: [-0.03, 0.005, 0.035], gain: [-0.05, 0.01, 0.05], saturation: 0.9 } },
        { id: 'n5', type: 'corrector', label: 'Orange', qualifier: { hue: [8, 55], sat: [0.12, 1], lum: [0, 1], soft: 0.06 }, grade: { gain: [0.06, 0.02, -0.04], saturation: 1.15 } },
        { id: 'n6', type: 'corrector', label: 'Contrast', grade: { contrast: 1.08 } },
        { id: 'n3', type: 'output' },
      ],
      links: [
        { from: 'n1', to: 'n2', input: 0 },
        { from: 'n2', to: 'n4', input: 0 },
        { from: 'n4', to: 'n5', input: 0 },
        { from: 'n5', to: 'n6', input: 0 },
        { from: 'n6', to: 'n3', input: 0 },
      ],
    },
  },
  {
    name: 'Skin isolate',
    nodes: {
      list: [
        { id: 'n1', type: 'source' },
        { id: 'n2', type: 'primary' },
        { id: 'n4', type: 'corrector', label: 'Skin', qualifier: { hue: [5, 45], sat: [0.12, 0.7], lum: [0.15, 0.9], soft: 0.06 }, grade: { saturation: 1.06, gain: [0.02, 0.01, -0.01] } },
        { id: 'n5', type: 'corrector', label: 'Background', qualifier: { hue: [5, 45], sat: [0.12, 0.7], lum: [0.15, 0.9], soft: 0.06, invert: true }, grade: { saturation: 0.55 } },
        { id: 'n3', type: 'output' },
      ],
      links: [
        { from: 'n1', to: 'n2', input: 0 },
        { from: 'n2', to: 'n4', input: 0 },
        { from: 'n4', to: 'n5', input: 0 },
        { from: 'n5', to: 'n3', input: 0 },
      ],
    },
  },
  {
    name: 'Vignette window',
    nodes: {
      list: [
        { id: 'n1', type: 'source' },
        { id: 'n2', type: 'primary' },
        { id: 'n4', type: 'corrector', label: 'Vignette', window: { type: 'circle', x: 0.5, y: 0.5, w: 0.9, h: 0.9, rotation: 0, softness: 0.4, invert: true }, grade: { exposure: -0.7, saturation: 0.85 } },
        { id: 'n3', type: 'output' },
      ],
      links: [
        { from: 'n1', to: 'n2', input: 0 },
        { from: 'n2', to: 'n4', input: 0 },
        { from: 'n4', to: 'n3', input: 0 },
      ],
    },
  },
  {
    name: 'Day for night',
    nodes: {
      list: [
        { id: 'n1', type: 'source' },
        { id: 'n2', type: 'primary' },
        { id: 'n4', type: 'corrector', label: 'Night', grade: { exposure: -1.2, temperature: -0.55, saturation: 0.45, contrast: 1.12, lift: [-0.02, -0.01, 0.02], gain: [-0.08, -0.03, 0.06] } },
        { id: 'n5', type: 'corrector', label: 'Moon edge', window: { type: 'circle', x: 0.5, y: 0.45, w: 0.85, h: 0.85, rotation: 0, softness: 0.45, invert: true }, grade: { exposure: -0.6 } },
        { id: 'n3', type: 'output' },
      ],
      links: [
        { from: 'n1', to: 'n2', input: 0 },
        { from: 'n2', to: 'n4', input: 0 },
        { from: 'n4', to: 'n5', input: 0 },
        { from: 'n5', to: 'n3', input: 0 },
      ],
    },
  },
  {
    name: 'Bleach bypass',
    nodes: {
      list: [
        { id: 'n1', type: 'source' },
        { id: 'n2', type: 'primary' },
        { id: 'n4', type: 'corrector', label: 'Silver', grade: { saturation: 0, contrast: 1.25 } },
        { id: 'n5', type: 'layerMixer', blends: ['normal', 'overlay'] },
        { id: 'n6', type: 'corrector', label: 'Trim', grade: { saturation: 0.75, exposure: -0.15 } },
        { id: 'n3', type: 'output' },
      ],
      links: [
        { from: 'n1', to: 'n2', input: 0 },
        { from: 'n2', to: 'n5', input: 0 },
        { from: 'n2', to: 'n4', input: 0 },
        { from: 'n4', to: 'n5', input: 1 },
        { from: 'n5', to: 'n6', input: 0 },
        { from: 'n6', to: 'n3', input: 0 },
      ],
    },
  },
]
