import { MAX_RENDER_EDGE, MAX_RESIDENT_BYTES, rasterSize } from './render-resolution.js'

// WebGL2 compositor: draws one timeline frame. The same code renders the viewer,
// Claude's frame snapshots and every exported frame, so preview and output match.

import { baseValue, opacityAt, valueAt } from '/core/project.js'
import { gradeUniforms } from './grade.js'

const VERT = `#version 300 es
in vec2 aPos;
uniform mat3 uMatrix;
out vec2 vUv;
void main() {
  vUv = aPos;
  vec3 p = uMatrix * vec3(aPos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`

// Layer: source pixels through crop, grade, key and pixel effects, premultiplied out.
const LAYER = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform sampler2D uCurves;
uniform sampler3D uLut;
uniform vec4 uCrop;          // l, r, t, b
uniform vec2 uSrcSize;
uniform float uOpacity;
uniform int uFlipY;
uniform int uSolid; uniform vec4 uSolidColor;
uniform int uGrade;
uniform float uExposure, uContrast, uPivot, uSaturation, uHue, uTemp, uTint;
uniform vec3 uLift, uGamma, uGain, uOffset, uShadowTint, uHighlightTint;
uniform int uCurvesOn; uniform int uLutOn; uniform float uLutMix; uniform float uLutSize;
uniform vec3 uLutDomainMin; uniform vec3 uLutDomainMax;
uniform int uLutSpace;
uniform int uKeyOn; uniform vec3 uKeyColor; uniform float uKeySim, uKeySmooth, uKeySpill;
uniform int uInvert; uniform float uPosterize; uniform float uPixelate; uniform int uMirror;
uniform float uAberration; uniform float uVignette, uVignetteSoft; uniform float uGrain, uTime; uniform float uLetterbox;
uniform vec2 uQuadPx;
uniform int uMaskOn; uniform sampler2D uMask;
uniform int uMatteOn; uniform int uMatteMode; uniform sampler2D uMatte; uniform vec2 uViewport;
uniform int uQualOn; uniform vec2 uQualHue; uniform vec2 uQualSat; uniform vec2 uQualLum; uniform float uQualSoft; uniform int uQualInvert; uniform int uQualShow;
uniform int uWinOn; uniform int uWinType; uniform vec2 uWinCenter; uniform vec2 uWinSize; uniform float uWinRot; uniform float uWinSoft; uniform int uWinInvert; uniform float uAspect;

vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5, d = mx - mn, h = 0.0, s = 0.0;
  if (d > 1e-5) {
    s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
    if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h *= 60.0;
  }
  return vec3(h, s, l);
}
float band(float x, vec2 r, float soft) { return smoothstep(r.x - soft, r.x, x) * (1.0 - smoothstep(r.y, r.y + soft, x)); }
float hueBand(float h, vec2 r, float soft) {
  float lo = r.x, hi = r.y;
  if (hi < lo) hi += 360.0;
  float hh = h < lo - soft ? h + 360.0 : h;
  return smoothstep(lo - soft, lo, hh) * (1.0 - smoothstep(hi, hi + soft, hh));
}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float srgbDecode(float v) { return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
float srgbEncode(float v) { return v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1.0 / 2.4) - 0.055; }
vec3 workingToLut(vec3 c) {
  vec3 s = vec3(dot(c, vec3(1.660491, -0.587641, -0.072850)), dot(c, vec3(-0.124550, 1.132900, -0.008350)), dot(c, vec3(-0.018151, -0.100579, 1.118730)));
  return vec3(srgbEncode(s.r), srgbEncode(s.g), srgbEncode(s.b));
}
vec3 lutToWorking(vec3 c) {
  vec3 s = vec3(srgbDecode(c.r), srgbDecode(c.g), srgbDecode(c.b));
  return vec3(dot(s, vec3(0.627404, 0.329283, 0.043313)), dot(s, vec3(0.069097, 0.919540, 0.011362)), dot(s, vec3(0.016391, 0.088013, 0.895595)));
}
vec3 rgb2ycc(vec3 c) { float y = luma(c); return vec3(y, (c.b - y) * 0.5389, (c.r - y) * 0.6350); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

vec4 sampleSrc(vec2 uv) {
  if (uFlipY == 1) uv.y = 1.0 - uv.y;
  return texture(uSrc, uv);
}

void main() {
  vec2 uv = vUv;
  if (uv.x < uCrop.x || uv.x > 1.0 - uCrop.y || uv.y < uCrop.z || uv.y > 1.0 - uCrop.w) discard;
  if (uLetterbox > 0.0) {
    float aspect = uQuadPx.x / uQuadPx.y;
    float band = max(0.0, (1.0 - aspect / uLetterbox) * 0.5);
    if (uv.y < band || uv.y > 1.0 - band) { outColor = vec4(0.0, 0.0, 0.0, uOpacity); return; }
  }
  if (uMirror == 1) uv.x = uv.x > 0.5 ? 1.0 - uv.x : uv.x;
  if (uMirror == 2) uv.y = uv.y > 0.5 ? 1.0 - uv.y : uv.y;
  if (uPixelate > 1.0) { vec2 cells = uSrcSize / uPixelate; uv = (floor(uv * cells) + 0.5) / cells; }

  vec4 s;
  if (uSolid == 1) s = uSolidColor;
  else if (uAberration > 0.0) {
    vec2 o = vec2(uAberration / uSrcSize.x, 0.0);
    vec4 m = sampleSrc(uv);
    s = vec4(sampleSrc(uv + o).r, m.g, sampleSrc(uv - o).b, m.a);
  } else s = sampleSrc(uv);

  float a = s.a;
  vec3 c = a > 0.0 ? s.rgb / a : vec3(0.0);
  vec3 orig = c;

  if (uGrade == 1) {
    c *= exp2(uExposure);
    c *= vec3(1.0 + 0.25 * uTemp + 0.08 * uTint, 1.0 - 0.18 * uTint, 1.0 - 0.25 * uTemp + 0.08 * uTint);
    c += uOffset;
    c = c * (1.0 - uLift) + uLift;
    c *= (1.0 + uGain);
    c = pow(max(c, vec3(0.0)), 1.0 / max(vec3(0.05), 1.0 + uGamma));
    c = (c - uPivot) * uContrast + uPivot;
    float y = luma(c);
    c = mix(vec3(y), c, uSaturation);
    if (uHue != 0.0) {
      float h = radians(uHue);
      mat3 toYiq = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
      mat3 toRgb = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
      vec3 yiq = toYiq * c;
      float cs = cos(h), sn = sin(h);
      yiq.yz = mat2(cs, sn, -sn, cs) * yiq.yz;
      c = toRgb * yiq;
    }
    float yy = clamp(luma(c), 0.0, 1.0);
    c += uShadowTint * (1.0 - smoothstep(0.0, 0.55, yy)) + uHighlightTint * smoothstep(0.45, 1.0, yy);
    c = clamp(c, 0.0, 1.0);
    if (uCurvesOn == 1) c = vec3(texture(uCurves, vec2(c.r, 0.5)).r, texture(uCurves, vec2(c.g, 0.5)).g, texture(uCurves, vec2(c.b, 0.5)).b);
    if (uLutOn == 1) {
      vec3 lutInput = uLutSpace == 1 ? workingToLut(c) : c;
      vec3 inputCoordinate = clamp((lutInput - uLutDomainMin) / (uLutDomainMax - uLutDomainMin), 0.0, 1.0);
      vec3 lc = (inputCoordinate * (uLutSize - 1.0) + 0.5) / uLutSize;
      vec3 lutOutput = texture(uLut, lc).rgb;
      c = mix(c, uLutSpace == 1 ? lutToWorking(lutOutput) : lutOutput, uLutMix);
    }
  }

  // Secondary correction: the qualifier (HSL key on the original pixels) and the
  // power window limit where the grade applies; elsewhere the input passes through.
  if (uQualOn == 1 || uWinOn == 1) {
    float m = 1.0;
    if (uQualOn == 1) {
      vec3 hsl = rgb2hsl(clamp(orig, 0.0, 1.0));
      float q = hueBand(hsl.x, uQualHue, uQualSoft * 360.0) * band(hsl.y, uQualSat, uQualSoft) * band(hsl.z, uQualLum, uQualSoft);
      m *= uQualInvert == 1 ? 1.0 - q : q;
    }
    if (uWinOn == 1) {
      vec2 d = vUv - uWinCenter;
      d.x *= uAspect;
      float cs = cos(uWinRot), sn = sin(uWinRot);
      d = mat2(cs, -sn, sn, cs) * d;
      vec2 hs = max(uWinSize * 0.5 * vec2(uAspect, 1.0), vec2(1e-4));
      float w;
      if (uWinType == 0) w = 1.0 - smoothstep(1.0 - uWinSoft, 1.0 + uWinSoft, length(d / hs));
      else if (uWinType == 1) { vec2 q2 = abs(d) / hs; w = 1.0 - smoothstep(1.0 - uWinSoft, 1.0 + uWinSoft, max(q2.x, q2.y)); }
      else w = smoothstep(-uWinSoft, uWinSoft, -d.y / hs.y);
      m *= uWinInvert == 1 ? 1.0 - w : w;
    }
    c = uQualShow == 1 ? vec3(m) : mix(orig, c, m);
  }

  if (uKeyOn == 1) {
    vec3 k = rgb2ycc(uKeyColor);
    vec3 p = rgb2ycc(c);
    float d = distance(p.yz, k.yz);
    float m = smoothstep(uKeySim, uKeySim + uKeySmooth, d);
    a *= m;
    if (uKeySpill > 0.0) {
      float g = max(c.r, c.b);
      if (uKeyColor.g >= uKeyColor.r && uKeyColor.g >= uKeyColor.b) c.g = mix(c.g, min(c.g, g), uKeySpill);
      else if (uKeyColor.b >= uKeyColor.r) c.b = mix(c.b, min(c.b, max(c.r, c.g)), uKeySpill);
    }
  }

  if (uInvert == 1) c = 1.0 - c;
  if (uPosterize > 1.0) c = floor(c * uPosterize) / (uPosterize - 1.0);
  if (uVignette > 0.0) {
    vec2 q = vUv - 0.5;
    float v = smoothstep(0.75, 0.75 - max(0.05, uVignetteSoft) * 0.75, length(q * vec2(uQuadPx.x / uQuadPx.y, 1.0) * 0.9));
    c *= mix(1.0, v, uVignette);
  }
  if (uGrain > 0.0) c += (hash(vUv * uQuadPx + uTime * 97.0) - 0.5) * uGrain;

  if (uMaskOn == 1) a *= texture(uMask, vUv).a;
  if (uMatteOn == 1) {
    vec4 mt = texture(uMatte, gl_FragCoord.xy / uViewport);
    float ma = uMatteMode < 2 ? mt.a : dot(mt.rgb, vec3(0.2126, 0.7152, 0.0722));
    a *= (uMatteMode == 1 || uMatteMode == 3) ? 1.0 - ma : ma;
  }
  a *= uOpacity;
  outColor = vec4(clamp(c, 0.0, 1.0) * a, a);
}`

const FULL_VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos; gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0); }`

const BLUR = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform sampler2D uTex; uniform vec2 uDir; uniform float uRadius;
void main() {
  float sigma = max(0.5, uRadius / 2.0);
  vec4 acc = vec4(0.0); float wsum = 0.0;
  for (int i = -24; i <= 24; i++) {
    float x = float(i) * max(1.0, uRadius / 24.0);
    if (abs(x) > uRadius * 1.5) continue;
    float w = exp(-(x * x) / (2.0 * sigma * sigma));
    acc += texture(uTex, vUv + uDir * x) * w; wsum += w;
  }
  outColor = acc / wsum;
}`

// Combine: base texture with an extra texture (glow add, sharpen unsharp mask, threshold).
const COMBINE = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform sampler2D uA; uniform sampler2D uB; uniform int uMode; uniform float uAmount; uniform float uThreshold;
void main() {
  vec4 a = texture(uA, vUv); vec4 b = texture(uB, vUv);
  if (uMode == 0) { // threshold for glow
    float y = dot(a.rgb, vec3(0.2126, 0.7152, 0.0722));
    outColor = a * smoothstep(uThreshold, uThreshold + 0.1, y);
  } else if (uMode == 1) { // add glow
    outColor = vec4(min(vec3(1.0), a.rgb + b.rgb * uAmount), max(a.a, b.a * uAmount));
  } else { // sharpen
    outColor = vec4(clamp(a.rgb + (a.rgb - b.rgb) * uAmount * 2.0, 0.0, a.a), a.a);
  }
}`

const BLEND = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform sampler2D uBase; uniform sampler2D uTop; uniform int uMode; uniform float uMix;
vec3 blendRgb(vec3 b, vec3 s, int m) {
  if (m == 1) return min(vec3(1.0), b + s);
  if (m == 2) return 1.0 - (1.0 - b) * (1.0 - s);
  if (m == 3) return b * s;
  if (m == 4) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
  if (m == 5) return mix(2.0 * b * s + b * b * (1.0 - 2.0 * s), sqrt(b) * (2.0 * s - 1.0) + 2.0 * b * (1.0 - s), step(0.5, s));
  if (m == 6) return max(b, s);
  if (m == 7) return min(b, s);
  if (m == 8) return abs(b - s);
  if (m == 9) return min(vec3(1.0), b / max(vec3(0.001), 1.0 - s));
  return s;
}
void main() {
  vec4 base = texture(uBase, vUv);
  vec4 top = texture(uTop, vUv) * uMix;
  if (top.a <= 0.0) { outColor = base; return; }
  vec3 b = base.a > 0.0 ? base.rgb / base.a : vec3(0.0);
  vec3 s = top.rgb / top.a;
  vec3 mixed = mix(s, blendRgb(b, s, uMode), base.a);
  outColor = vec4(mixed * top.a + base.rgb * (1.0 - top.a), top.a + base.a * (1.0 - top.a));
}`

const TRANSITION = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform sampler2D uA; uniform sampler2D uB; uniform float uP; uniform int uType; uniform float uAspect;
vec4 A(vec2 uv) { return (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) ? vec4(0.0) : texture(uA, uv); }
vec4 B(vec2 uv) { return (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) ? vec4(0.0) : texture(uB, uv); }
void main() {
  float p = clamp(uP, 0.0, 1.0);
  vec2 uv = vUv;
  float soft = 0.04;
  if (uType == 1 || uType == 2) {
    vec4 col = uType == 1 ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(1.0);
    outColor = p < 0.5 ? mix(A(uv), col, p * 2.0) : mix(col, B(uv), (p - 0.5) * 2.0);
  } else if (uType >= 3 && uType <= 6) {
    float e = uType == 3 ? 1.0 - uv.x : uType == 4 ? uv.x : uType == 5 ? uv.y : 1.0 - uv.y;
    float m = smoothstep(e - soft, e + soft, p * (1.0 + 2.0 * soft) - soft);
    outColor = mix(A(uv), B(uv), m);
  } else if (uType == 7 || uType == 8) {
    float d = uType == 7 ? 1.0 - p : -(1.0 - p);
    vec4 b = B(uv - vec2(d, 0.0));
    outColor = b + A(uv) * (1.0 - b.a);
  } else if (uType == 9 || uType == 10) {
    float d = uType == 9 ? p : -p;
    vec4 a = A(uv + vec2(d, 0.0));
    vec4 b = B(uv + vec2(d - (uType == 9 ? 1.0 : -1.0), 0.0));
    outColor = a + b;
  } else if (uType == 11) {
    vec2 c = (uv - 0.5) / (1.0 + p * 0.6) + 0.5;
    outColor = mix(A(c), B(uv), smoothstep(0.2, 0.9, p));
  } else if (uType == 12) {
    vec2 q = (uv - 0.5) * vec2(uAspect, 1.0);
    float r = p * length(vec2(uAspect, 1.0)) * 0.55;
    outColor = mix(A(uv), B(uv), smoothstep(r + soft, r - soft, length(q)));
  } else {
    outColor = mix(A(uv), B(uv), p);
  }
}`

const COPY = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform sampler2D uTex; uniform vec4 uBg;
void main() { vec4 c = texture(uTex, vUv); outColor = vec4(c.rgb + uBg.rgb * (1.0 - c.a), 1.0); }`

// Export presets with an alpha channel (ProRes 4444, PNG sequences) keep the frame's coverage:
// the background is composited with its own alpha and the result is written unpremultiplied,
// which is what ffmpeg reads as straight RGBA. The render worker's canvas has an alpha channel;
// the viewer's does not.
const COPY_ALPHA = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform sampler2D uTex; uniform vec4 uBg;
void main() { vec4 c = texture(uTex, vUv); vec4 o = c + vec4(uBg.rgb * uBg.a, uBg.a) * (1.0 - c.a); outColor = o.a > 0.0 ? vec4(o.rgb / o.a, o.a) : vec4(0.0); }`

export const BLEND_INDEX = { normal: 0, add: 1, screen: 2, multiply: 3, overlay: 4, softLight: 5, lighten: 6, darken: 7, difference: 8, colorDodge: 9 }
export const TRANSITION_INDEX = { crossDissolve: 0, dipBlack: 1, dipWhite: 2, wipeLeft: 3, wipeRight: 4, wipeUp: 5, wipeDown: 6, slideLeft: 7, slideRight: 8, pushLeft: 9, pushRight: 10, zoomIn: 11, iris: 12, blurDissolve: 0 }

function hexToRgb(hex, fallback = [0, 0, 0, 1]) {
  if (!hex) return fallback
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map(x => x + x).join('') : h.slice(0, 6), 16)
  const alpha = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1

  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, alpha]
}

