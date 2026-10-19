// Generated from compositor.js by native/scripts/build-metal-shaders.mjs.
import Foundation

enum MetalShaders {
    static let fields: [String: [String]] = [
  "layer": [
    "uCrop",
    "uSrcSize",
    "uOpacity",
    "uFlipY",
    "uSolid",
    "uSolidColor",
    "uGrade",
    "uExposure",
    "uContrast",
    "uPivot",
    "uSaturation",
    "uHue",
    "uTemp",
    "uTint",
    "uLift",
    "uGamma",
    "uGain",
    "uOffset",
    "uShadowTint",
    "uHighlightTint",
    "uCurvesOn",
    "uLutOn",
    "uLutMix",
    "uLutSize",
    "uLutDomainMin",
    "uLutDomainMax",
    "uLutSpace",
    "uKeyOn",
    "uKeyColor",
    "uKeySim",
    "uKeySmooth",
    "uKeySpill",
    "uInvert",
    "uPosterize",
    "uPixelate",
    "uMirror",
    "uAberration",
    "uVignette",
    "uVignetteSoft",
    "uGrain",
    "uTime",
    "uLetterbox",
    "uQuadPx",
    "uMaskOn",
    "uMatteOn",
    "uMatteMode",
    "uViewport",
    "uQualOn",
    "uQualHue",
    "uQualSat",
    "uQualLum",
    "uQualSoft",
    "uQualInvert",
    "uQualShow",
    "uWinOn",
    "uWinType",
    "uWinCenter",
    "uWinSize",
    "uWinRot",
    "uWinSoft",
    "uWinInvert",
    "uAspect",
    "uInv0",
    "uInv1",
    "uViewSize"
  ],
  "blur": [
    "uDir",
    "uRadius"
  ],
  "combine": [
    "uMode",
    "uAmount",
    "uThreshold"
  ],
  "blend": [
    "uMode",
    "uMix"
  ],
  "transition": [
    "uP",
    "uType",
    "uAspect"
  ],
  "copy": [
    "uBg"
  ],
  "yuv": [
    "uCoefficients",
    "uRange",
    "uChromaNearest"
  ],
  "mask": [
    "uMode",
    "uOpacity",
    "uInvert"
  ],
  "box": [
    "uLow",
    "uCount",
    "uDir"
  ]
]
    static let source = #"""
#include <metal_stdlib>
using namespace metal;
constexpr sampler reelSampler(coord::normalized, address::clamp_to_edge, filter::linear);
float radians(float angle) { return angle * 0.017453292519943295; }
float4 readSource(texture2d<float> tex, float2 uv, int flip) { if (flip == 1) uv.y = 1.0 - uv.y; return tex.sample(reelSampler, uv); }
float4 readInside(texture2d<float> tex, float2 uv) { return any(uv < 0.0) || any(uv > 1.0) ? float4(0.0) : tex.sample(reelSampler, uv); }

#define uCrop u[0].xyzw
#define uSrcSize u[1].xy
#define uOpacity u[2].x
#define uFlipY int(u[3].x)
#define uSolid int(u[4].x)
#define uSolidColor u[5].xyzw
#define uGrade int(u[6].x)
#define uExposure u[7].x
#define uContrast u[8].x
#define uPivot u[9].x
#define uSaturation u[10].x
#define uHue u[11].x
#define uTemp u[12].x
#define uTint u[13].x
#define uLift u[14].xyz
#define uGamma u[15].xyz
#define uGain u[16].xyz
#define uOffset u[17].xyz
#define uShadowTint u[18].xyz
#define uHighlightTint u[19].xyz
#define uCurvesOn int(u[20].x)
#define uLutOn int(u[21].x)
#define uLutMix u[22].x
#define uLutSize u[23].x
#define uLutDomainMin u[24].xyz
#define uLutDomainMax u[25].xyz
#define uLutSpace int(u[26].x)
#define uKeyOn int(u[27].x)
#define uKeyColor u[28].xyz
#define uKeySim u[29].x
#define uKeySmooth u[30].x
#define uKeySpill u[31].x
#define uInvert int(u[32].x)
#define uPosterize u[33].x
#define uPixelate u[34].x
#define uMirror int(u[35].x)
#define uAberration u[36].x
#define uVignette u[37].x
#define uVignetteSoft u[38].x
#define uGrain u[39].x
#define uTime u[40].x
#define uLetterbox u[41].x
#define uQuadPx u[42].xy
#define uMaskOn int(u[43].x)
#define uMatteOn int(u[44].x)
#define uMatteMode int(u[45].x)
#define uViewport u[46].xy
#define uQualOn int(u[47].x)
#define uQualHue u[48].xy
#define uQualSat u[49].xy
#define uQualLum u[50].xy
#define uQualSoft u[51].x
#define uQualInvert int(u[52].x)
#define uQualShow int(u[53].x)
#define uWinOn int(u[54].x)
#define uWinType int(u[55].x)
#define uWinCenter u[56].xy
#define uWinSize u[57].xy
#define uWinRot u[58].x
#define uWinSoft u[59].x
#define uWinInvert int(u[60].x)
#define uAspect u[61].x
#define uInv0 u[62].xyzw
#define uInv1 u[63].xyzw
#define uViewSize u[64].xy








