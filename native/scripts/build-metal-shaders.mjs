// Port the browser shader equations to Metal and keep their uniform names for parity.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const source = fs.readFileSync(path.join(root, 'editor/web/engine/compositor.js'), 'utf8')
const names = ['LAYER', 'BLUR', 'COMBINE', 'BLEND', 'TRANSITION', 'COPY']
const header = `#include <metal_stdlib>
using namespace metal;
constexpr sampler reelSampler(coord::normalized, address::clamp_to_edge, filter::linear);
float radians(float angle) { return angle * 0.017453292519943295; }
float4 readSource(texture2d<float> tex, float2 uv, int flip) { if (flip == 1) uv.y = 1.0 - uv.y; return tex.sample(reelSampler, uv); }
float4 readInside(texture2d<float> tex, float2 uv) { return any(uv < 0.0) || any(uv > 1.0) ? float4(0.0) : tex.sample(reelSampler, uv); }
`
let metal = header
const fields = {}
for (const name of names) {
  let body = new RegExp(`const ${name} = \x60([\\s\\S]*?)\x60`).exec(source)[1]
  const uniforms = []
  const textures = []
  body = body.replace(/uniform\s+(\w+)\s+([^;]+);/g, (_, type, list) => {
    for (const field of list.split(',').map(x => x.trim())) (type.startsWith('sampler') ? textures : uniforms).push({ type, field })
    return ''
  })
  body = body.replace(/#version[^\n]*|precision[^;]*;|in\s+vec2\s+vUv;|out\s+vec4\s+outColor;/g, '')
  body = body.replace(/vec4 sampleSrc\(vec2 uv\)\s*\{[\s\S]*?\n\}/, '')
  body = body.replace(/vec4 [AB]\(vec2 uv\)\s*\{[^\n]*\}/g, '')
  body = body.replace(/sampleSrc\(/g, 'readSource(uSrc, ').replace(/readSource\(uSrc, ([^)]*)\)/g, 'readSource(uSrc, $1, uFlipY)')
  body = body.replace(/\bA\(/g, 'readInside(uA, ').replace(/\bB\(/g, 'readInside(uB, ')
  body = body.replace(/texture\((\w+),\s*/g, '$1.sample(reelSampler, ')
  body = body.replace(/\bvec([234])\b/g, 'float$1').replace(/\bmat([234])\b/g, 'float$1x$1')
  body = body.replace(/float([23])x\1\(([^()]+)\)/g, (match, size, args) => {
    const a = args.split(',').map(s => s.trim()), n = Number(size)
    return a.length === n * n ? `float${n}x${n}(${Array.from({length: n}, (_, i) => `float${n}(${a.slice(i * n, (i + 1) * n).join(', ')})`).join(', ')})` : match
  })
  body = body.replace(/gl_FragCoord.xy/g, 'pixel').replace(/\bdiscard\s*;/g, 'return float4(0.0);')
  body = body.replace(/outColor\s*=\s*([^;]+);/g, 'return $1;').replace(/return\s*;/g, '')
  const textureParams = textures.map(({ type, field }) => `${type === 'sampler3D' ? 'texture3d' : 'texture2d'}<float> ${field}`)
  const params = ['float2 vUv', 'float2 pixel', 'constant float4 *u', ...textureParams].join(', ')
  body = body.replace('void main()', `float4 pixel_${name.toLowerCase()}(${params})`)
  if (name === 'LAYER') uniforms.push({ type: 'vec4', field: 'uInv0' }, { type: 'vec4', field: 'uInv1' }, { type: 'vec2', field: 'uViewSize' })
  const defs = uniforms.map(({ type, field }, i) => `#define ${field} ${type === 'int' ? `int(u[${i}].x)` : `u[${i}].${type === 'vec4' ? 'xyzw' : type === 'vec3' ? 'xyz' : type === 'vec2' ? 'xy' : 'x'}`}`).join('\n')
  const textureKernelParams = textures.map(({ type, field }, i) => `${type === 'sampler3D' ? 'texture3d' : 'texture2d'}<float> ${field} [[texture(${i})]]`)
  const dstIndex = textures.length
  const uv = name === 'LAYER' ? `float2 p = pixel / float2(dst.get_width(), dst.get_height()) * uViewSize;
  float2 local = float2(uInv0.x * p.x + uInv0.z * p.y + uInv1.x, uInv0.y * p.x + uInv0.w * p.y + uInv1.y);
  float2 uv = local / uInv1.zw + 0.5;
  if (any(uv < 0.0) || any(uv > 1.0)) { dst.write(float4(0.0), gid); return; }` : 'float2 uv = pixel / float2(dst.get_width(), dst.get_height());'
  metal += `\n${defs}\n${body}\nkernel void reel_${name.toLowerCase()}(${[...textureKernelParams, `texture2d<float, access::write> dst [[texture(${dstIndex})]]`, 'constant float4 *u [[buffer(0)]]', 'uint2 gid [[thread_position_in_grid]]'].join(', ')}) {
  if (gid.x >= dst.get_width() || gid.y >= dst.get_height()) return;
  float2 pixel = float2(gid) + 0.5;
  ${uv}
  dst.write(pixel_${name.toLowerCase()}(uv, pixel, u, ${textures.map(t => t.field).join(', ')}), gid);
}\n${uniforms.map(x => `#undef ${x.field}`).join('\n')}\n`
  fields[name.toLowerCase()] = uniforms.map(x => x.field)
}
fields.yuv = ['uCoefficients', 'uRange', 'uChromaNearest']
fields.mask = ['uMode', 'uOpacity', 'uInvert']
fields.box = ['uLow', 'uCount', 'uDir']
metal += `
kernel void reel_yuv(texture2d<float> yTex [[texture(0)]], texture2d<float> uvTex [[texture(1)]], texture2d<float, access::write> dst [[texture(2)]], constant float4 *u [[buffer(0)]], uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= dst.get_width() || gid.y >= dst.get_height()) return;
  float2 p = (float2(gid) + 0.5) / float2(dst.get_width(),dst.get_height());
  float y = (yTex.sample(reelSampler,p).r - u[1].x) * u[1].y;
  float2 c = uvTex.sample(reelSampler,p).rg - 128.0/255.0;
  if (u[2].x > 0.5) c = uvTex.read(gid/2).rg - 128.0/255.0;
  float3 rgb = float3(y + u[0].x*c.y, y + u[0].y*c.x + u[0].z*c.y, y + u[0].w*c.x);
  dst.write(float4(clamp(rgb,0.0,1.0),1.0),gid);
}
kernel void reel_box(texture2d<float, access::read> source [[texture(0)]], texture2d<float, access::write> dst [[texture(1)]], constant float4 *u [[buffer(0)]], uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= dst.get_width() || gid.y >= dst.get_height()) return;
  float4 sum = float4(0.0);
  for (int i = int(u[0].x); i < int(u[0].x + u[1].x); ++i) {
    int2 p = int2(gid) + int2(u[2].xy) * i;
    if (all(p >= 0) && p.x < int(source.get_width()) && p.y < int(source.get_height())) sum += source.read(uint2(p));
  }
  dst.write(sum / u[1].x, gid);
}
kernel void reel_mask(texture2d<float> base [[texture(0)]], texture2d<float> top [[texture(1)]], texture2d<float, access::write> dst [[texture(2)]], constant float4 *u [[buffer(0)]], uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= dst.get_width() || gid.y >= dst.get_height()) return;
  float2 uv = (float2(gid) + 0.5) / float2(dst.get_width(), dst.get_height());
  float a = base.sample(reelSampler, uv).a, b = top.sample(reelSampler, uv).a;
  if (u[2].x > 0.5) b = 1.0 - b;
  b *= u[1].x;
  float alpha = u[0].x == 1.0 ? a * (1.0 - b) : u[0].x == 2.0 ? a * b : b + a * (1.0 - b);
  dst.write(float4(alpha), gid);
}
`
const swift = `// Generated from compositor.js by native/scripts/build-metal-shaders.mjs.
import Foundation

enum MetalShaders {
    static let fields: [String: [String]] = ${JSON.stringify(fields, null, 2).replace(/\{/g, '[').replace(/\}/g, ']')}
    static let source = #"""
${metal}
"""#
}
`
const out = path.join(root, 'native/ReelKit/Sources/ReelKit/Rendering/MetalShaders.swift')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, swift)