export class Compositor {
  constructor(canvas, { alpha = false } = {}) {
    this.canvas = canvas
    this.alpha = alpha
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false, alpha })
    if (!gl) throw new Error('WebGL2 is not available')
    this.gl = gl
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    this.programs = {
      layer: this.program(VERT, LAYER),
      blur: this.program(FULL_VERT, BLUR),
      combine: this.program(FULL_VERT, COMBINE),
      blend: this.program(FULL_VERT, BLEND),
      transition: this.program(FULL_VERT, TRANSITION),
      copy: this.program(FULL_VERT, COPY),
      ...(alpha ? { copyAlpha: this.program(FULL_VERT, COPY_ALPHA) } : {}),
    }
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
    this.vao = gl.createVertexArray()
    gl.bindVertexArray(this.vao)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    this.textures = new Map()
    this.targets = {}
    this.curveTextures = new Map()
    this.luts = new Map()
    this.lutGeneration = 0
    this.lutBytes = 0
    this.lutExpected = null
    this.lutAbort = null
    this.size = [0, 0]
    this.blankCurves = this.makeCurveTexture(null)
    this.blankLut = this.makeLut3d({ size: 2, data: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1]) })
  }

  program(vs, fs) {
    const gl = this.gl
    const compile = (type, src) => {
      const s = gl.createShader(type)
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s))

      return s
    }
    const p = gl.createProgram()
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs))
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs))
    gl.bindAttribLocation(p, 0, 'aPos')
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p))
    const uniforms = {}
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS)
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i)
      uniforms[info.name] = gl.getUniformLocation(p, info.name)
    }

    return { p, u: uniforms }
  }

  resize(w, h) {
    this.targetSize(w, h)
    if (this.size[0] === w && this.size[1] === h) return
    this.size = [w, h]
    this.canvas.width = w
    this.canvas.height = h
    for (const t of Object.values(this.targets)) {
      this.gl.deleteFramebuffer(t.fb)
      this.gl.deleteTexture(t.tex)
    }
    this.targets = {}
    for (const t of this.pool?.values() ?? []) {
      this.gl.deleteFramebuffer(t.fb)
      this.gl.deleteTexture(t.tex)
    }
    this.pool?.clear()
    this.beginFrame()
  }

  /**
   * A render target from the pool, by role and size. Nested compositions and node
   * graphs borrow targets per depth so their passes never overwrite each other.
   */
  beginFrame() { this.framePoolKeys = new Set() }

  renderMaxEdge() {
    if (this.deviceRenderEdge !== undefined) return this.deviceRenderEdge
    const viewport = this.gl.getParameter(this.gl.MAX_VIEWPORT_DIMS)
    return this.deviceRenderEdge = Math.min(MAX_RENDER_EDGE, this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE), viewport[0], viewport[1])
  }

  targetSize(w, h) {
    return rasterSize(w, h, 1, { maxEdge: this.renderMaxEdge(), maxBytes: MAX_RESIDENT_BYTES, bytesPerPixel: this.float ? 8 : 4, rounding: Math.round })
  }

  residentBytes() {
    const targets = new Set([...Object.values(this.targets), ...(this.pool?.values() ?? [])])
    const targetBytes = [...targets].reduce((sum, t) => sum + t.w * t.h * (this.float ? 8 : 4), 0)
    const sourceBytes = [...this.textures.values()].reduce((sum, t) => sum + t.w * t.h * 4, 0)
    return targetBytes + sourceBytes + (this.curveTextures?.size ?? 0) * 1024 + 1088 + (this.lutBytes ?? [...this.luts.values()].reduce((sum, lut) => sum + lut.size ** 3 * 8, 0))
  }

  pooled(role, w, h) {
    const size = this.targetSize(w, h)
    w = size.w; h = size.h
    this.pool ??= new Map()
    this.framePoolKeys ??= new Set()
    const key = `${role}|${w}x${h}`
    let t = this.pool.get(key)
    if (!t) {
      // Only earlier frames' unused targets can be evicted. Current-frame inputs stay valid.
      for (const [oldKey, old] of this.pool) {
        if (this.pool.size < 96 && this.residentBytes() + size.bytes <= MAX_RESIDENT_BYTES) break
        if (this.framePoolKeys.has(oldKey)) continue
        this.gl.deleteFramebuffer(old.fb)
        this.gl.deleteTexture(old.tex)
        this.pool.delete(oldKey)
      }
      if (this.pool.size >= 96) throw new Error('The frame exceeds the render target limit. Reduce graph or composition complexity.')
      t = this.makeTarget(w, h)
      this.pool.set(key, t)
    }
    this.framePoolKeys.add(key)
    return t
  }

  /** Half-float targets when the GPU can render to them (needed later for HDR). */
  setFloat(enabled) {
    const ok = enabled && Boolean(this.gl.getExtension('EXT_color_buffer_float'))
    if (ok === Boolean(this.float)) return
    this.float = ok
    const [w, h] = this.size
    this.size = [0, 0]
    for (const t of this.pool?.values() ?? []) {
      this.gl.deleteFramebuffer(t.fb)
      this.gl.deleteTexture(t.tex)
    }
    this.pool?.clear()
    if (w) this.resize(w, h)
  }

  makeTarget(w, h) {
    const size = this.targetSize(w, h)
    w = size.w; h = size.h
    if (this.residentBytes() + size.bytes > MAX_RESIDENT_BYTES) throw new Error('The frame exceeds the render memory limit. Reduce source, output size or graph complexity.')
    const gl = this.gl
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    if (this.float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null)
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const fb = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    if (!tex || !fb || gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE || gl.getError() !== gl.NO_ERROR) {
      gl.deleteFramebuffer(fb); gl.deleteTexture(tex)
      throw new Error(`Could not allocate the full ${w}×${h} render target on this device`)
    }
    return { tex, fb, w, h }
  }

  /** Uploads (or refreshes) a texture from a video, image or canvas. */
  sourceTexture(key, el, isFresh) {
    const gl = this.gl
    let entry = this.textures.get(key)
    if (!entry) {
      const tex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      entry = { tex, el: null, w: 0, h: 0, stamp: -1 }
      this.textures.set(key, entry)
    }
    const stamp = isFresh ?? (el instanceof HTMLVideoElement ? el.currentTime : 0)
    if (entry.el !== el || entry.stamp !== stamp || (el instanceof HTMLVideoElement && isFresh === undefined) || el?.dirty) {
      const w = el.displayWidth || el.videoWidth || el.naturalWidth || el.width
      const h = el.displayHeight || el.videoHeight || el.naturalHeight || el.height
      const size = rasterSize(w, h, 1, { maxEdge: this.renderMaxEdge(), maxBytes: MAX_RESIDENT_BYTES })
      if (this.residentBytes() - entry.w * entry.h * 4 + size.bytes > MAX_RESIDENT_BYTES) throw new Error('The source exceeds the render memory limit. Reduce source or output size.')
      gl.bindTexture(gl.TEXTURE_2D, entry.tex)
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el)
      } catch (cause) {
        throw new Error(`Could not upload the full ${w}×${h} source on this device`, { cause })
      }
      if (gl.getError() !== gl.NO_ERROR) throw new Error(`Could not upload the full ${w}×${h} source on this device`)
      entry.el = el
      entry.stamp = stamp
      entry.w = w
      entry.h = h
      if (el.dirty) el.dirty = false
    }

    return entry
  }

  dropTexture(key) {
    const entry = this.textures.get(key)
    if (entry) this.gl.deleteTexture(entry.tex)
    this.textures.delete(key)
  }

  makeCurveTexture(curves) {
    const gl = this.gl
    const data = new Uint8Array(256 * 4)
    const lut = curveTables(curves)
    for (let i = 0; i < 256; i++) {
      data[i * 4] = lut.r[i]
      data[i * 4 + 1] = lut.g[i]
      data[i * 4 + 2] = lut.b[i]
      data[i * 4 + 3] = 255
    }
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)

    return tex
  }

  curveTexture(curves) {
    const key = JSON.stringify(curves)
    let tex = this.curveTextures.get(key)
    if (!tex) {
      tex = this.makeCurveTexture(curves)
      this.curveTextures.set(key, tex)
      if (this.curveTextures.size > 64) {
        const [k, t] = this.curveTextures.entries().next().value
        this.gl.deleteTexture(t)
        this.curveTextures.delete(k)
      }
    }

    return tex
  }

  makeLut3d(lut) {
    const gl = this.gl
    if (lut.size > gl.getParameter(gl.MAX_3D_TEXTURE_SIZE)) throw new Error('LUT exceeds the device 3D texture limit')
    const tex = gl.createTexture()
    if (!tex) throw new Error('Could not allocate a LUT texture')
    gl.bindTexture(gl.TEXTURE_3D, tex)
    const rgb = new Float32Array(lut.size ** 3 * 4)
    for (let i = 0; i < lut.size ** 3; i++) {
      rgb[i * 4] = lut.data[i * 3]
      rgb[i * 4 + 1] = lut.data[i * 3 + 1]
      rgb[i * 4 + 2] = lut.data[i * 3 + 2]
      rgb[i * 4 + 3] = 1
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    try {
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, lut.size, lut.size, lut.size, 0, gl.RGBA, gl.FLOAT, rgb)
      if (gl.getError() !== gl.NO_ERROR) throw new Error('Could not upload a LUT texture')
    } catch (error) {
      gl.deleteTexture(tex)
      throw error
    } finally { gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true) }
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.LINEAR)
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE)

    return { tex, size: lut.size, domainMin: lut.domainMin ?? [0, 0, 0], domainMax: lut.domainMax ?? [1, 1, 1] }
  }

  clearLuts(keepExpected = false) {
    this.lutGeneration = (this.lutGeneration ?? 0) + 1
    this.lutAbort?.abort()
    this.lutAbort = null
    for (const { tex } of this.luts.values()) this.gl.deleteTexture(tex)
    this.luts.clear()
    this.lutBytes = 0
    if (!keepExpected) this.lutExpected = null
  }

  commitLuts(inputs, generation) {
    if (generation !== this.lutGeneration) throw new Error('LUT load was superseded')
    const bytes = inputs.reduce((total, input) => total + input.lut.size ** 3 * 8, 0)
    if (bytes > 16 * 1024 * 1024) throw new Error('Active LUT textures exceed 16 MiB')
    const next = new Map(), allocated = []
    try {
      for (const { path, sourceHash, lut } of inputs) {
        if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error('LUT requires an exact SHA256 identity')
        const old = this.luts.get(path)
        const entry = old?.sourceHash === sourceHash ? old : { ...this.makeLut3d(lut), sourceHash }
        if (entry !== old) allocated.push(entry)
        next.set(path, entry)
      }
    } catch (error) {
      for (const { tex } of allocated) this.gl.deleteTexture(tex)
      throw error
    }
    for (const [path, old] of this.luts) if (next.get(path) !== old) this.gl.deleteTexture(old.tex)
    this.luts = next
    this.lutBytes = bytes
  }

  setLut(path, lut, sourceHash) {
    // Direct callers replace one path without discarding other admitted textures.
    const bytes = [...this.luts].reduce((total, [key, entry]) => total + (key === path ? 0 : entry.size ** 3 * 8), 0) + lut.size ** 3 * 8
    if (bytes > 16 * 1024 * 1024) throw new Error('Active LUT textures exceed 16 MiB')
    if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error('LUT requires an exact SHA256 identity')
    const old = this.luts.get(path)
    if (old?.sourceHash === sourceHash) return old
    const entry = { ...this.makeLut3d(lut), sourceHash }
    if (old) this.gl.deleteTexture(old.tex)
    this.luts.set(path, entry)
    this.lutBytes = bytes
    return entry
  }

  bindTarget(t) {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null)
    gl.viewport(0, 0, t ? t.w : this.size[0], t ? t.h : this.size[1])
  }

  clear(t, rgba = [0, 0, 0, 0]) {
    const gl = this.gl
    this.bindTarget(t)
    gl.clearColor(...rgba)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  fullPass(prog, target, setup) {
    const gl = this.gl
    this.bindTarget(target)
    gl.useProgram(prog.p)
    gl.disable(gl.BLEND)
    setup(prog.u)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  bindTex(unit, tex, loc, target3d = false) {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(target3d ? gl.TEXTURE_3D : gl.TEXTURE_2D, tex)
    gl.uniform1i(loc, unit)
  }

  /**
   * Draws one layer into target: `source` is { tex, w, h, flipY } or { solid: rgba };
   * `layer` carries the quad (center x, y, width, height, rotation in project px),
   * crop, opacity, grade and effect params.
   */
  drawLayer(target, source, layer, project, time) {
    const gl = this.gl
    const { layer: prog } = this.programs
    this.bindTarget(target)
    gl.useProgram(prog.p)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    const u = prog.u
    // Unit quad → project pixels → clip space; the y axis points down in project space.
    const W = target ? target.w : this.size[0]
    const H = target ? target.h : this.size[1]
    if (layer.matrix) {
      // layer.matrix maps layer pixels (origin at the layer center) to project pixels:
      // [a, b, c, d, e, f] for x' = a x + c y + e, y' = b x + d y + f. The quad spans w × h.
      const [ma, mb, mc, md, me, mf] = layer.matrix
      const sx = W / project.width
      const sy = H / project.height
      const lw = layer.w
      const lh = layer.h
      // unit quad u,v → layer px ((u-.5) lw, (v-.5) lh) → project px → NDC (y flipped)
      const A = ((ma * lw) * sx * 2) / W
      const B = ((mc * lh) * sx * 2) / W
      const E = ((me - ma * lw * 0.5 - mc * lh * 0.5) * sx * 2) / W - 1
      const C = (-(mb * lw) * sy * 2) / H
      const D = (-(md * lh) * sy * 2) / H
      const F = 1 - ((mf - mb * lw * 0.5 - md * lh * 0.5) * sy * 2) / H
      gl.uniformMatrix3fv(u.uMatrix, false, new Float32Array([A, C, 0, B, D, 0, E, F, 1]))
    } else {
      const sx = W / project.width
      const sy = H / project.height
      const w = layer.w * sx
      const h = layer.h * sy
      const cx = layer.x * sx
      const cy = layer.y * sy
      const r = (layer.rotation * Math.PI) / 180
      const cos = Math.cos(r)
      const sin = Math.sin(r)
      // p = R * ((u - 0.5) * size) + center, then to NDC (y flipped)
      const a = (cos * w * 2) / W
      const b = (-sin * h * 2) / W
      const c = (sin * w * -2) / H
      const d = (cos * h * -2) / H
      const ex = ((cx - cos * w * 0.5 + sin * h * 0.5) * 2) / W - 1
      const ey = 1 - ((cy - sin * w * 0.5 - cos * h * 0.5) * 2) / H
      gl.uniformMatrix3fv(u.uMatrix, false, new Float32Array([a, c, 0, b, d, 0, ex, ey, 1]))
    }
    const crop = layer.crop ?? {}
    gl.uniform4f(u.uCrop, crop.l ?? 0, crop.r ?? 0, crop.t ?? 0, crop.b ?? 0)
    gl.uniform2f(u.uSrcSize, source.w || 1, source.h || 1)
    gl.uniform2f(u.uQuadPx, Math.max(1, layer.w), Math.max(1, layer.h))
    gl.uniform1f(u.uOpacity, layer.opacity)
    gl.uniform1i(u.uFlipY, source.flipY ? 1 : 0)
    gl.uniform1i(u.uSolid, source.solid ? 1 : 0)
    if (source.solid) gl.uniform4f(u.uSolidColor, source.solid[0] * source.solid[3], source.solid[1] * source.solid[3], source.solid[2] * source.solid[3], source.solid[3])
    const g = gradeUniforms(layer.grade)
    gl.uniform1i(u.uGrade, g ? 1 : 0)
    if (g) {
      gl.uniform1f(u.uExposure, g.exposure)
      gl.uniform1f(u.uContrast, g.contrast)
      gl.uniform1f(u.uPivot, g.pivot)
      gl.uniform1f(u.uSaturation, g.saturation)
      gl.uniform1f(u.uHue, g.hue)
      gl.uniform1f(u.uTemp, g.temperature)
      gl.uniform1f(u.uTint, g.tint)
      gl.uniform3fv(u.uLift, g.lift)
      gl.uniform3fv(u.uGamma, g.gamma)
      gl.uniform3fv(u.uGain, g.gain)
      gl.uniform3fv(u.uOffset, g.offset)
      gl.uniform3fv(u.uShadowTint, g.shadowTint)
      gl.uniform3fv(u.uHighlightTint, g.highlightTint)
    }
    const curvesOn = g && g.curves
    gl.uniform1i(u.uCurvesOn, curvesOn ? 1 : 0)
    this.bindTex(1, curvesOn ? this.curveTexture(g.curves) : this.blankCurves, u.uCurves)
    this.bindTex(0, source.tex ?? this.blankCurves, u.uSrc)
    const lut = g?.lut ? this.luts.get(g.lut) : null
    if (g?.lut && !lut) throw new Error(`LUT ${g.lut} has no verified texture`)
    gl.uniform1i(u.uLutOn, lut ? 1 : 0)
    gl.uniform1f(u.uLutMix, g?.lutMix ?? 1)
    gl.uniform1f(u.uLutSize, lut?.size ?? 2)
    gl.uniform3fv(u.uLutDomainMin, lut?.domainMin ?? [0, 0, 0])
    gl.uniform3fv(u.uLutDomainMax, lut?.domainMax ?? [1, 1, 1])
    gl.uniform1i(u.uLutSpace, 0)
    this.bindTex(2, (lut ?? this.blankLut).tex, u.uLut, true)
    const key = layer.key
    gl.uniform1i(u.uKeyOn, key ? 1 : 0)
    if (key) {
      const kc = hexToRgb(key.color ?? '#00ff00')
      gl.uniform3f(u.uKeyColor, kc[0], kc[1], kc[2])
      gl.uniform1f(u.uKeySim, (key.similarity ?? 0.3) * 0.5)
      gl.uniform1f(u.uKeySmooth, Math.max(0.001, (key.smoothness ?? 0.1) * 0.5))
      gl.uniform1f(u.uKeySpill, key.spill ?? 0.5)
    }
    const fx = layer.fx ?? {}
    gl.uniform1i(u.uInvert, fx.invert ? 1 : 0)
    gl.uniform1f(u.uPosterize, fx.posterize ?? 0)
    gl.uniform1f(u.uPixelate, fx.pixelate ?? 0)
    gl.uniform1i(u.uMirror, fx.mirror === 'y' ? 2 : fx.mirror ? 1 : 0)
    gl.uniform1f(u.uAberration, fx.aberration ?? 0)
    gl.uniform1f(u.uVignette, fx.vignette ?? 0)
    gl.uniform1f(u.uVignetteSoft, fx.vignetteSoft ?? 0.6)
    gl.uniform1f(u.uGrain, fx.grain ?? 0)
    gl.uniform1f(u.uTime, time)
    gl.uniform1f(u.uLetterbox, fx.letterbox ?? 0)
    gl.uniform2f(u.uViewport, W, H)
    gl.uniform1f(u.uAspect, W / H)
    gl.uniform1i(u.uMaskOn, layer.mask ? 1 : 0)
    this.bindTex(3, layer.mask?.tex ?? this.blankCurves, u.uMask)
    const matte = layer.matte
    gl.uniform1i(u.uMatteOn, matte ? 1 : 0)
    gl.uniform1i(u.uMatteMode, { alpha: 0, alphaInverted: 1, luma: 2, lumaInverted: 3 }[matte?.mode] ?? 0)
    this.bindTex(4, matte?.tex ?? this.blankCurves, u.uMatte)
    const q = layer.qualifier
    gl.uniform1i(u.uQualOn, q ? 1 : 0)
    gl.uniform1i(u.uQualShow, q?.show ? 1 : 0)
    if (q) {
      gl.uniform2f(u.uQualHue, q.hue?.[0] ?? 0, q.hue?.[1] ?? 360)
      gl.uniform2f(u.uQualSat, q.sat?.[0] ?? 0, q.sat?.[1] ?? 1)
      gl.uniform2f(u.uQualLum, q.lum?.[0] ?? 0, q.lum?.[1] ?? 1)
      gl.uniform1f(u.uQualSoft, q.soft ?? 0.05)
      gl.uniform1i(u.uQualInvert, q.invert ? 1 : 0)
    }
    const win = layer.window
    gl.uniform1i(u.uWinOn, win ? 1 : 0)
    if (win) {
      gl.uniform1i(u.uWinType, { circle: 0, rect: 1, linear: 2 }[win.type] ?? 0)
      gl.uniform2f(u.uWinCenter, win.x ?? 0.5, win.y ?? 0.5)
      gl.uniform2f(u.uWinSize, win.w ?? 0.5, win.h ?? 0.5)
      gl.uniform1f(u.uWinRot, ((win.rotation ?? 0) * Math.PI) / 180)
      gl.uniform1f(u.uWinSoft, Math.max(0.001, win.softness ?? 0.15))
      gl.uniform1i(u.uWinInvert, win.invert ? 1 : 0)
    }
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.disable(gl.BLEND)
  }

  blurInto(src, dst, tmp, radius) {
    const { blur } = this.programs
    const W = dst.w
    const H = dst.h
    this.fullPass(blur, tmp, u => {
      this.bindTex(0, src.tex, u.uTex)
      this.gl.uniform2f(u.uDir, 1 / W, 0)
      this.gl.uniform1f(u.uRadius, radius)
    })
    this.fullPass(blur, dst, u => {
      this.bindTex(0, tmp.tex, u.uTex)
      this.gl.uniform2f(u.uDir, 0, 1 / H)
      this.gl.uniform1f(u.uRadius, radius)
    })
  }

  /** Blur, glow and sharpen on a full-frame layer; returns the target holding the result. */
  postEffects(layerT, fx, scale) {
    if (!(fx.blur > 0.01) && !(fx.sharpen > 0) && !(fx.glow > 0)) return layerT
    const tmp1 = this.pooled('fx1', layerT.w, layerT.h)
    const tmp2 = this.pooled('fx2', layerT.w, layerT.h)
    let cur = layerT
    const swap = () => {
      // copy result back into the layer target so callers keep using it
    }
    if (fx.blur > 0.01) {
      this.blurInto(cur, tmp2, tmp1, fx.blur * scale)
      this.copyInto(tmp2, cur)
    }
    if (fx.sharpen > 0) {
      this.blurInto(cur, tmp2, tmp1, 2 * scale)
      this.fullPass(this.programs.combine, tmp1, u => {
        this.bindTex(0, cur.tex, u.uA)
        this.bindTex(1, tmp2.tex, u.uB)
        this.gl.uniform1i(u.uMode, 2)
        this.gl.uniform1f(u.uAmount, fx.sharpen)
      })
      this.copyInto(tmp1, cur)
    }
    if (fx.glow > 0) {
      this.fullPass(this.programs.combine, tmp1, u => {
        this.bindTex(0, cur.tex, u.uA)
        this.bindTex(1, cur.tex, u.uB)
        this.gl.uniform1i(u.uMode, 0)
        this.gl.uniform1f(u.uThreshold, fx.glowThreshold ?? 0.7)
      })
      const t3 = this.pooled('fx3', layerT.w, layerT.h)
      this.blurInto(tmp1, tmp2, t3, (fx.glowRadius ?? 12) * scale)
      this.fullPass(this.programs.combine, tmp1, u => {
        this.bindTex(0, cur.tex, u.uA)
        this.bindTex(1, tmp2.tex, u.uB)
        this.gl.uniform1i(u.uMode, 1)
        this.gl.uniform1f(u.uAmount, fx.glow * 1.5)
      })
      this.copyInto(tmp1, cur)
    }
    swap()

    return cur
  }

  copyInto(src, dst) {
    this.fullPass(this.programs.combine, dst, u => {
      this.bindTex(0, src.tex, u.uA)
      this.bindTex(1, src.tex, u.uB)
      this.gl.uniform1i(u.uMode, 1)
      this.gl.uniform1f(u.uAmount, 0)
    })
  }

  blendOnto(acc, out, layerT, mode, mix = 1) {
    this.fullPass(this.programs.blend, out, u => {
      this.bindTex(0, acc.tex, u.uBase)
      this.bindTex(1, layerT.tex, u.uTop)
      this.gl.uniform1i(u.uMode, BLEND_INDEX[mode] ?? 0)
      this.gl.uniform1f(u.uMix, mix)
    })
  }

  transition(aT, bT, out, type, p) {
    this.fullPass(this.programs.transition, out, u => {
      this.bindTex(0, aT.tex, u.uA)
      this.bindTex(1, bT.tex, u.uB)
      this.gl.uniform1f(u.uP, p)
      this.gl.uniform1i(u.uType, TRANSITION_INDEX[type] ?? 0)
      this.gl.uniform1f(u.uAspect, out.w / out.h)
    })
  }

  /** Draws the finished frame over `bg`; with `keepAlpha` (an alpha canvas only) the result keeps its coverage. */
  present(src, bg, keepAlpha = false) {
    const straight = keepAlpha && this.programs.copyAlpha
    this.fullPass(straight ? this.programs.copyAlpha : this.programs.copy, null, u => {
      this.bindTex(0, src.tex, u.uTex)
      const c = bg === 'transparent' ? [0, 0, 0, 0] : hexToRgb(bg)
      this.gl.uniform4f(u.uBg, c[0], c[1], c[2], straight ? c[3] : 1)
    })
  }

  /** RGBA pixels of the last presented frame (bottom row first). */
  readPixels(out) {
    const gl = this.gl
    const [w, h] = this.size
    const buf = out ?? new Uint8Array(w * h * 4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf)

    return buf
  }
}

// ---------------------------------------------------------------- curves

function monotoneSpline(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0])
  if (pts.length === 0 || pts[0][0] > 0) pts.unshift([0, pts[0]?.[0] === 0 ? pts[0][1] : 0])
  if (pts[pts.length - 1][0] < 1) pts.push([1, 1])
  const n = pts.length
  const xs = pts.map(p => p[0])
  const ys = pts.map(p => p[1])
  const d = []
  const m = []
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]))
  m.push(d[0] ?? 0)
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2)
  m.push(d[n - 2] ?? 0)

  return x => {
    if (x <= xs[0]) return ys[0]
    if (x >= xs[n - 1]) return ys[n - 1]
    let i = 0
    while (x > xs[i + 1]) i++
    const h = xs[i + 1] - xs[i]
    const t = (x - xs[i]) / h
    const t2 = t * t
    const t3 = t2 * t

    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1]
  }
}

export function curveTables(curves) {
  const id = x => x
  const master = curves?.master?.length ? monotoneSpline(curves.master) : id
  const ch = k => (curves?.[k]?.length ? monotoneSpline(curves[k]) : id)
  const fr = ch('r')
  const fg = ch('g')
  const fb = ch('b')
  const out = { r: new Uint8Array(256), g: new Uint8Array(256), b: new Uint8Array(256) }
  for (let i = 0; i < 256; i++) {
    const x = master(i / 255)
    out.r[i] = Math.max(0, Math.min(255, Math.round(fr(x) * 255)))
    out.g[i] = Math.max(0, Math.min(255, Math.round(fg(x) * 255)))
    out.b[i] = Math.max(0, Math.min(255, Math.round(fb(x) * 255)))
  }

  return out
}

export { hexToRgb, baseValue, opacityAt, valueAt }