          // l, r, t, b



 



   
 

  
   
   

 
   
      
       

float3 rgb2hsl(float3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5, d = mx - mn, h = 0.0, s = 0.0;
  if (d > 1e-5) {
    s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
    if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h *= 60.0;
  }
  return float3(h, s, l);
}
float band(float x, float2 r, float soft) { return smoothstep(r.x - soft, r.x, x) * (1.0 - smoothstep(r.y, r.y + soft, x)); }
float hueBand(float h, float2 r, float soft) {
  float lo = r.x, hi = r.y;
  if (hi < lo) hi += 360.0;
  float hh = h < lo - soft ? h + 360.0 : h;
  return smoothstep(lo - soft, lo, hh) * (1.0 - smoothstep(hi, hi + soft, hh));
}

float luma(float3 c) { return dot(c, float3(0.2126, 0.7152, 0.0722)); }
float srgbDecode(float v) { return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
float srgbEncode(float v) { return v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1.0 / 2.4) - 0.055; }
float3 workingToLut(float3 c) {
  float3 s = float3(dot(c, float3(1.660491, -0.587641, -0.072850)), dot(c, float3(-0.124550, 1.132900, -0.008350)), dot(c, float3(-0.018151, -0.100579, 1.118730)));
  return float3(srgbEncode(s.r), srgbEncode(s.g), srgbEncode(s.b));
}
float3 lutToWorking(float3 c) {
  float3 s = float3(srgbDecode(c.r), srgbDecode(c.g), srgbDecode(c.b));
  return float3(dot(s, float3(0.627404, 0.329283, 0.043313)), dot(s, float3(0.069097, 0.919540, 0.011362)), dot(s, float3(0.016391, 0.088013, 0.895595)));
}
float3 rgb2ycc(float3 c) { float y = luma(c); return float3(y, (c.b - y) * 0.5389, (c.r - y) * 0.6350); }
float hash(float2 p) { return fract(sin(dot(p, float2(12.9898, 78.233))) * 43758.5453); }



float4 pixel_layer(float2 vUv, float2 pixel, constant float4 *u, texture2d<float> uSrc, texture2d<float> uCurves, texture3d<float> uLut, texture2d<float> uMask, texture2d<float> uMatte) {
  float2 uv = vUv;
  if (uv.x < uCrop.x || uv.x > 1.0 - uCrop.y || uv.y < uCrop.z || uv.y > 1.0 - uCrop.w) return float4(0.0);
  if (uLetterbox > 0.0) {
    float aspect = uQuadPx.x / uQuadPx.y;
    float band = max(0.0, (1.0 - aspect / uLetterbox) * 0.5);
    if (uv.y < band || uv.y > 1.0 - band) { return float4(0.0, 0.0, 0.0, uOpacity);  }
  }
  if (uMirror == 1) uv.x = uv.x > 0.5 ? 1.0 - uv.x : uv.x;
  if (uMirror == 2) uv.y = uv.y > 0.5 ? 1.0 - uv.y : uv.y;
  if (uPixelate > 1.0) { float2 cells = uSrcSize / uPixelate; uv = (floor(uv * cells) + 0.5) / cells; }

  float4 s;
  if (uSolid == 1) s = uSolidColor;
  else if (uAberration > 0.0) {
    float2 o = float2(uAberration / uSrcSize.x, 0.0);
    float4 m = readSource(uSrc, uv, uFlipY);
    s = float4(readSource(uSrc, uv + o, uFlipY).r, m.g, readSource(uSrc, uv - o, uFlipY).b, m.a);
  } else s = readSource(uSrc, uv, uFlipY);

  float a = s.a;
  float3 c = a > 0.0 ? s.rgb / a : float3(0.0);
  float3 orig = c;

  if (uGrade == 1) {
    c *= exp2(uExposure);
    c *= float3(1.0 + 0.25 * uTemp + 0.08 * uTint, 1.0 - 0.18 * uTint, 1.0 - 0.25 * uTemp + 0.08 * uTint);
    c += uOffset;
    c = c * (1.0 - uLift) + uLift;
    c *= (1.0 + uGain);
    c = pow(max(c, float3(0.0)), 1.0 / max(float3(0.05), 1.0 + uGamma));
    c = (c - uPivot) * uContrast + uPivot;
    float y = luma(c);
    c = mix(float3(y), c, uSaturation);
    if (uHue != 0.0) {
      float h = radians(uHue);
      float3x3 toYiq = float3x3(float3(0.299, 0.596, 0.211), float3(0.587, -0.274, -0.523), float3(0.114, -0.322, 0.312));
      float3x3 toRgb = float3x3(float3(1.0, 1.0, 1.0), float3(0.956, -0.272, -1.106), float3(0.621, -0.647, 1.703));
      float3 yiq = toYiq * c;
      float cs = cos(h), sn = sin(h);
      yiq.yz = float2x2(float2(cs, sn), float2(-sn, cs)) * yiq.yz;
      c = toRgb * yiq;
    }
    float yy = clamp(luma(c), 0.0, 1.0);
    c += uShadowTint * (1.0 - smoothstep(0.0, 0.55, yy)) + uHighlightTint * smoothstep(0.45, 1.0, yy);
    c = clamp(c, 0.0, 1.0);
    if (uCurvesOn == 1) c = float3(uCurves.sample(reelSampler, float2(c.r, 0.5)).r, uCurves.sample(reelSampler, float2(c.g, 0.5)).g, uCurves.sample(reelSampler, float2(c.b, 0.5)).b);
    if (uLutOn == 1) {
      float3 lutInput = uLutSpace == 1 ? workingToLut(c) : c;
      float3 inputCoordinate = clamp((lutInput - uLutDomainMin) / (uLutDomainMax - uLutDomainMin), 0.0, 1.0);
      float3 lc = (inputCoordinate * (uLutSize - 1.0) + 0.5) / uLutSize;
      float3 lutOutput = uLut.sample(reelSampler, lc).rgb;
      c = mix(c, uLutSpace == 1 ? lutToWorking(lutOutput) : lutOutput, uLutMix);
    }
  }

  // Secondary correction: the qualifier (HSL key on the original pixels) and the
  // power window limit where the grade applies; elsewhere the input passes through.
  if (uQualOn == 1 || uWinOn == 1) {
    float m = 1.0;
    if (uQualOn == 1) {
      float3 hsl = rgb2hsl(clamp(orig, 0.0, 1.0));
      float q = hueBand(hsl.x, uQualHue, uQualSoft * 360.0) * band(hsl.y, uQualSat, uQualSoft) * band(hsl.z, uQualLum, uQualSoft);
      m *= uQualInvert == 1 ? 1.0 - q : q;
    }
    if (uWinOn == 1) {
      float2 d = vUv - uWinCenter;
      d.x *= uAspect;
      float cs = cos(uWinRot), sn = sin(uWinRot);
      d = float2x2(float2(cs, -sn), float2(sn, cs)) * d;
      float2 hs = max(uWinSize * 0.5 * float2(uAspect, 1.0), float2(1e-4));
      float w;
      if (uWinType == 0) w = 1.0 - smoothstep(1.0 - uWinSoft, 1.0 + uWinSoft, length(d / hs));
      else if (uWinType == 1) { float2 q2 = abs(d) / hs; w = 1.0 - smoothstep(1.0 - uWinSoft, 1.0 + uWinSoft, max(q2.x, q2.y)); }
      else w = smoothstep(-uWinSoft, uWinSoft, -d.y / hs.y);
      m *= uWinInvert == 1 ? 1.0 - w : w;
    }
    c = uQualShow == 1 ? float3(m) : mix(orig, c, m);
  }

  if (uKeyOn == 1) {
    float3 k = rgb2ycc(uKeyColor);
    float3 p = rgb2ycc(c);
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
    float2 q = vUv - 0.5;
    float v = smoothstep(0.75, 0.75 - max(0.05, uVignetteSoft) * 0.75, length(q * float2(uQuadPx.x / uQuadPx.y, 1.0) * 0.9));
    c *= mix(1.0, v, uVignette);
  }
  if (uGrain > 0.0) c += (hash(vUv * uQuadPx + uTime * 97.0) - 0.5) * uGrain;

  if (uMaskOn == 1) a *= uMask.sample(reelSampler, vUv).a;
  if (uMatteOn == 1) {
    float4 mt = uMatte.sample(reelSampler, pixel / uViewport);
    float ma = uMatteMode < 2 ? mt.a : dot(mt.rgb, float3(0.2126, 0.7152, 0.0722));
    a *= (uMatteMode == 1 || uMatteMode == 3) ? 1.0 - ma : ma;
  }
  a *= uOpacity;
  return float4(clamp(c, 0.0, 1.0) * a, a);
}
kernel void reel_layer(texture2d<float> uSrc [[texture(0)]], texture2d<float> uCurves [[texture(1)]], texture3d<float> uLut [[texture(2)]], texture2d<float> uMask [[texture(3)]], texture2d<float> uMatte [[texture(4)]], texture2d<float, access::write> dst [[texture(5)]], constant float4 *u [[buffer(0)]], uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= dst.get_width() || gid.y >= dst.get_height()) return;
  float2 pixel = float2(gid) + 0.5;
  float2 p = pixel / float2(dst.get_width(), dst.get_height()) * uViewSize;
  float2 local = float2(uInv0.x * p.x + uInv0.z * p.y + uInv1.x, uInv0.y * p.x + uInv0.w * p.y + uInv1.y);
  float2 uv = local / uInv1.zw + 0.5;
  if (any(uv < 0.0) || any(uv > 1.0)) { dst.write(float4(0.0), gid); return; }
  dst.write(pixel_layer(uv, pixel, u, uSrc, uCurves, uLut, uMask, uMatte), gid);
}
#undef uCrop
#undef uSrcSize
#undef uOpacity
#undef uFlipY
#undef uSolid
#undef uSolidColor
#undef uGrade
#undef uExposure
#undef uContrast
#undef uPivot
#undef uSaturation
#undef uHue
#undef uTemp
#undef uTint
#undef uLift
#undef uGamma
#undef uGain
#undef uOffset
#undef uShadowTint
#undef uHighlightTint
#undef uCurvesOn
#undef uLutOn
#undef uLutMix
#undef uLutSize
#undef uLutDomainMin
#undef uLutDomainMax
#undef uLutSpace
#undef uKeyOn
#undef uKeyColor
#undef uKeySim
#undef uKeySmooth
#undef uKeySpill
#undef uInvert
#undef uPosterize
#undef uPixelate
#undef uMirror
#undef uAberration
#undef uVignette
#undef uVignetteSoft
#undef uGrain
#undef uTime
#undef uLetterbox
#undef uQuadPx
#undef uMaskOn
#undef uMatteOn
#undef uMatteMode
#undef uViewport
#undef uQualOn
#undef uQualHue
#undef uQualSat
#undef uQualLum
#undef uQualSoft
#undef uQualInvert
#undef uQualShow
#undef uWinOn
#undef uWinType
#undef uWinCenter
#undef uWinSize
#undef uWinRot
#undef uWinSoft
#undef uWinInvert
#undef uAspect
#undef uInv0
#undef uInv1
#undef uViewSize

