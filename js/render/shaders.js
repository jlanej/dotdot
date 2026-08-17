// @ts-check
/**
 * Segment shaders. Each match/alignment is one instance, expanded in the
 * vertex shader into a screen-aligned quad along the segment direction.
 *
 * Precision: genome coordinates (up to 2^32 bp) exceed float32's 2^24 integer
 * range, so world positions are stored as a float pair (hi = fround(v),
 * lo = v - hi) and the view center is subtracted hi-from-hi, lo-from-lo —
 * nearby his cancel exactly (Sterbenz), leaving sub-bp precision at any zoom.
 * This is the standard relative-to-center trick from large-coordinate mapping
 * renderers.
 */

export const VERT = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;   // x: 0..1 along segment, y: -1..1 across
layout(location = 1) in vec2 aP0Hi;
layout(location = 2) in vec2 aP0Lo;
layout(location = 3) in vec2 aP1Hi;
layout(location = 4) in vec2 aP1Lo;
layout(location = 5) in vec2 aMeta;     // identity, strand

uniform vec2 uCenterHi;
uniform vec2 uCenterLo;
uniform vec2 uPxPerBp;                  // device px per bp (x, y)
uniform vec2 uHalfViewPx;               // half canvas size in device px
uniform float uWidthPx;                 // line width, device px
uniform float uMinLenPx;                // minimum drawn length, device px
uniform vec2 uStrandVisible;            // (fwd, rev) 0/1
uniform float uMinIdentity;
uniform float uMinLenBp;
uniform float uTotalX;                  // target axis length (multiplicity lookup)

out float vAcross;
out float vIdentity;
out float vXNorm;
flat out float vStrand;

void main() {
  float ident = aMeta.x;
  float strand = aMeta.y;

  float vis = mix(uStrandVisible.x, uStrandVisible.y, strand);
  vis *= step(uMinIdentity, ident + 1e-6);

  vec2 rel0 = (aP0Hi - uCenterHi) + (aP0Lo - uCenterLo);
  vec2 rel1 = (aP1Hi - uCenterHi) + (aP1Lo - uCenterLo);
  vis *= step(uMinLenBp, abs(rel1.x - rel0.x) + 0.5);

  if (vis < 0.5) {
    gl_Position = vec4(4.0, 4.0, 2.0, 1.0);
    vAcross = 0.0;
    vIdentity = 0.0;
    vStrand = 0.0;
    vXNorm = 0.0;
    return;
  }

  // Absolute target position of this corner, normalized for the multiplicity
  // texture — long segments shade along their length. Float32 rounding at Gb
  // scale (~hundreds of bp) is far below one texel.
  float wx = mix(aP0Hi.x + aP0Lo.x, aP1Hi.x + aP1Lo.x, aCorner.x);
  vXNorm = wx / max(uTotalX, 1.0);

  vec2 s0 = rel0 * uPxPerBp;
  vec2 s1 = rel1 * uPxPerBp;
  vec2 d = s1 - s0;
  float len = length(d);
  vec2 u = len > 1e-6 ? d / len : vec2(0.7071, 0.7071);

  // Keep sub-pixel matches visible: extend to uMinLenPx around the midpoint.
  float ext = max(len, uMinLenPx);
  vec2 mid = (s0 + s1) * 0.5;
  vec2 origin = mid - u * (ext * 0.5);
  vec2 p = origin + u * (ext * aCorner.x) + vec2(-u.y, u.x) * (aCorner.y * uWidthPx * 0.5);

  gl_Position = vec4(p / uHalfViewPx, 0.0, 1.0);
  vAcross = aCorner.y;
  vIdentity = ident;
  vStrand = strand;
}
`;

export const FRAG = /* glsl */ `#version 300 es
precision highp float;

in float vAcross;
in float vIdentity;
in float vXNorm;
flat in float vStrand;

uniform sampler2D uColormap;   // 256 x 6: ramps (0,1), flats (2,3), multiplicity (4,5)
uniform sampler2D uMultTex;    // 1D log-multiplicity profile along the target
uniform float uColorMode;      // 0 = identity ramp, 1 = flat strand, 2 = multiplicity
uniform float uIdentLo;        // identity mapped to ramp start
uniform float uAlpha;
uniform float uWidthPx;
uniform vec4 uForceColor;      // a > 0 overrides (highlight pass)

out vec4 outColor;

void main() {
  float identT = clamp((vIdentity - uIdentLo) / max(1.0 - uIdentLo, 1e-6), 0.0, 1.0);
  float t = uColorMode > 1.5 ? texture(uMultTex, vec2(vXNorm, 0.5)).r : identT;
  float row = vStrand + uColorMode * 2.0;
  vec2 uv = vec2(t * (255.0 / 256.0) + 0.5 / 256.0, (row + 0.5) / 6.0);
  vec3 rgb = texture(uColormap, uv).rgb;
  if (uForceColor.a > 0.0) rgb = uForceColor.rgb;

  float edge = max(1.0 - 1.6 / max(uWidthPx, 1.6), 0.0);
  float aa = 1.0 - smoothstep(edge, 1.0, abs(vAcross));
  outColor = vec4(rgb, uAlpha * aa);
}
`;
