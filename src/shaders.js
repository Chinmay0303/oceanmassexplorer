export const VERT = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p * 2.0 - 1.0;
  gl_Position = vec4(vUv, 0.0, 1.0);
}`;

export const MAX_CURVE = 64;
export const MAX_RECTS = 8;

// World box: x = lon in [-1,1], z = lat in [-0.5,0.5] (north = -z), y = depth in [-d,d] (surface = +d).
// Texture coords: (u, v, w) = (lon, lat, depth level index), all in [0,1].
export const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
out vec4 outColor;

uniform sampler3D uVol;   // r = normalised T, g = normalised S, b = normalised O2, a = 1 on ocean
uniform sampler3D uVolB;  // next time step, blended in when animating
uniform float uBlend;     // 0 = uVol only, 1 = uVolB only
uniform sampler2D uTF1;   // 1D colour map along x
uniform sampler2D uTF2;   // T-S region transfer function: x = S, y = T
uniform sampler2D uSDF;   // signed distance to the T-S curve (r), 1 where the nearest point is an endpoint (g)

uniform vec3 uEye, uRight, uUp, uFwd;
uniform float uTan, uAspect, uD;
uniform vec3 uClipMin, uClipMax;
uniform int uMode;        // 0 = 1D transfer function, 1 = T-S regions
uniform int uField;       // 0 = T, 1 = S, 2 = O2 (1D mode); indexes the channels of uVol
uniform vec2 uWin;
uniform float uOpacity;
uniform float uContext;  // strength of the lit background ocean body
uniform int uNCurve;
uniform float uSlice;     // depth texture coordinate of the slice, < 0 = off
uniform bool uFiber;
uniform bool uRegions;    // show the T-S rectangles
uniform bool uFill;       // also fill the rectangles as a volume (T-S transfer function)
uniform int uNRect;
uniform vec4 uRect[${MAX_RECTS}];       // closed control polygons: centre (S, T), half size
uniform vec3 uRectColor[${MAX_RECTS}];
uniform float uBand;
uniform vec3 uFiberColor;
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

// (S, T) at tc, false on land
bool sampleST(vec3 tc, out vec2 st) {
  vec4 v = vol(tc);
  if (v.a < 0.5) return false;
  st = v.gr;
  return true;
}

// Signed distance from st to the T-S curve; 'edge' is set when the nearest point is an endpoint
// (the sign is meaningless there).
float curveDist(vec2 st, out bool edge) {
  vec2 q = texture(uSDF, st).rg;
  edge = q.g > 0.5;
  return q.r;
}

// signed distance (negative inside) to rectangle i, a closed control polygon in (S, T)
float sdBox(vec2 st, int i) {
  vec4 b = uRect[i];
  vec2 q = abs(st - b.xy) - b.zw;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}

// which < 0: the curve; otherwise rectangle 'which'
bool fiberAt(vec3 p, int which, out float f) {
  vec2 st; bool e;
  if (!sampleST(toTex(p), st)) return false;
  f = which < 0 ? curveDist(st, e) : sdBox(st, which);
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

vec3 fiberNormal(vec3 p, int which) {
  const float e = 0.01;
  vec3 g = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    vec3 o = vec3(i == 0, i == 1, i == 2) * e;
    float a, b;
    bool oa = fiberAt(p + o, which, a), ob = fiberAt(p - o, which, b);
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
    vec2 st;
    if (ts > 0.0 && abs(p.x) <= 1.0 && abs(p.z) <= 0.5) {
      col = uLand;
      if (inClip(tc) && sampleST(tc, st)) {
        col = OCEAN_MID;
        if (uMode == 0) {
          float w = (vol(tc)[uField] - uWin.x) / (uWin.y - uWin.x);
          if (w >= 0.0 && w <= 1.0) col = texture(uTF1, vec2(w, 0.5)).rgb;
        } else {
          vec4 c = uRegions && uFill ? texture(uTF2, st) : vec4(0.0);
          col = mix(col, c.rgb, c.a * 0.9);
        }
        if (uRegions) {  // rectangle outlines: the fiber surfaces cut by the slice
          for (int i = 0; i < ${MAX_RECTS}; i++) {
            if (i >= uNRect) break;
            col = mix(uRectColor[i], col, smoothstep(uBand * 0.5, uBand * 1.5, abs(sdBox(st, i))));
          }
        }
        if (uFiber && uNCurve > 1) {
          bool e;
          float f = abs(curveDist(st, e));
          if (!e) col = mix(uFiberColor, col, smoothstep(uBand * 0.5, uBand * 1.5, f));
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
  float fPrev = 0.0; bool prevOk = false, prevEdge = true;
  vec3 pPrev = ro;
  vec2 stPrev = vec2(0.0);

  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * t;
    vec3 tc = toTex(p);
    vec2 st;
    bool ok = inClip(tc) && sampleST(tc, st);
    if (ok) {
      if (!hit) { hit = true; hitP = p; }
      vec4 c = vec4(0.0);
      if (uMode == 0) {
        float v = vol(tc)[uField];
        float w = (v - uWin.x) / (uWin.y - uWin.x);
        if (w >= 0.0 && w <= 1.0) c = vec4(texture(uTF1, vec2(w, 0.5)).rgb, uOpacity);
      } else {
        c = uRegions && uFill ? texture(uTF2, st) : vec4(0.0);
        c.a *= uOpacity;
      }
      float a = 1.0 - exp(-c.a * dt * 60.0);
      acc.rgb += (1.0 - acc.a) * a * c.rgb;
      acc.a += (1.0 - acc.a) * a;

      if (uFiber && uNCurve > 1) {
        bool edge;
        float f = curveDist(st, edge);
        if (prevOk && !edge && !prevEdge && f * fPrev < 0.0 && abs(f) < uBand * 8.0 && abs(fPrev) < uBand * 8.0) {
          vec3 ph = mix(pPrev, p, abs(fPrev) / (abs(fPrev) + abs(f)));
          vec3 col = fiberShade(fiberNormal(ph, -1), rd, uFiberColor);
          float fa = 0.9;
          acc.rgb += (1.0 - acc.a) * fa * col;
          acc.a += (1.0 - acc.a) * fa;
        }
        fPrev = f; prevEdge = edge;
      }
      if (uRegions && prevOk) {  // closed rectangles: same sign-change test as the curve
        for (int i = 0; i < ${MAX_RECTS}; i++) {
          if (i >= uNRect) break;
          float f = sdBox(st, i), fp = sdBox(stPrev, i);
          if (f * fp < 0.0 && abs(f) < uBand * 8.0 && abs(fp) < uBand * 8.0) {
            vec3 ph = mix(pPrev, p, abs(fp) / (abs(fp) + abs(f)));
            vec3 col = fiberShade(fiberNormal(ph, i), rd, uRectColor[i]);
            acc.rgb += (1.0 - acc.a) * 0.9 * col;
            acc.a += (1.0 - acc.a) * 0.9;
          }
        }
      }
      stPrev = st;
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