#define uDir u[0].xy
#define uRadius u[1].x


 
  
float4 pixel_blur(float2 vUv, float2 pixel, constant float4 *u, texture2d<float> uTex) {
  float sigma = max(0.5, uRadius / 2.0);
  float4 acc = float4(0.0); float wsum = 0.0;
  for (int i = -24; i <= 24; i++) {
    float x = float(i) * max(1.0, uRadius / 24.0);
    if (abs(x) > uRadius * 1.5) continue;
    float w = exp(-(x * x) / (2.0 * sigma * sigma));
    acc += uTex.sample(reelSampler, vUv + uDir * x) * w; wsum += w;
  }
  return acc / wsum;
}
kernel void reel_blur(texture2d<float> uTex [[texture(0)]], texture2d<float, access::write> dst [[texture(1)]], constant float4 *u [[buffer(0)]], uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= dst.get_width() || gid.y >= dst.get_height()) return;
  float2 pixel = float2(gid) + 0.5;
  float2 uv = pixel / float2(dst.get_width(), dst.get_height());
  dst.write(pixel_blur(uv, pixel, u, uTex), gid);
}
#undef uDir
#undef uRadius

#define uMode int(u[0].x)
#define uAmount u[1].x
#define uThreshold u[2].x


 
    
float4 pixel_combine(float2 vUv, float2 pixel, constant float4 *u, texture2d<float> uA, texture2d<float> uB) {
  float4 a = uA.sample(reelSampler, vUv); float4 b = uB.sample(reelSampler, vUv);
  if (uMode == 0) { // threshold for glow
    float y = dot(a.rgb, float3(0.2126, 0.7152, 0.0722));
    return a * smoothstep(uThreshold, uThreshold + 0.1, y);
  } else if (uMode == 1) { // add glow
    return float4(min(float3(1.0), a.rgb + b.rgb * uAmount), max(a.a, b.a * uAmount));
  } else { // sharpen
    return float4(clamp(a.rgb + (a.rgb - b.rgb) * uAmount * 2.0, 0.0, a.a), a.a);
  }
}
kernel void reel_combine(texture2d<float> uA [[texture(0)]], texture2d<float> uB [[texture(1)]], texture2d<float, access::write> dst [[texture(2)]], constant float4 *u [[buffer(0)]], uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= dst.get_width() || gid.y >= dst.get_height()) return;
  float2 pixel = float2(gid) + 0.5;
  float2 uv = pixel / float2(dst.get_width(), dst.get_height());
  dst.write(pixel_combine(uv, pixel, u, uA, uB), gid);
}
#undef uMode
#undef uAmount
#undef uThreshold

