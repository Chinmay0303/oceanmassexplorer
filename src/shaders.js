export const VERT = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p * 2.0 - 1.0;
  gl_Position = vec4(vUv, 0.0, 1.0);
}`;

export const MAX_CURVE = 64;
export const MAX_RECTS = 8;     // rectangles in total, across all diagrams
export const MAX_CURVES = 4;    // curves in total, across all diagrams
// Channels of the volume texture (0 = T, 1 = S, 2 = O2) that form the (x, y) axes of each diagram: T-S, T-O2, S-O2
export const PAIR_CHANNELS = [[1, 0], [2, 0], [2, 1]];

// World box: x = lon in [-1,1], z = lat in [-0.5,0.5] (north = -z), y = depth in [-d,d] (surface = +d).
// Texture coords: (u, v, w) = (lon, lat, depth level index), all in [0,1].
export const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
precision highp sampler2DArray;
in vec2 vUv;
out vec4 outColor;

uniform sampler3D uVol;   // r = normalised T, g = normalised S, b = normalised O2, a = 1 on ocean
uniform sampler3D uVolB;  // next time step, blended in when animating
uniform float uBlend;     // 0 = uVol only, 1 = uVolB only
uniform sampler2D uTF1;   // 1D colour map along x
uniform sampler2DArray uTF2;  // region transfer function, one layer per diagram: x / y = the diagram's two axes
uniform sampler2DArray uSDF;  // one layer per curve: signed distance to the curve in its diagram (r), 1 where the nearest point is an endpoint (g)

uniform vec3 uEye, uRight, uUp, uFwd;
uniform float uTan, uAspect, uD;
uniform vec3 uClipMin, uClipMax;
uniform bool uTF1D;       // colour the ocean by one field (1D transfer function)
uniform int uField;       // 0 = T, 1 = S, 2 = O2 (1D mode); indexes the channels of uVol
uniform vec2 uWin;
uniform float uOpacity;
uniform float uContext;  // strength of the lit background ocean body
uniform int uNCurve;
uniform vec3 uCurveColor[${MAX_CURVES}];
uniform int uCurvePair[${MAX_CURVES}];   // diagram (0 T-S, 1 T-O2, 2 S-O2) of each curve
uniform float uSlice;     // depth texture coordinate of the slice, < 0 = off
uniform int uFillMask;    // bit k set: rectangles of diagram k are drawn as a volume (uTF2 layer k)
uniform int uNRect;
uniform vec4 uRect[${MAX_RECTS}];       // rectangles drawn as surfaces: centre (x, y) and half size in their diagram
uniform vec3 uRectColor[${MAX_RECTS}];
uniform int uRectPair[${MAX_RECTS}];    // diagram of each rectangle
uniform float uBand;
uniform vec3 uBg, uLand, uEdge;  // theme colours: background, land (slice mode), box edges

// palette: tertiary / secondary / primary
const vec3 OCEAN_LIGHT = vec3(0.110, 0.639, 0.925);
const vec3 OCEAN_MID = vec3(0.137, 0.537, 0.855);
const vec3 OCEAN_DEEP = vec3(0.059, 0.369, 0.612);

// volume lookup; between two time steps both are sampled and mixed (one fetch when not blending)
vec4 vol(vec3 tc) {
  vec4 a = texture(uVol, tc);
  if (uBlend > 0.0) a = mix(a, texture(uVolB, tc), uBlend);
  return a;
}

vec3 toTex(vec3 p) { return vec3(p.x * 0.5 + 0.5, 0.5 - p.z, 0.5 - p.y / (2.0 * uD)); }

bool inClip(vec3 tc) { return all(greaterThanEqual(tc, uClipMin)) && all(lessThanEqual(tc, uClipMax)); }

const ivec2 PAIR_CH[3] = ivec2[3](${PAIR_CHANNELS.map(([x, y]) => `ivec2(${x}, ${y})`).join(', ')});

// the (x, y) values of diagram k at volume sample v
vec2 stOf(vec4 v, int k) { ivec2 c = PAIR_CH[k]; return vec2(v[c.x], v[c.y]); }

// volume sample at tc; false on land
bool sampleV(vec3 tc, out vec4 v) {
  v = vol(tc);
  return v.a >= 0.5;
}

// Signed distance from st to curve slot c; 'edge' is set when the nearest point is an endpoint
// (the sign is meaningless there).
float curveDist(vec2 st, int c, out bool edge) {
  vec2 q = texture(uSDF, vec3(st, float(c))).rg;
  edge = q.g > 0.5;
  return q.r;
}

// signed distance (negative inside) to rectangle i in its diagram
float sdBox(vec2 st, int i) {
  vec4 b = uRect[i];
  vec2 q = abs(st - b.xy) - b.zw;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}

// signed distance of selection id at sample v: id < MAX_RECTS is a rectangle, otherwise curve id - MAX_RECTS
float selDist(vec4 v, int id) {
  if (id < ${MAX_RECTS}) return sdBox(stOf(v, uRectPair[id]), id);
  bool e;
  int c = id - ${MAX_RECTS};
  return curveDist(stOf(v, uCurvePair[c]), c, e);
}

bool fiberAt(vec3 p, int id, out float f) {
  vec4 v;
  if (!sampleV(toTex(p), v)) return false;
  f = selDist(v, id);
  return true;
}

// 1 inside the visible ocean, 0 elsewhere (land, clipped away, outside the box)
float occupancy(vec3 p) {
  vec3 tc = toTex(p);
  return inClip(tc) ? vol(tc).a : 0.0;
}

vec3 withGrid(vec3 col, vec2 gr, vec2 fw) {  // lat/lon grid every 30 degrees
  vec2 a = abs(fract(gr - 0.5) - 0.5) / max(fw, vec2(1e-4));
  return mix(col, vec3(1.0), 0.35 * (1.0 - min(min(a.x, a.y), 1.0)));
}

vec3 fiberShade(vec3 n, vec3 rd, vec3 base) {
  float diff = abs(dot(n, rd));
  return base * (0.35 + 0.65 * diff) + vec3(0.4) * pow(diff, 24.0);
}

vec3 fiberNormal(vec3 p, int id) {
  const float e = 0.01;
  vec3 g = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    vec3 o = vec3(i == 0, i == 1, i == 2) * e;
    float a, b;
    bool oa = fiberAt(p + o, id, a), ob = fiberAt(p - o, id, b);
    g[i] = (oa ? a : 0.0) - (ob ? b : 0.0);
  }
  return normalize(g + 1e-9);
}

void main() {
  vec3 rd = normalize(uFwd + vUv.x * uAspect * uTan * uRight + vUv.y * uTan * uUp);
  vec3 ro = uEye;
  vec3 h = vec3(1.0, uD, 0.5);

  vec3 bg = uBg;

  if (uSlice >= 0.0) {  // slice mode: one sample per pixel on a horizontal plane
    float y = uD * (1.0 - 2.0 * uSlice);
    float ts = (y - ro.y) / rd.y;
    vec3 p = ro + rd * ts;
    vec2 gr = vec2(p.x, -p.z) * 180.0 / 30.0;
    vec2 fw = fwidth(gr);
    vec3 col = bg;
    vec3 tc = toTex(p);
    vec4 v;
    if (ts > 0.0 && abs(p.x) <= 1.0 && abs(p.z) <= 0.5) {
      col = uLand;
      if (inClip(tc) && sampleV(tc, v)) {
        col = OCEAN_MID;
        if (uTF1D) {
          float w = (v[uField] - uWin.x) / (uWin.y - uWin.x);
          if (w >= 0.0 && w <= 1.0) col = texture(uTF1, vec2(w, 0.5)).rgb;
        }
        for (int k = 0; k < 3; k++) {  // rectangle volumes, per diagram
          if (((uFillMask >> k) & 1) == 0) continue;
          vec4 c = texture(uTF2, vec3(stOf(v, k), float(k)));
          col = mix(col, c.rgb, c.a * 0.9);
        }
        for (int i = 0; i < ${MAX_RECTS}; i++) {  // rectangle outlines: the fiber surfaces cut by the slice
          if (i >= uNRect) break;
          col = mix(uRectColor[i], col, smoothstep(uBand * 0.5, uBand * 1.5, abs(sdBox(stOf(v, uRectPair[i]), i))));
        }
        for (int ci = 0; ci < ${MAX_CURVES}; ci++) {
          if (ci >= uNCurve) break;
          bool e;
          float f = abs(curveDist(stOf(v, uCurvePair[ci]), ci, e));
          if (!e) col = mix(uCurveColor[ci], col, smoothstep(uBand * 0.5, uBand * 1.5, f));
        }
        col = withGrid(col, gr, fw);
      }
    }
    outColor = vec4(col, 1.0);
    return;
  }

  vec3 inv = 1.0 / rd;
  vec3 t0 = (-h - ro) * inv, t1 = (h - ro) * inv;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  float tn = max(max(tmin.x, tmin.y), max(tmin.z, 0.0)), tf = min(min(tmax.x, tmax.y), tmax.z);
  if (tf <= tn) { outColor = vec4(bg, 1.0); return; }

  const int STEPS = 320;
  float dt = (tf - tn) / float(STEPS);
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  float t = tn + dt * jitter;

  vec4 acc = vec4(0.0);
  bool hit = false; vec3 hitP = ro;  // first ocean sample: surface of the background ocean body
  bool prevOk = false;
  vec3 pPrev = ro;
  float fpc[${MAX_CURVES}], fpe[${MAX_CURVES}];  // previous curve distances / endpoint flags (per curve slot)
  float fpr[${MAX_RECTS}];                       // previous rectangle distances
  for (int j = 0; j < ${MAX_CURVES}; j++) { fpc[j] = 0.0; fpe[j] = 1.0; }
  for (int j = 0; j < ${MAX_RECTS}; j++) fpr[j] = 0.0;

  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * t;
    vec3 tc = toTex(p);
    vec4 v;
    bool ok = inClip(tc) && sampleV(tc, v);
    if (ok) {
      if (!hit) { hit = true; hitP = p; }
      vec4 c = vec4(0.0);
      if (uTF1D) {
        float w = (v[uField] - uWin.x) / (uWin.y - uWin.x);
        if (w >= 0.0 && w <= 1.0) c = vec4(texture(uTF1, vec2(w, 0.5)).rgb, uOpacity);
      }
      for (int k = 0; k < 3; k++) {  // rectangle volumes of every diagram, on top of the 1D colouring ('over' operator)
        if (((uFillMask >> k) & 1) == 0) continue;
        vec4 r = texture(uTF2, vec3(stOf(v, k), float(k)));
        r.a *= uOpacity;
        float a0 = r.a + c.a * (1.0 - r.a);
        if (a0 > 0.0) c.rgb = (r.rgb * r.a + c.rgb * c.a * (1.0 - r.a)) / a0;
        c.a = a0;
      }
      float a = 1.0 - exp(-c.a * dt * 60.0);
      acc.rgb += (1.0 - acc.a) * a * c.rgb;
      acc.a += (1.0 - acc.a) * a;

      for (int ci = 0; ci < ${MAX_CURVES}; ci++) {  // fiber surfaces of the curves: sign change of the distance between two samples
        if (ci >= uNCurve) break;
        bool edge;
        float f = curveDist(stOf(v, uCurvePair[ci]), ci, edge);
        if (prevOk && !edge && fpe[ci] < 0.5 && f * fpc[ci] < 0.0 && abs(f) < uBand * 8.0 && abs(fpc[ci]) < uBand * 8.0) {
          vec3 ph = mix(pPrev, p, abs(fpc[ci]) / (abs(fpc[ci]) + abs(f)));
          vec3 col = fiberShade(fiberNormal(ph, ${MAX_RECTS} + ci), rd, uCurveColor[ci]);
          float fa = 0.9;
          acc.rgb += (1.0 - acc.a) * fa * col;
          acc.a += (1.0 - acc.a) * fa;
        }
        fpc[ci] = f; fpe[ci] = edge ? 1.0 : 0.0;
      }
      for (int ri = 0; ri < ${MAX_RECTS}; ri++) {  // rectangle surfaces: same sign-change test
        if (ri >= uNRect) break;
        float f = sdBox(stOf(v, uRectPair[ri]), ri), fp = fpr[ri];
        if (prevOk && f * fp < 0.0 && abs(f) < uBand * 8.0 && abs(fp) < uBand * 8.0) {
          vec3 ph = mix(pPrev, p, abs(fp) / (abs(fp) + abs(f)));
          vec3 col = fiberShade(fiberNormal(ph, ri), rd, uRectColor[ri]);
          acc.rgb += (1.0 - acc.a) * 0.9 * col;
          acc.a += (1.0 - acc.a) * 0.9;
        }
        fpr[ri] = f;
      }
      pPrev = p;
    }
    prevOk = ok;
    if (acc.a > 0.98) break;
    t += dt;
  }

  // background ocean body: lit solid, drawn behind the selections
  vec3 under = bg;
  if (hit && uContext > 0.0) {
    vec3 g = vec3(0.0);
    for (int i = 0; i < 3; i++) {
      vec3 o = vec3(i == 0, i == 1, i == 2) * 0.01;
      g[i] = occupancy(hitP + o) - occupancy(hitP - o);
    }
    vec3 n = -normalize(g + vec3(0.0, 1e-4, 0.0));
    float lit = 0.3 + 0.7 * clamp(dot(n, normalize(vec3(-0.4, 0.8, 0.5))), 0.0, 1.0);
    vec3 col = mix(OCEAN_LIGHT, OCEAN_DEEP, sqrt(toTex(hitP).z)) * lit;
    vec2 gr = vec2(hitP.x, -hitP.z) * 180.0 / 30.0;
    if (n.y > 0.5) col = withGrid(col, gr, fwidth(gr));
    under = mix(bg, col, uContext);
  }

  // faint box edges
  vec3 pe = ro + rd * tn;
  vec3 q = abs(pe) / h;
  float nearEdge = step(0.995, q.x) + step(0.995, q.y) + step(0.995, q.z);
  outColor = vec4(acc.rgb + (1.0 - acc.a) * (nearEdge >= 2.0 ? uEdge : under), 1.0);
}`;