#define uMode int(u[0].x)
#define uMix u[1].x


 
   
float3 blendRgb(float3 b, float3 s, int m) {
  if (m == 1) return min(float3(1.0), b + s);
  if (m == 2) return 1.0 - (1.0 - b) * (1.0 - s);
  if (m == 3) return b * s;
  if (m == 4) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
  if (m == 5) return mix(2.0 * b * s + b * b * (1.0 - 2.0 * s), sqrt(b) * (2.0 * s - 1.0) + 2.0 * b * (1.0 - s), step(0.5, s));
  if (m == 6) return max(b, s);
  if (m == 7) return min(b, s);
  if (m == 8) return abs(b - s);
  if (m == 9) return min(float3(1.0), b / max(float3(0.001), 1.0 - s));
  return s;
}
float4 pixel_blend(float2 vUv, float2 pixel, constant float4 *u, texture2d<float> uBase, texture2d<float> uTop) {
  float4 base = uBase.sample(reelSampler, vUv);
  float4 top = uTop.sample(reelSampler, vUv) * uMix;
  if (top.a <= 0.0) { return base;  }
  float3 b = base.a > 0.0 ? base.rgb / base.a : float3(0.0);
  float3 s = top.rgb / top.a;
  float3 mixed = mix(s, blendRgb(b, s, uMode), base.a);
  return float4(mixed * top.a + base.rgb * (1.0 - top.a), top.a + base.a * (1.0 - top.a));
}
kernel void reel_blend(texture2d<float> uBase [[texture(0)]], texture2d<float> uTop [[texture(1)]], texture2d<float, access::write> dst [[texture(2)]], constant float4 *u [[buffer(0)]], uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= dst.get_width() || gid.y >= dst.get_height()) return;
  float2 pixel = float2(gid) + 0.5;
  float2 uv = pixel / float2(dst.get_width(), dst.get_height());
  dst.write(pixel_blend(uv, pixel, u, uBase, uTop), gid);
}
#undef uMode
#undef uMix

#define uP u[0].x
#define uType int(u[1].x)
#define uAspect u[2].x


 
    


float4 pixel_transition(float2 vUv, float2 pixel, constant float4 *u, texture2d<float> uA, texture2d<float> uB) {
  float p = clamp(uP, 0.0, 1.0);
  float2 uv = vUv;
  float soft = 0.04;
  if (uType == 1 || uType == 2) {
    float4 col = uType == 1 ? float4(0.0, 0.0, 0.0, 1.0) : float4(1.0);
    return p < 0.5 ? mix(readInside(uA, uv), col, p * 2.0) : mix(col, readInside(uB, uv), (p - 0.5) * 2.0);
  } else if (uType >= 3 && uType <= 6) {
    float e = uType == 3 ? 1.0 - uv.x : uType == 4 ? uv.x : uType == 5 ? uv.y : 1.0 - uv.y;
    float m = smoothstep(e - soft, e + soft, p * (1.0 + 2.0 * soft) - soft);
    return mix(readInside(uA, uv), readInside(uB, uv), m);
  } else if (uType == 7 || uType == 8) {
    float d = uType == 7 ? 1.0 - p : -(1.0 - p);
    float4 b = readInside(uB, uv - float2(d, 0.0));
    return b + readInside(uA, uv) * (1.0 - b.a);
  } else if (uType == 9 || uType == 10) {
    float d = uType == 9 ? p : -p;
    float4 a = readInside(uA, uv + float2(d, 0.0));
    float4 b = readInside(uB, uv + float2(d - (uType == 9 ? 1.0 : -1.0), 0.0));
    return a + b;
  } else if (uType == 11) {
    float2 c = (uv - 0.5) / (1.0 + p * 0.6) + 0.5;
    return mix(readInside(uA, c), readInside(uB, uv), smoothstep(0.2, 0.9, p));
  } else if (uType == 12) {
    float2 q = (uv - 0.5) * float2(uAspect, 1.0);
    float r = p * length(float2(uAspect, 1.0)) * 0.55;
    return mix(readInside(uA, uv), readInside(uB, uv), smoothstep(r + soft, r - soft, length(q)));
  } else {
    return mix(readInside(uA, uv), readInside(uB, uv), p);
  }
}
kernel void reel_transition(texture2d<float> uA [[texture(0)]], texture2d<float> uB [[texture(1)]], texture2d<float, access::write> dst [[texture(2)]], constant float4 *u [[buffer(0)]], uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= dst.get_width() || gid.y >= dst.get_height()) return;
  float2 pixel = float2(gid) + 0.5;
  float2 uv = pixel / float2(dst.get_width(), dst.get_height());
  dst.write(pixel_transition(uv, pixel, u, uA, uB), gid);
}
#undef uP
#undef uType
#undef uAspect

#define uBg u[0].xyzw


 
 
float4 pixel_copy(float2 vUv, float2 pixel, constant float4 *u, texture2d<float> uTex) { float4 c = uTex.sample(reelSampler, vUv); return float4(c.rgb + uBg.rgb * (1.0 - c.a), 1.0); }
kernel void reel_copy(texture2d<float> uTex [[texture(0)]], texture2d<float, access::write> dst [[texture(1)]], constant float4 *u [[buffer(0)]], uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= dst.get_width() || gid.y >= dst.get_height()) return;
  float2 pixel = float2(gid) + 0.5;
  float2 uv = pixel / float2(dst.get_width(), dst.get_height());
  dst.write(pixel_copy(uv, pixel, u, uTex), gid);
}
#undef uBg

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

"""#
}
