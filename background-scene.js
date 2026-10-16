import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/* =========================================================================
   Setup
   ========================================================================= */
const canvas = document.getElementById('bgScene');
const isMobile = matchMedia('(max-width: 900px)').matches || matchMedia('(pointer: coarse)').matches;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const Q = isMobile ? 0.55 : 1;           // density multiplier

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
} catch (e) {
  canvas.remove();
  throw e;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile ? 1.25 : 1.6));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const V3 = THREE.Vector3;
const scene = new THREE.Scene();
const FOG = new THREE.Color(0x02040b);
scene.background = FOG.clone();
scene.fog = new THREE.FogExp2(FOG, 0.014);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1400);

// deterministic randomness so the composition is identical on every visit
let seed = 1337;
const rand = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const R = (a, b) => a + (b - a) * rand();
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// studio environment: dark room with blue / violet softboxes for elegant reflections
const pmrem = new THREE.PMREMGenerator(renderer);
{
  const env = new THREE.Scene();
  env.background = new THREE.Color(0x010209);
  const box = (hex, k, w, h, p) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.copy(p); m.lookAt(0, 0, 0); env.add(m);
  };
  box(0xcfe0ff, 3.0, 9, 2.2, new V3(0, 7, 4));
  box(0x3d8bff, 2.4, 2.5, 11, new V3(-8, 0, 3));
  box(0x8a64ff, 2.0, 2.5, 11, new V3(8, 1, -2));
  box(0x5fe6ff, 1.2, 14, 1, new V3(0, -6, -6));
  scene.environment = pmrem.fromScene(env, 0.02).texture;
}
scene.add(new THREE.AmbientLight(0x1a2a50, 0.7));
const keyLight = new THREE.DirectionalLight(0xbfd6ff, 0.8); keyLight.position.set(0.4, 1, 1); scene.add(keyLight);
const chipLightA = new THREE.PointLight(0x4aa8ff, 140, 70, 2); chipLightA.position.set(9, 10, 12); scene.add(chipLightA);
const chipLightB = new THREE.PointLight(0x8a5cff, 90, 70, 2); chipLightB.position.set(-11, -8, 10); scene.add(chipLightB);

/* =========================================================================
   Shared shader plumbing
   ========================================================================= */
const U = {
  uTime: { value: 0 }, uFog: { value: 0.014 }, uFogColor: { value: FOG },
  uPR: { value: renderer.getPixelRatio() }, uScale: { value: 1000 },
};
const HEAD = /* glsl */`
  uniform float uTime; uniform float uFog; uniform vec3 uFogColor; uniform float uPR; uniform float uScale;
  varying float vDepth;
  float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
  float hash21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
`;
const FOGF = `float fogVis(){ return exp(-uFog * uFog * vDepth * vDepth); }\n`;
function mat(vs, fs, uniforms = {}, opts = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: HEAD + vs, fragmentShader: HEAD + FOGF + fs,
    uniforms: { ...U, ...uniforms },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, ...opts,
  });
}
const VS_BASIC = `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; vec4 mv = viewMatrix * w; vDepth = -mv.z; gl_Position = projectionMatrix * mv; }`;

// "flow" lines: dim rails with luminous packets travelling along aT
function flowMaterial(color, { speed = 0.25, reps = 1, base = 0.06, gain = 1.6 } = {}) {
  return mat(
    `attribute float aT; attribute float aSeed; varying float vT; varying float vSeed;
     void main(){ vT = aT; vSeed = aSeed; vec4 mv = modelViewMatrix * vec4(position,1.0); vDepth = -mv.z; gl_Position = projectionMatrix * mv; }`,
    `uniform vec3 uColor; uniform float uSpeed, uReps, uBase, uGain, uFade; varying float vT; varying float vSeed;
     void main(){
       float f = fract(vT * uReps - uTime * uSpeed * (0.6 + vSeed * 0.8) + vSeed * 7.0);
       float pulse = pow(f, 14.0) * step(0.35, fract(vSeed * 13.7));
       vec3 c = uColor * (uBase + pulse * uGain) + vec3(0.6, 0.9, 1.0) * pulse * pulse * 0.6;
       gl_FragColor = vec4(c * uFade * fogVis(), 1.0);
     }`,
    { uColor: { value: new THREE.Color(color) }, uSpeed: { value: speed }, uReps: { value: reps },
      uBase: { value: base }, uGain: { value: gain }, uFade: { value: 1 } });
}
function polylineToSegments(lines) { // lines: [{pts:[V3], seed}] -> LineSegments geometry with aT, aSeed
  const pos = [], at = [], sd = [];
  for (const { pts, seed: s, reverse } of lines) {
    let total = 0; const acc = [0];
    for (let i = 1; i < pts.length; i++) { total += pts[i].distanceTo(pts[i - 1]); acc.push(total); }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      let ta = acc[i - 1] / total, tb = acc[i] / total;
      if (reverse) { ta = 1 - ta; tb = 1 - tb; }
      at.push(ta, tb); sd.push(s, s);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aT', new THREE.Float32BufferAttribute(at, 1));
  g.setAttribute('aSeed', new THREE.Float32BufferAttribute(sd, 1));
  return g;
}

// soft luminous points
function pointsMaterial(color, { opacity = 1, twinkle = 0.45 } = {}) {
  return mat(
    `attribute float aSize; attribute float aRnd; varying float vA;
     void main(){
       vec3 p = position;
       p.x += sin(uTime * 0.07 + aRnd * 30.0) * 0.9;
       p.y += cos(uTime * 0.05 + aRnd * 20.0) * 0.7;
       vec4 mv = modelViewMatrix * vec4(p, 1.0); vDepth = -mv.z;
       float s = aSize * uScale / max(vDepth, 0.5);
       vA = (1.0 - ${twinkle.toFixed(2)}) + ${twinkle.toFixed(2)} * sin(uTime * (0.5 + aRnd) + aRnd * 40.0);
       vA *= clamp(s / 1.5, 0.0, 1.0);
       gl_PointSize = clamp(s, 1.0, 7.0 * uPR);
       gl_Position = projectionMatrix * mv;
     }`,
    `uniform vec3 uColor; uniform float uOpacity; varying float vA;
     void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d); a *= a;
       gl_FragColor = vec4(uColor * a * vA * uOpacity * fogVis(), 1.0); }`,
    { uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity } });
}
function makeDust(count, box, sizeRange, color, opacity) {
  const p = new Float32Array(count * 3), s = new Float32Array(count), r = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    p[i * 3] = R(box[0], box[1]); p[i * 3 + 1] = R(box[2], box[3]); p[i * 3 + 2] = R(box[4], box[5]);
    s[i] = R(sizeRange[0], sizeRange[1]); r[i] = rand();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(s, 1));
  g.setAttribute('aRnd', new THREE.BufferAttribute(r, 1));
  const pts = new THREE.Points(g, pointsMaterial(color, { opacity }));
  pts.frustumCulled = false;
  return pts;
}

/* =========================================================================
   Camera path — one continuous journey
   ========================================================================= */
const path = new THREE.CatmullRomCurve3([
  new V3(0, 5, 68), new V3(0.3, 3, 40), new V3(0, 0.8, 18), new V3(0, 0, -6),
  new V3(3, 1.2, -45), new V3(-3, -0.5, -95), new V3(1, 0.5, -140), new V3(2, 0, -185),
  new V3(-1.5, 1, -235), new V3(0, 3, -285), new V3(-2, 5, -335), new V3(0, 6.5, -385),
  new V3(0, 7, -440), new V3(0, 7, -525),
], false, 'centripetal');
const LUT_N = 2400, lutZ = new Float32Array(LUT_N + 1);
for (let i = 0; i <= LUT_N; i++) lutZ[i] = path.getPoint(i / LUT_N).z;
function uAtZ(z) {
  if (z >= lutZ[0]) return 0;
  if (z <= lutZ[LUT_N]) return 1;
  let lo = 0, hi = LUT_N;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (lutZ[m] > z) lo = m; else hi = m; }
  return (lo + (lutZ[lo] - z) / (lutZ[lo] - lutZ[hi])) / LUT_N;
}
const pathAt = (z, out = new V3()) => path.getPoint(uAtZ(z), out);

const groups = [];
function stage(zNear, zFar) { const g = new THREE.Group(); g.userData = { zNear, zFar }; scene.add(g); groups.push(g); return g; }

/* =========================================================================
   SCENE 1 — Digital Genesis: circuit board + processor
   ========================================================================= */
const S1 = stage(20, -2);

function offsetPolyline(pts, off) {
  const nrm = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [-dy / l, dx / l]; };
  return pts.map((p, i) => {
    let n;
    if (i === 0) n = nrm(pts[0], pts[1]);
    else if (i === pts.length - 1) n = nrm(pts[i - 1], pts[i]);
    else {
      const a = nrm(pts[i - 1], pts[i]), b = nrm(pts[i], pts[i + 1]);
      let mx = a[0] + b[0], my = a[1] + b[1]; const l = Math.hypot(mx, my) || 1; mx /= l; my /= l;
      const s = 1 / Math.max(0.3, mx * a[0] + my * a[1]); n = [mx * s, my * s];
    }
    return [p[0] + n[0] * off, p[1] + n[1] * off];
  });
}
function circuitTexture(W) {
  const S = isMobile ? 1024 : 2048, k = S / W;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  g.lineCap = 'round'; g.lineJoin = 'round';
  const X = x => (x + W / 2) * k, Y = y => (W / 2 - y) * k;
  // fine reference grid
  g.strokeStyle = 'rgba(255,255,255,0.05)'; g.lineWidth = 1;
  for (let v = -W / 2; v <= W / 2; v += 5) { g.beginPath(); g.moveTo(X(v), 0); g.lineTo(X(v), S); g.moveTo(0, Y(v)); g.lineTo(S, Y(v)); g.stroke(); }
  // secondary ICs
  for (let i = 0; i < 8; i++) {
    let x, y; do { x = R(-62, 62); y = R(-62, 62); } while (Math.max(Math.abs(x), Math.abs(y)) < 26);
    const s = R(5, 9);
    g.strokeStyle = 'rgba(255,255,255,0.45)'; g.lineWidth = Math.max(1, 0.12 * k);
    g.strokeRect(X(x - s / 2), Y(y + s / 2), s * k, s * k);
    g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(X(x - s / 2), Y(y + s / 2), s * k, s * k);
    g.fillStyle = 'rgba(255,255,255,0.55)';
    for (let t = -s / 2 + 0.6; t < s / 2 - 0.3; t += 0.7) {
      g.fillRect(X(x + t) - 0.1 * k, Y(y + s / 2 + 0.7), 0.2 * k, 0.6 * k);
      g.fillRect(X(x + t) - 0.1 * k, Y(y - s / 2 - 0.1), 0.2 * k, 0.6 * k);
    }
  }
  // routed trace bundles with 45° bends
  const dirs = [...Array(8)].map((_, i) => [Math.cos(i * Math.PI / 4), Math.sin(i * Math.PI / 4)]);
  for (let b = 0; b < (isMobile ? 60 : 95); b++) {
    let x, y; do { x = R(-80, 80); y = R(-80, 80); } while (Math.max(Math.abs(x), Math.abs(y)) < 20);
    let d = Math.floor(rand() * 4) * 2;
    const pts = [[x, y]];
    const segs = 2 + Math.floor(rand() * 3);
    for (let s = 0; s < segs; s++) {
      const L = s % 2 ? R(2, 6) : R(6, 22);
      x += dirs[d][0] * L; y += dirs[d][1] * L; pts.push([x, y]);
      d = (d + (rand() < 0.5 ? 1 : 7)) % 8;
    }
    const n = 1 + Math.floor(rand() * 6), bright = R(0.22, 0.6);
    for (let j = 0; j < n; j++) {
      const q = offsetPolyline(pts, (j - (n - 1) / 2) * 0.55);
      g.strokeStyle = `rgba(255,255,255,${bright})`; g.lineWidth = Math.max(1, 0.16 * k);
      g.beginPath(); q.forEach((p, i) => i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1]))); g.stroke();
      for (const p of [q[0], q[q.length - 1]]) {
        g.beginPath(); g.arc(X(p[0]), Y(p[1]), 0.26 * k, 0, Math.PI * 2); g.fillStyle = `rgba(255,255,255,${Math.min(1, bright * 1.7)})`; g.fill();
        g.beginPath(); g.arc(X(p[0]), Y(p[1]), 0.1 * k, 0, Math.PI * 2); g.fillStyle = '#000'; g.fill();
      }
    }
  }
  // passive components
  for (let i = 0; i < (isMobile ? 40 : 80); i++) {
    let x, y; do { x = R(-75, 75); y = R(-75, 75); } while (Math.max(Math.abs(x), Math.abs(y)) < 12);
    const w = R(0.7, 1.6), h = w * R(0.45, 0.6), rot = rand() < 0.5;
    const [ww, hh] = rot ? [h, w] : [w, h];
    g.strokeStyle = 'rgba(255,255,255,0.3)'; g.lineWidth = 1;
    g.strokeRect(X(x - ww / 2), Y(y + hh / 2), ww * k, hh * k);
    g.fillStyle = 'rgba(255,255,255,0.65)';
    if (rot) { g.fillRect(X(x - ww / 2), Y(y + hh / 2), ww * k, 0.22 * k); g.fillRect(X(x - ww / 2), Y(y - hh / 2) - 0.22 * k, ww * k, 0.22 * k); }
    else { g.fillRect(X(x - ww / 2), Y(y + hh / 2), 0.22 * k, hh * k); g.fillRect(X(x + ww / 2) - 0.22 * k, Y(y + hh / 2), 0.22 * k, hh * k); }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

const BOARD = 170;
const boardMat = mat(VS_BASIC.replace('varying vec3 vW;', 'varying vec3 vW; varying vec2 vUv;').replace('vW = w.xyz;', 'vW = w.xyz; vUv = uv;'),
  `uniform sampler2D uMap; uniform float uReveal; uniform float uFade; varying vec3 vW; varying vec2 vUv;
   void main(){
     float v = texture2D(uMap, vUv).r;
     float r = length(vW.xy);
     float rev = 1.0 - smoothstep(uReveal - 24.0, uReveal, r);
     float front = exp(-pow((r - uReveal + 8.0) / 6.0, 2.0));
     float sweepPos = mod(uTime * 7.0, 340.0) - 170.0;
     float sweep = exp(-pow((vW.x * 0.8 + vW.y * 0.6) - sweepPos, 2.0) / 220.0);
     vec3 base = vec3(0.010, 0.016, 0.034) + vec3(0.015, 0.03, 0.07) * sweep;
     vec3 trace = mix(vec3(0.08, 0.36, 1.0), vec3(0.5, 0.85, 1.0), smoothstep(0.6, 1.0, v));
     vec3 col = base + trace * v * rev * (0.28 + 0.5 * sweep + 0.8 * front);
     col = mix(uFogColor, col, 1.0 - smoothstep(50.0, 82.0, r));
     col = mix(uFogColor, col, fogVis());
     gl_FragColor = vec4(col, uFade);
   }`,
  { uMap: { value: circuitTexture(BOARD) }, uReveal: { value: 0 }, uFade: { value: 1 } },
  { blending: THREE.NormalBlending, depthWrite: true });
const board = new THREE.Mesh(new THREE.PlaneGeometry(BOARD, BOARD), boardMat);
S1.add(board);

// crisp geometric bus traces radiating from the processor
const busMat = mat(
  `attribute float aLen; attribute float aTot; attribute float aSeed; varying float vLen; varying float vTot; varying float vSeed;
   void main(){ vLen = aLen; vTot = aTot; vSeed = aSeed; vec4 mv = modelViewMatrix * vec4(position,1.0); vDepth = -mv.z; gl_Position = projectionMatrix * mv; }`,
  `uniform float uReveal; uniform float uFade; varying float vLen; varying float vTot; varying float vSeed;
   void main(){
     float rev = 1.0 - smoothstep(uReveal * 0.42 - 3.0, uReveal * 0.42, vLen);
     float speed = 5.0 + vSeed * 7.0;
     float head = mod(uTime * speed + vSeed * 97.0, vTot + 30.0);
     float dd = head - vLen;
     float pulse = (dd > 0.0 ? exp(-dd * 0.8) : 0.0) * step(0.45, vSeed);
     vec3 col = vec3(0.10, 0.36, 0.95) * 0.32 + vec3(0.55, 0.9, 1.0) * pulse * 1.7;
     gl_FragColor = vec4(col * rev * uFade * fogVis(), 1.0);
   }`,
  { uReveal: { value: 0 }, uFade: { value: 1 } });
const viaPts = [];
{
  const half = 6.5, pins = isMobile ? 20 : 28, groupsN = 4, sp = 0.38;
  const pos = [], len = [], tot = [], sd = [];
  for (let side = 0; side < 4; side++) {
    const a = side * Math.PI / 2, ca = Math.cos(a), sa = Math.sin(a);
    const rot = (x, y) => [x * ca - y * sa, x * sa + y * ca];
    const groupL3 = [...Array(groupsN)].map(() => R(8, 26));
    for (let p = 0; p < pins; p++) {
      const g = Math.floor(p / (pins / groupsN));
      const off = (p - (pins - 1) / 2) * sp;
      const gc = ((g + 0.5) / groupsN - 0.5) * pins * sp;
      const sgn = Math.sign(gc) || 1;
      const L1 = 0.9 + (5.2 - Math.abs(gc)) * 1.05, dg = 3.4;
      const L3 = rand() < 0.12 ? R(1, 3) : groupL3[g] + R(-1.2, 1.2);
      const y0 = half + 0.7;
      const local = [[off, y0], [off, y0 + L1], [off + sgn * dg, y0 + L1 + dg], [off + sgn * dg, y0 + L1 + dg + L3]];
      const pts = local.map(([x, y]) => rot(x, y));
      let acc = 0, total = 0;
      for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      const s = rand();
      for (let i = 1; i < pts.length; i++) {
        const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        pos.push(pts[i - 1][0], pts[i - 1][1], 0.03, pts[i][0], pts[i][1], 0.03);
        len.push(acc, acc + l); acc += l; tot.push(total, total); sd.push(s, s);
      }
      viaPts.push(new V3(pts[3][0], pts[3][1], 0.04));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aLen', new THREE.Float32BufferAttribute(len, 1));
  g.setAttribute('aTot', new THREE.Float32BufferAttribute(tot, 1));
  g.setAttribute('aSeed', new THREE.Float32BufferAttribute(sd, 1));
  S1.add(new THREE.LineSegments(g, busMat));
}

// the processor
const chip = new THREE.Group(); S1.add(chip);
const chipMats = [];
const track = (m, o = m.opacity) => { m.transparent = true; m.userData.base = o; chipMats.push(m); return m; };
const substrate = new THREE.Mesh(new RoundedBoxGeometry(13, 13, 1.2, 4, 0.28),
  track(new THREE.MeshPhysicalMaterial({ color: 0x0c1530, metalness: 0.7, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.18, envMapIntensity: 0.9 })));
substrate.position.z = 0.6; chip.add(substrate);
const dieMat = mat(
  `varying vec2 vUv; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position,1.0); vDepth = -mv.z; gl_Position = projectionMatrix * mv; }`,
  `uniform float uGlow; uniform float uFade; varying vec2 vUv;
   float gl(vec2 p, float w){ vec2 g = abs(fract(p - 0.5) - 0.5) / fwidth(p); return 1.0 - min(min(g.x, g.y) / w, 1.0); }
   void main(){
     vec2 g4 = vUv * 4.0; vec2 cell = floor(g4); vec2 f = fract(g4);
     float core = step(0.07, f.x) * step(f.x, 0.93) * step(0.07, f.y) * step(f.y, 0.93);
     vec2 g2 = vUv * 48.0;
     float fine = gl(g2, 1.0);
     float h = hash21(floor(g2) + cell * 17.0);
     float act = step(0.84, h) * (0.5 + 0.5 * sin(uTime * (0.8 + h * 2.5) + h * 40.0));
     float bus = (1.0 - core) * (0.6 + 0.4 * sin(uTime * 2.0 - length(vUv - 0.5) * 30.0));
     vec3 col = vec3(0.015, 0.03, 0.07)
       + vec3(0.06, 0.2, 0.5) * fine * core * 0.55
       + vec3(0.2, 0.6, 1.0) * act * core * 0.75
       + vec3(0.25, 0.45, 1.0) * bus * 0.35;
     float rim = 1.0 - smoothstep(0.0, 0.02, min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y)));
     col += vec3(0.35, 0.7, 1.0) * rim * 0.8;
     col *= uGlow;
     gl_FragColor = vec4(col * fogVis(), uFade);
   }`,
  { uGlow: { value: 1 }, uFade: { value: 1 } },
  { blending: THREE.NormalBlending, depthWrite: true });
const die = new THREE.Mesh(new THREE.PlaneGeometry(7, 7), dieMat);
die.position.z = 1.24; chip.add(die);
const lid = new THREE.Mesh(new RoundedBoxGeometry(8.6, 8.6, 0.55, 4, 0.22),
  track(new THREE.MeshPhysicalMaterial({ color: 0xa6c6ff, metalness: 0, roughness: 0.04, opacity: 0.16, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 2.2, depthWrite: false })));
lid.position.z = 1.55; chip.add(lid);
{ // SMD capacitors on the substrate
  const capMat = track(new THREE.MeshStandardMaterial({ color: 0xa8bad6, metalness: 1, roughness: 0.28, envMapIntensity: 1.2 }), 1);
  const caps = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.26, 0.2), capMat, 32);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  for (let i = 0; i < 32; i++) {
    const side = i % 4, t = (Math.floor(i / 4) - 3.5) * 1.15, r = 5.4;
    const p = [new V3(t, r, 1.3), new V3(r, t, 1.3), new V3(t, -r, 1.3), new V3(-r, t, 1.3)][side];
    e.set(0, 0, side % 2 ? Math.PI / 2 : 0); q.setFromEuler(e);
    m.compose(p, q, new V3(1, 1, 1)); caps.setMatrixAt(i, m);
  }
  chip.add(caps);
  // contact pads on the board where the buses leave the package
  const padMat = track(new THREE.MeshStandardMaterial({ color: 0x9fb4d6, metalness: 1, roughness: 0.3, emissive: 0x0b2b60, envMapIntensity: 1 }), 1);
  const pins = isMobile ? 20 : 28, pads = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, 0.75, 0.05), padMat, pins * 4);
  let n = 0;
  for (let side = 0; side < 4; side++) for (let p = 0; p < pins; p++) {
    const a = side * Math.PI / 2, off = (p - (pins - 1) / 2) * 0.38, y = 6.85;
    e.set(0, 0, a); q.setFromEuler(e);
    m.compose(new V3(off * Math.cos(a) - y * Math.sin(a), off * Math.sin(a) + y * Math.cos(a), 0.03), q, new V3(1, 1, 1));
    pads.setMatrixAt(n++, m);
  }
  chip.add(pads);
  // socket outline
  const rect = (h, z) => new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([new V3(-h, -h, z), new V3(h, -h, z), new V3(h, h, z), new V3(-h, h, z)]),
    track(new THREE.LineBasicMaterial({ color: 0x4f9dff, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false })));
  chip.add(rect(7.4, 0.02), rect(7.9, 0.02));
  chipMats.at(-1).userData.base = 0.18;
}
S1.add(makeDust(Math.round(380 * Q), [-45, 45, -30, 30, 0.4, 7], [0.05, 0.12], 0x8fd0ff, 0.9));

/* =========================================================================
   SCENE 2 — Software Architecture
   ========================================================================= */
const S2 = stage(0, -165);
function makeGrid({ y, z0, z1, width = 240, cell = 4, color = 0x2d6bff, strength = 0.5 }) {
  const geo = new THREE.PlaneGeometry(width, z0 - z1); geo.rotateX(-Math.PI / 2);
  const m = mat(VS_BASIC,
    `uniform float uCell, uStrength, uZ0, uZ1, uFade; uniform vec3 uColor; varying vec3 vW;
     float gl(vec2 p, float w){ vec2 g = abs(fract(p - 0.5) - 0.5) / fwidth(p); return 1.0 - min(min(g.x, g.y) / w, 1.0); }
     void main(){
       vec2 p = vW.xz / uCell;
       float minor = gl(p, 1.0), major = gl(p / 5.0, 1.3);
       float ends = smoothstep(uZ0, uZ0 - 30.0, vW.z) * smoothstep(uZ1, uZ1 + 30.0, vW.z);
       float side = 1.0 - smoothstep(30.0, 110.0, abs(vW.x));
       float wave = exp(-pow(mod(vW.z + uTime * 7.0, 90.0) - 45.0, 2.0) / 50.0);
       float a = (minor * 0.3 + major * 0.75) * (0.55 + 0.9 * wave) * ends * side;
       gl_FragColor = vec4(uColor * a * uStrength * uFade * fogVis(), 1.0);
     }`,
    { uCell: { value: cell }, uStrength: { value: strength }, uZ0: { value: z0 }, uZ1: { value: z1 }, uColor: { value: new THREE.Color(color) }, uFade: { value: 1 } },
    { side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, m);
  mesh.position.set(0, y, (z0 + z1) / 2);
  return mesh;
}
S2.add(makeGrid({ y: -13, z0: -8, z1: -160 }));
S2.add(makeGrid({ y: 16, z0: -20, z1: -150, strength: 0.22, cell: 6, color: 0x5b4dff }));

// floating glass "code" panels — abstract token rows, no readable text
const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x8fb4ff, metalness: 0.1, roughness: 0.08, transparent: true, opacity: 0.085,
  clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.5, side: THREE.DoubleSide, depthWrite: false });
const edgeMat = new THREE.LineBasicMaterial({ color: 0x5aa8ff, transparent: true, opacity: 0.38, blending: THREE.AdditiveBlending, depthWrite: false });
const tokenMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false });
const palette = [0x4f9dff, 0x4f9dff, 0x62e3ff, 0x9a7dff, 0x6f7fa8, 0x6f7fa8, 0xc7d6ff].map(c => new THREE.Color(c));
const panels = [];
{
  const N = Math.round(26 * (isMobile ? 0.7 : 1));
  const plane = new THREE.PlaneGeometry(1, 1);
  const m = new THREE.Matrix4();
  for (let i = 0; i < N; i++) {
    const side = i % 2 ? 1 : -1;
    const z = -18 - i * (125 / N) - R(0, 4);
    const c = pathAt(z);
    const w = R(6, 11), h = R(4, 8.5);
    const g = new THREE.Group();
    g.position.set(c.x + side * R(8, 24), c.y + R(-8, 9), z);
    g.rotation.set(R(-0.12, 0.12), -side * R(0.3, 0.65), R(-0.04, 0.04));
    g.add(new THREE.Mesh(new RoundedBoxGeometry(w, h, 0.08, 2, 0.04), glassMat));
    g.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(w, h)), edgeMat));
    // tokens
    const mats = [], cols = [];
    const header = new THREE.Matrix4().compose(new V3(0, h / 2 - 0.42, 0.06), new THREE.Quaternion(), new V3(w - 0.4, 0.015, 1));
    mats.push(header); cols.push(palette[4]);
    for (let d = 0; d < 3; d++) { mats.push(new THREE.Matrix4().compose(new V3(-w / 2 + 0.38 + d * 0.3, h / 2 - 0.22, 0.06), new THREE.Quaternion(), new V3(0.12, 0.12, 1))); cols.push(palette[4]); }
    let indent = 0;
    const rows = Math.floor((h - 1.0) / 0.4);
    for (let r = 0; r < rows; r++) {
      if (rand() < 0.12) continue;
      indent = clamp(indent + (rand() < 0.3 ? 1 : rand() < 0.35 ? -1 : 0), 0, 4);
      let x = -w / 2 + 0.45 + indent * 0.42;
      const y = h / 2 - 0.85 - r * 0.4;
      const tokens = 1 + Math.floor(rand() * 4);
      for (let t = 0; t < tokens; t++) {
        const tw = R(0.35, 2.1);
        if (x + tw > w / 2 - 0.45) break;
        mats.push(new THREE.Matrix4().compose(new V3(x + tw / 2, y, 0.06), new THREE.Quaternion(), new V3(tw, 0.12, 1)));
        cols.push(palette[Math.floor(rand() * palette.length)]);
        x += tw + R(0.16, 0.34);
      }
    }
    const inst = new THREE.InstancedMesh(plane, tokenMat, mats.length);
    mats.forEach((mm, k) => { inst.setMatrixAt(k, mm); inst.setColorAt(k, cols[k]); });
    g.add(inst);
    g.userData = { y0: g.position.y, ry: g.rotation.y, ph: R(0, 6.28) };
    S2.add(g); panels.push(g);
  }
}
// data streams — rails with flowing packets
{
  const lanes = Math.round(48 * Q), z0 = -5, L = 150;
  const rails = [], pos = [], z0a = [], spd = [], end = [], ln = [];
  for (let i = 0; i < lanes; i++) {
    const a = R(0, Math.PI * 2), r = R(7, 26);
    const x = Math.cos(a) * r, y = Math.sin(a) * r * 0.65;
    rails.push(new V3(x, y, z0), new V3(x, y, z0 - L));
    for (let k = 0; k < 3; k++) {
      const s0 = R(0, L), sp = R(6, 20), l = R(1.5, 4.5);
      for (const e of [0, 1]) { pos.push(x, y, 0); z0a.push(s0); spd.push(sp); end.push(e); ln.push(l); }
    }
  }
  S2.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(rails),
    new THREE.LineBasicMaterial({ color: 0x1d4fa8, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false })));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aZ0', new THREE.Float32BufferAttribute(z0a, 1));
  g.setAttribute('aSpeed', new THREE.Float32BufferAttribute(spd, 1));
  g.setAttribute('aEnd', new THREE.Float32BufferAttribute(end, 1));
  g.setAttribute('aLen', new THREE.Float32BufferAttribute(ln, 1));
  const packets = new THREE.LineSegments(g, mat(
    `attribute float aZ0, aSpeed, aEnd, aLen; uniform float uZ0, uL; varying float vA;
     void main(){
       float z = uZ0 - uL + mod(aZ0 + uTime * aSpeed, uL);
       vec3 p = vec3(position.xy, z + aEnd * aLen);
       vA = aEnd * smoothstep(uZ0 - uL, uZ0 - uL + 12.0, z) * (1.0 - smoothstep(uZ0 - 14.0, uZ0, z));
       vec4 mv = modelViewMatrix * vec4(p, 1.0); vDepth = -mv.z; gl_Position = projectionMatrix * mv;
     }`,
    `varying float vA; void main(){ gl_FragColor = vec4(vec3(0.4, 0.8, 1.0) * vA * 1.3 * fogVis(), 1.0); }`,
    { uZ0: { value: z0 }, uL: { value: L } }));
  packets.frustumCulled = false;
  S2.add(packets);
}
// distant geometric lattices
const wires = [];
{
  const wm = new THREE.LineBasicMaterial({ color: 0x7d6bff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false });
  const wm2 = new THREE.LineBasicMaterial({ color: 0x3f8cff, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false });
  [[new THREE.IcosahedronGeometry(7, 1), new V3(-30, 9, -52)], [new THREE.OctahedronGeometry(6, 0), new V3(32, -5, -98)],
   [new THREE.DodecahedronGeometry(5.5, 0), new V3(-26, -7, -138)]].forEach(([geo, p], i) => {
    const o = new THREE.Group(); o.position.copy(p);
    const outer = new THREE.LineSegments(new THREE.EdgesGeometry(geo), i % 2 ? wm2 : wm);
    const inner = new THREE.LineSegments(new THREE.EdgesGeometry(geo), i % 2 ? wm : wm2); inner.scale.setScalar(0.55);
    o.add(outer, inner); S2.add(o); wires.push(o);
  });
}

/* =========================================================================
   SCENE 3 — Networks & Intelligence
   ========================================================================= */
const S3 = stage(-145, -270);
{
  const layers = 6, per = Math.round(36 * Q), nodes = [];
  for (let l = 0; l < layers; l++) {
    const z = -165 - l * 18, c = pathAt(z);
    for (let i = 0; i < per; i++) {
      const r = 4.8 + 16.5 * Math.sqrt((i + 0.5) / per), th = i * 2.39996 + l * 0.7;
      nodes.push({ p: new V3(c.x + Math.cos(th) * r, c.y + Math.sin(th) * r * 0.72, z + R(-1.6, 1.6)), l, rnd: rand() });
    }
    // framing ring
    const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([...Array(128)].map((_, k) =>
      new V3(c.x + Math.cos(k / 128 * Math.PI * 2) * 23.5, c.y + Math.sin(k / 128 * Math.PI * 2) * 23.5 * 0.72, z))),
      new THREE.LineBasicMaterial({ color: 0x3b6fd8, transparent: true, opacity: 0.13, blending: THREE.AdditiveBlending, depthWrite: false }));
    S3.add(ring);
  }
  // node spheres
  const geo = new THREE.IcosahedronGeometry(0.3, 2);
  const lay = new Float32Array(nodes.length), rn = new Float32Array(nodes.length);
  nodes.forEach((n, i) => { lay[i] = n.l; rn[i] = n.rnd; });
  geo.setAttribute('aLayer', new THREE.InstancedBufferAttribute(lay, 1));
  geo.setAttribute('aRnd', new THREE.InstancedBufferAttribute(rn, 1));
  const ACT = `
    float act(float layer, float rnd){
      float w = uTime * 1.6 - layer * 1.1;
      float cyc = floor((w + 1.5708) / 6.2832);
      float gate = step(0.42, hash11(cyc * 1.37 + rnd * 91.3));
      return pow(0.5 + 0.5 * sin(w), 8.0) * mix(0.22, 1.0, gate);
    }`;
  const nodeMesh = new THREE.InstancedMesh(geo, mat(
    `attribute float aLayer; attribute float aRnd; varying float vAct; varying vec3 vN; varying vec3 vV; ${ACT}
     void main(){
       vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
       vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
       vV = normalize(cameraPosition - w.xyz);
       vAct = act(aLayer, aRnd);
       vec4 mv = viewMatrix * w; vDepth = -mv.z; gl_Position = projectionMatrix * mv;
     }`,
    `varying float vAct; varying vec3 vN; varying vec3 vV;
     void main(){
       float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
       vec3 col = mix(vec3(0.06, 0.18, 0.5), vec3(0.55, 0.9, 1.0), vAct) * (0.45 + 1.6 * vAct) + vec3(0.2, 0.4, 1.0) * fres * 0.6;
       gl_FragColor = vec4(mix(uFogColor, col, fogVis()), 1.0);
     }`, {}, { blending: THREE.NormalBlending, transparent: false, depthWrite: true }), nodes.length);
  const m = new THREE.Matrix4();
  nodes.forEach((n, i) => { m.makeTranslation(n.p.x, n.p.y, n.p.z); nodeMesh.setMatrixAt(i, m); });
  S3.add(nodeMesh);
  // halos
  const hp = new Float32Array(nodes.length * 3);
  nodes.forEach((n, i) => n.p.toArray(hp, i * 3));
  const hg = new THREE.BufferGeometry();
  hg.setAttribute('position', new THREE.BufferAttribute(hp, 3));
  hg.setAttribute('aLayer', new THREE.BufferAttribute(lay, 1));
  hg.setAttribute('aRnd', new THREE.BufferAttribute(rn, 1));
  const halos = new THREE.Points(hg, mat(
    `attribute float aLayer; attribute float aRnd; varying float vAct; ${ACT}
     void main(){ vAct = act(aLayer, aRnd); vec4 mv = modelViewMatrix * vec4(position, 1.0); vDepth = -mv.z;
       gl_PointSize = clamp((0.9 + 2.2 * vAct) * uScale / max(vDepth, 1.0), 1.0, 70.0); vAct *= smoothstep(6.0, 16.0, vDepth); gl_Position = projectionMatrix * mv; }`,
    `varying float vAct; void main(){ float d = length(gl_PointCoord - 0.5); float a = exp(-d * d * 22.0);
       gl_FragColor = vec4(vec3(0.3, 0.7, 1.0) * a * (0.08 + 0.75 * vAct) * fogVis(), 1.0); }`));
  halos.frustumCulled = false;
  S3.add(halos);
  // synapses: pulses travel layer-to-layer in sync with node activation
  const pos = [], at = [], al = [], ar = [];
  for (const n of nodes) {
    if (n.l === layers - 1) continue;
    const next = nodes.filter(o => o.l === n.l + 1).map(o => [o, o.p.distanceToSquared(n.p)]).sort((a, b) => a[1] - b[1]).slice(0, 6);
    const k = isMobile ? 2 : 3;
    for (let j = 0; j < k; j++) {
      const o = next.splice(Math.floor(rand() * next.length), 1)[0][0];
      pos.push(n.p.x, n.p.y, n.p.z, o.p.x, o.p.y, o.p.z); at.push(0, 1); al.push(n.l, n.l); const r = rand(); ar.push(r, r);
    }
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  sg.setAttribute('aT', new THREE.Float32BufferAttribute(at, 1));
  sg.setAttribute('aLayer', new THREE.Float32BufferAttribute(al, 1));
  sg.setAttribute('aRnd', new THREE.Float32BufferAttribute(ar, 1));
  S3.add(new THREE.LineSegments(sg, mat(
    `attribute float aT; attribute float aLayer; attribute float aRnd; varying float vT; varying float vW0; varying float vGate;
     void main(){ vT = aT; vW0 = uTime * 1.6 - aLayer * 1.1;
       vGate = step(0.6, hash11(floor((vW0 + 1.5708) / 6.2832) * 3.71 + aRnd * 57.1));
       vec4 mv = modelViewMatrix * vec4(position, 1.0); vDepth = -mv.z; gl_Position = projectionMatrix * mv; }`,
    `varying float vT; varying float vW0; varying float vGate;
     void main(){ float pulse = pow(0.5 + 0.5 * sin(vW0 - vT * 1.1), 80.0) * vGate;
       vec3 c = vec3(0.12, 0.3, 0.8) * 0.09 + vec3(0.5, 0.88, 1.0) * pulse * 1.5;
       gl_FragColor = vec4(c * fogVis(), 1.0); }`)));
}

/* =========================================================================
   SCENE 4 — Digital Ecosystem
   ========================================================================= */
const S4 = stage(-265, -415);
const ecoFade = [];
const towers = [];
for (let z = -282; z > -402; z -= 6.5) for (const side of [-1, 1]) for (let c = 0; c < 9; c++) {
  if (rand() < 0.36) continue;
  const w = R(2.2, 3.4), d = R(2.2, 3.4);
  const h = R(3, 9) + c * R(1, 2.6) + (rand() < 0.08 ? 12 : 0);
  towers.push({ x: side * (9 + c * 5.5 + R(-0.8, 0.8)), z: z + R(-1, 1), w, d, h });
}
const FLOOR = -14;
{
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const seeds = new Float32Array(towers.length).map(() => rand());
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  const tm = mat(
    `attribute float aSeed; varying vec3 vW; varying vec3 vN; varying vec3 vLS; varying vec3 vScale; varying vec3 vLN; varying float vSeed;
     void main(){
       vScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
       vLS = position * vScale; vLN = normal; vSeed = aSeed;
       vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0); vW = w.xyz;
       vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
       vec4 mv = viewMatrix * w; vDepth = -mv.z; gl_Position = projectionMatrix * mv;
     }`,
    `uniform float uFade; varying vec3 vW; varying vec3 vN; varying vec3 vLS; varying vec3 vScale; varying vec3 vLN; varying float vSeed;
     void main(){
       vec3 n = normalize(vN), V = normalize(cameraPosition - vW);
       float fres = pow(1.0 - abs(dot(n, V)), 3.0);
       vec3 an = abs(vLN), d = vScale * 0.5 - abs(vLS);
       float ed = an.x > 0.5 ? min(d.y, d.z) : (an.y > 0.5 ? min(d.x, d.z) : min(d.x, d.y));
       float edge = 1.0 - smoothstep(0.0, 0.07, ed);
       float isSide = 1.0 - an.y;
       float far = 1.0 - smoothstep(70.0, 150.0, vDepth);
       float ry = fract(vW.y / 0.6);
       float slot = smoothstep(0.42, 0.47, ry) * (1.0 - smoothstep(0.53, 0.58, ry)) * far;
       float hc = an.x > 0.5 ? vW.z : vW.x;
       float h = hash21(vec2(floor(hc / 0.32), floor(vW.y / 0.6)) + vSeed * 57.0);
       float fc = fract(hc / 0.32);
       float led = step(0.35, fc) * step(fc, 0.75) * slot;
       float blink = step(0.88, h) * (0.55 + 0.45 * sin(uTime * (0.8 + h * 3.0) + h * 60.0));
       vec3 ledCol = mix(vec3(0.25, 0.65, 1.0), vec3(0.6, 0.45, 1.0), step(0.965, h));
       vec3 col = vec3(0.010, 0.015, 0.032);
       col += vec3(0.04, 0.09, 0.2) * slot * isSide * 0.6;
       col += ledCol * led * blink * isSide * 1.5;
       col += vec3(0.18, 0.45, 1.0) * edge * 0.55;
       col += vec3(0.10, 0.25, 0.6) * fres * 0.35;
       col *= mix(0.35, 1.0, smoothstep(-14.0, 6.0, vW.y));
       gl_FragColor = vec4(mix(uFogColor, col, fogVis()), uFade);
     }`,
    { uFade: { value: 1 } }, { blending: THREE.NormalBlending, depthWrite: true });
  ecoFade.push(tm.uniforms.uFade);
  const inst = new THREE.InstancedMesh(geo, tm, towers.length);
  const m = new THREE.Matrix4();
  towers.forEach((t, i) => { m.compose(new V3(t.x, FLOOR + t.h / 2, t.z), new THREE.Quaternion(), new V3(t.w, t.h, t.d)); inst.setMatrixAt(i, m); });
  S4.add(inst);
}
const grid4 = makeGrid({ y: FLOOR, z0: -268, z1: -412, strength: 0.42 });
ecoFade.push(grid4.material.uniforms.uFade); S4.add(grid4);

// the integration core
const coreZ = -372, coreP = pathAt(coreZ).setY(-4);
const core = new THREE.Group(); core.position.copy(coreP); S4.add(core);
const coreGlowMat = mat(
  `varying vec3 vN; varying vec3 vV; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - w.xyz);
     vec4 mv = viewMatrix * w; vDepth = -mv.z; gl_Position = projectionMatrix * mv; }`,
  `uniform float uFade; varying vec3 vN; varying vec3 vV;
   void main(){ float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
     vec3 c = mix(vec3(0.05, 0.15, 0.5), vec3(0.45, 0.85, 1.0), pow(f, 2.0)) * (0.6 + 0.25 * sin(uTime * 1.3));
     c += vec3(0.25, 0.5, 1.0) * pow(1.0 - f, 6.0) * 0.6;
     gl_FragColor = vec4(c * uFade * fogVis(), 1.0); }`, { uFade: { value: 1 } });
ecoFade.push(coreGlowMat.uniforms.uFade);
core.add(new THREE.Mesh(new THREE.SphereGeometry(2.1, 48, 32), coreGlowMat));
const coreShellMat = new THREE.MeshPhysicalMaterial({ color: 0x9fc0ff, metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.14, clearcoat: 1, envMapIntensity: 2, flatShading: true, depthWrite: false });
const coreShell = new THREE.Mesh(new THREE.IcosahedronGeometry(3.4, 1), coreShellMat); core.add(coreShell);
const coreWireMat = new THREE.LineBasicMaterial({ color: 0x8f7bff, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false });
const coreWire = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(3.42, 1)), coreWireMat); core.add(coreWire);
// four orbits: frontend · backend · data · AI
const rings = [0x4da3ff, 0x36e0ff, 0xc9d6ff, 0x8b6cff].map((c, i) => {
  const m = new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false });
  const r = new THREE.Mesh(new THREE.TorusGeometry(5 + i * 1.15, 0.03, 8, 220), m);
  r.rotation.set(Math.PI / 2 + R(-0.6, 0.6), R(-0.6, 0.6), 0); r.userData.spin = (i % 2 ? -1 : 1) * R(0.08, 0.18);
  core.add(r); return r;
});
const beamMat = mat(
  `varying float vY; void main(){ vY = uv.y; vec4 mv = modelViewMatrix * vec4(position,1.0); vDepth = -mv.z; gl_Position = projectionMatrix * mv; }`,
  `uniform float uFade; varying float vY; void main(){ float a = pow(1.0 - vY, 3.0) * 0.07; gl_FragColor = vec4(vec3(0.3, 0.6, 1.0) * a * uFade * fogVis(), 1.0); }`,
  { uFade: { value: 1 } }, { side: THREE.DoubleSide });
ecoFade.push(beamMat.uniforms.uFade);
const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.15, 70, 24, 1, true), beamMat);
beam.position.y = 35; core.add(beam);
// API arcs from the core to the surrounding systems + light networks on the ground
{
  const arcs = [];
  const cands = towers.filter(t => Math.abs(t.x) < 34).sort(() => rand() - 0.5).slice(0, Math.round(28 * Q));
  for (const t of cands) {
    const a = coreP.clone(), b = new V3(t.x, FLOOR + t.h, t.z);
    const ctrl = a.clone().lerp(b, 0.5); ctrl.y += 8 + a.distanceTo(b) * 0.28;
    const curve = new THREE.QuadraticBezierCurve3(a, ctrl, b);
    arcs.push({ pts: curve.getPoints(48), seed: rand(), reverse: rand() < 0.5 });
  }
  const am = flowMaterial(0x4f9dff, { speed: 0.22, base: 0.07, gain: 1.7 });
  ecoFade.push(am.uniforms.uFade);
  S4.add(new THREE.LineSegments(polylineToSegments(arcs), am));
  const lanes = [];
  for (const x of [-5.6, -6.4, 5.6, 6.4]) lanes.push({ pts: [new V3(x, FLOOR + 0.05, -276), new V3(x, FLOOR + 0.05, -404)], seed: rand() });
  for (let z = -286; z > -400; z -= 13) {
    lanes.push({ pts: [new V3(-58, FLOOR + 0.05, z), new V3(-6.4, FLOOR + 0.05, z)], seed: rand(), reverse: true });
    lanes.push({ pts: [new V3(6.4, FLOOR + 0.05, z), new V3(58, FLOOR + 0.05, z)], seed: rand() });
  }
  const lm = flowMaterial(0x36e0ff, { speed: 0.12, reps: 2, base: 0.1, gain: 1.4 });
  ecoFade.push(lm.uniforms.uFade);
  S4.add(new THREE.LineSegments(polylineToSegments(lanes), lm));
}

/* =========================================================================
   SCENE 5 — Infinite Digital Space
   ========================================================================= */
const S5 = stage(-260, -900);
// architecture dissolving into fine particles (driven by scroll, so it reverses)
const dissolveMat = mat(
  `attribute vec3 aDir; attribute float aRnd; uniform float uD; varying float vA;
   void main(){
     float e = uD * uD;
     vec3 p = position + aDir * e * (5.0 + aRnd * 14.0);
     p.z -= e * (40.0 + aRnd * 130.0);
     p.y += e * aRnd * 9.0;
     p.x += sin(uTime * 0.3 + aRnd * 20.0) * uD * 2.0;
     vA = smoothstep(0.0, 0.12, uD) * (1.0 - 0.65 * smoothstep(0.55, 1.0, uD)) * (0.5 + 0.5 * sin(uTime * (0.6 + aRnd) + aRnd * 50.0));
     vec4 mv = modelViewMatrix * vec4(p, 1.0); vDepth = -mv.z;
     float s = (0.05 + aRnd * 0.07) * uScale / max(vDepth, 0.5);
     vA *= clamp(s / 1.5, 0.0, 1.0);
     gl_PointSize = clamp(s, 1.0, 6.0 * uPR); gl_Position = projectionMatrix * mv;
   }`,
  `varying float vA; void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d);
     gl_FragColor = vec4(vec3(0.35, 0.72, 1.0) * a * vA * 1.4 * fogVis(), 1.0); }`,
  { uD: { value: 0 } });
{
  const N = Math.round(4200 * Q), p = new Float32Array(N * 3), dir = new Float32Array(N * 3), rn = new Float32Array(N);
  const v = new V3();
  for (let i = 0; i < N; i++) {
    const t = towers[Math.floor(rand() * towers.length)];
    const k = Math.floor(rand() * 3), lp = [R(-0.5, 0.5), R(-0.5, 0.5), R(-0.5, 0.5)]; lp[k] = rand() < 0.5 ? -0.5 : 0.5;
    p.set([t.x + lp[0] * t.w, FLOOR + t.h / 2 + lp[1] * t.h, t.z + lp[2] * t.d], i * 3);
    v.randomDirection(); dir.set([v.x, v.y, v.z], i * 3); rn[i] = rand();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
  g.setAttribute('aRnd', new THREE.BufferAttribute(rn, 1));
  const pts = new THREE.Points(g, dissolveMat); pts.frustumCulled = false; S5.add(pts);
}
// glowing technological horizon
const HY = -25, HZ = -780;
const horizonMat = mat(VS_BASIC,
  `uniform float uH; uniform float uHY; varying vec3 vW;
   void main(){
     float y = vW.y - uHY;
     float sideFade = 1.0 - smoothstep(250.0, 900.0, abs(vW.x));
     vec3 c = vec3(0.06, 0.22, 0.75) * exp(-abs(y) * 0.06) * 0.4
            + vec3(0.45, 0.82, 1.0) * exp(-y * y * 0.9) * 0.8
            + vec3(0.32, 0.18, 0.85) * exp(-max(y, 0.0) * 0.012) * step(0.0, y) * 0.12;
     c *= 0.85 + 0.15 * sin(uTime * 0.4 + vW.x * 0.004);
     gl_FragColor = vec4(c * sideFade * uH, 1.0);
   }`, { uH: { value: 0 }, uHY: { value: HY } });
const horizon = new THREE.Mesh(new THREE.PlaneGeometry(2200, 700), horizonMat);
horizon.position.set(0, HY, HZ); S5.add(horizon);
// delicate floor of moving lines receding to the horizon
const floor5Mat = mat(VS_BASIC,
  `uniform float uH; varying vec3 vW;
   float gl(float p, float w){ float g = abs(fract(p - 0.5) - 0.5) / fwidth(p); return 1.0 - min(g / w, 1.0); }
   void main(){
     float zl = gl((vW.z + uTime * 4.0) / 9.0, 1.0);
     float xl = gl(vW.x / 14.0, 1.0);
     float dist = length(vW - cameraPosition);
     float fade = smoothstep(8.0, 60.0, dist) * (1.0 - smoothstep(180.0, 360.0, dist));
     float side = 1.0 - smoothstep(80.0, 260.0, abs(vW.x));
     vec3 c = vec3(0.15, 0.42, 1.0) * (zl * 0.14 + xl * 0.06) * fade * side;
     c += vec3(0.1, 0.3, 0.9) * 0.04 * (1.0 - smoothstep(0.0, 300.0, abs(vW.z - ${HZ.toFixed(1)}))) * side;
     gl_FragColor = vec4(c * uH, 1.0);
   }`, { uH: { value: 0 } }, { side: THREE.DoubleSide });
const floor5 = new THREE.Mesh(new THREE.PlaneGeometry(900, 380).rotateX(-Math.PI / 2), floor5Mat);
floor5.position.set(0, HY, (HZ - 400) / 2); S5.add(floor5);
// slow waveforms floating above the horizon
const waveMat = mat(
  `attribute float aI; uniform float uHY; varying float vA;
   void main(){
     vec3 p = position;
     p.y = uHY + 9.0 + aI * 5.0 + sin(p.x * 0.012 + uTime * 0.22 + aI * 1.7) * 4.0 + sin(p.x * 0.031 - uTime * 0.15 + aI) * 1.6;
     vA = (1.0 - smoothstep(120.0, 420.0, abs(p.x))) * (0.55 - aI * 0.07);
     vec4 mv = modelViewMatrix * vec4(p, 1.0); vDepth = -mv.z; gl_Position = projectionMatrix * mv;
   }`,
  `uniform float uH; varying float vA; void main(){ gl_FragColor = vec4(vec3(0.3, 0.6, 1.0) * vA * 0.5 * uH, 1.0); }`,
  { uH: { value: 0 }, uHY: { value: HY } });
for (let i = 0; i < 6; i++) {
  const n = 320, p = new Float32Array(n * 3), ai = new Float32Array(n).fill(i);
  for (let k = 0; k < n; k++) p.set([-520 + k * (1040 / (n - 1)), 0, HZ + 120 + i * 6], k * 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('aI', new THREE.BufferAttribute(ai, 1));
  const line = new THREE.Line(g, waveMat); line.frustumCulled = false; S5.add(line);
}
S5.add(makeDust(Math.round(900 * Q), [-120, 120, -30, 50, -420, -700], [0.12, 0.3], 0x7fb6ff, 0.6));

// global atmosphere — sparse luminous dust along the whole journey
const dust = makeDust(Math.round(2200 * Q), [-55, 55, -32, 32, 90, -560], [0.04, 0.11], 0xa9d4ff, 0.75);
scene.add(dust);

/* =========================================================================
   Post-processing
   ========================================================================= */
const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: isMobile ? 0 : 4 });
const composer = new EffectComposer(renderer, rt);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(2, 2), isMobile ? 0.7 : 0.85, 0.55, 0.14);
composer.addPass(bloom);
composer.addPass(new OutputPass());
// Light theme: the same scene printed as graphite ink on the page's paper tone.
// Light emitted in the dark render becomes ink density, so both themes share one journey.
const themePass = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uLight: { value: 0 }, uPaper: { value: new THREE.Vector3(0.949, 0.941, 0.922) } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uLight; uniform vec3 uPaper; varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      if (uLight <= 0.001) { gl_FragColor = vec4(c, 1.0); return; }
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float a = clamp(1.0 - exp(-max(l - 0.03, 0.0) * 2.6), 0.0, 0.92);
      vec3 ink = vec3(0.071, 0.075, 0.086) * mix(1.6, 1.0, a);   // graphite, close to the page text (#121316)
      vec3 light = mix(uPaper, ink, a);
      gl_FragColor = vec4(mix(c, light, uLight), 1.0);
    }`,
});
composer.addPass(themePass);

/* =========================================================================
   Scroll → camera mapping
   ========================================================================= */
// Each page section anchors a moment of the journey: [selector, point inside the section, camera z].
// 'start' / 'end' pin the very top and bottom of the page.
const KEYFRAMES = [
  ['#topo', 'start', 68],          // Genesis: the processor on its circuit board
  ['#sobre', 0.5, -28],            // through the die, into the architecture
  ['#experiencia', 0.5, -100],     // floating code structures and data streams
  ['#ferramentas', 0.0, -140],
  ['#ferramentas', 0.5, -215],     // neural network
  ['#ferramentas', 1.0, -295],     // entering the ecosystem
  ['#stack', 0.5, -345],           // integration core and server architecture
  ['#formacao', 0.5, -425],        // the architecture dissolves into particles
  ['#contato', 'end', -525],       // infinite space and horizon
];
let keys = [];
function computeKeys() {
  const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
  let prev = -1;
  keys = KEYFRAMES.map(([sel, at, z]) => {
    let p = at === 'start' ? 0 : at === 'end' ? 1 : 0;
    const el = document.querySelector(sel);
    if (el && typeof at === 'number') {
      const top = el.getBoundingClientRect().top + scrollY;
      p = clamp((top + el.offsetHeight * at - innerHeight / 2) / max, 0, 1);
    }
    p = Math.max(p, prev + 1e-4); prev = p;
    return { p, z };
  });
}
new ResizeObserver(() => computeKeys()).observe(document.body);
function scrollToZ(p) {
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (p <= b.p) return a.z + (b.z - a.z) * clamp((p - a.p) / Math.max(1e-5, b.p - a.p), 0, 1);
  }
  return keys[keys.length - 1].z;
}
let scrollTarget = 0, scrollSmooth = 0;
const readScroll = () => { const max = document.documentElement.scrollHeight - innerHeight; scrollTarget = max > 0 ? clamp(scrollY / max, 0, 1) : 0; };
addEventListener('scroll', readScroll, { passive: true });

const mouse = new THREE.Vector2(), mouseS = new THREE.Vector2();
if (!isMobile) addEventListener('pointermove', e => mouse.set(e.clientX / innerWidth * 2 - 1, e.clientY / innerHeight * 2 - 1), { passive: true });

let lastW = 0, lastH = 0;
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w === lastW && Math.abs(h - lastH) < 2) { computeKeys(); return; }
  lastW = w; lastH = h;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.fov = w / h < 0.8 ? 64 : 50;
  if (w > 900) camera.setViewOffset(w, h, -w * 0.13, 0, w, h); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
  U.uScale.value = h * renderer.getPixelRatio() / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  computeKeys(); readScroll();
}
addEventListener('resize', resize);
addEventListener('load', () => { lastW = 0; resize(); });
resize();
scrollSmooth = scrollTarget;

/* =========================================================================
   Frame loop
   ========================================================================= */
const camPos = new V3(), tan = new V3(), look = new V3(), tmp = new V3();
const clock = new THREE.Clock();
let time = 0;
// theme follows the page's data-theme attribute and crossfades like the rest of the page
const isLight = () => document.documentElement.dataset.theme !== 'dark';
let lightTarget = isLight() ? 1 : 0;
themePass.uniforms.uLight.value = lightTarget;
new MutationObserver(() => { lightTarget = isLight() ? 1 : 0; }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
// adaptive resolution keeps scrolling fluid on slower GPUs
const maxPR = renderer.getPixelRatio();
let frameAvg = 16, frames = 0;
function adaptQuality(dt) {
  frameAvg += (dt * 1000 - frameAvg) * 0.05;
  if (++frames < 90) return;
  const pr = renderer.getPixelRatio();
  let next = pr;
  if (frameAvg > 24 && pr > 0.75) next = Math.max(0.75, pr - 0.25);
  else if (frameAvg < 15 && pr < maxPR) next = Math.min(maxPR, pr + 0.25);
  if (next !== pr) {
    renderer.setPixelRatio(next); composer.setPixelRatio(next); U.uPR.value = next;
    lastW = 0; resize(); frames = 0;
  }
}
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  adaptQuality(dt);
  themePass.uniforms.uLight.value += (lightTarget - themePass.uniforms.uLight.value) * (1 - Math.exp(-dt * 6));
  time += dt * (reduceMotion ? 0.3 : 1);
  U.uTime.value = time;

  scrollSmooth += (scrollTarget - scrollSmooth) * (1 - Math.exp(-dt * (reduceMotion ? 14 : 3.2)));
  const intro = reduceMotion ? 1 : smooth(0, 1, time / 4.5);
  const zTarget = scrollToZ(scrollSmooth) + (1 - intro) * 16;
  const u = uAtZ(zTarget);
  path.getPoint(u, camPos);
  path.getTangent(u, tan);
  look.copy(camPos).addScaledVector(tan, 24);

  mouseS.lerp(mouse, 1 - Math.exp(-dt * 2.2));
  const drift = reduceMotion ? 0 : 1;
  camPos.x += mouseS.x * 0.9 + Math.sin(time * 0.21) * 0.25 * drift;
  camPos.y += -mouseS.y * 0.55 + Math.cos(time * 0.17) * 0.18 * drift;
  look.x += mouseS.x * 0.4; look.y += -mouseS.y * 0.25;
  camera.position.copy(camPos);
  camera.lookAt(look);

  const cz = camPos.z;
  // scene-driven parameters (all derived from camera position → fully reversible)
  const f1 = smooth(2, 13, cz);
  const D = smooth(-355, -440, cz);
  const H = smooth(-392, -480, cz);
  const fog = THREE.MathUtils.lerp(0.0145, 0.0062, H);
  U.uFog.value = fog; scene.fog.density = fog;

  const reveal = reduceMotion ? 120 : 120 * (1 - Math.pow(1 - clamp(time / 6.5, 0, 1), 3));
  boardMat.uniforms.uReveal.value = reveal; boardMat.uniforms.uFade.value = f1;
  busMat.uniforms.uReveal.value = reveal; busMat.uniforms.uFade.value = f1;
  dieMat.uniforms.uFade.value = f1;
  dieMat.uniforms.uGlow.value = 0.75 + 1.5 * smooth(42, 8, cz);
  for (const m of chipMats) m.opacity = m.userData.base * f1;
  board.visible = f1 > 0.001; chip.visible = f1 > 0.001;
  chipLightA.intensity = 140 * f1; chipLightB.intensity = 90 * f1;

  for (const p of panels) {
    p.position.y = p.userData.y0 + Math.sin(time * 0.35 + p.userData.ph) * 0.35;
    p.rotation.y = p.userData.ry + Math.sin(time * 0.2 + p.userData.ph) * 0.04;
  }
  wires.forEach((w, i) => { w.rotation.x = time * 0.05 * (i + 1); w.rotation.y = time * 0.07; w.children[1].rotation.y = -time * 0.15; });

  for (const f of ecoFade) f.value = 1 - D;
  coreShellMat.opacity = 0.14 * (1 - D); coreWireMat.opacity = 0.4 * (1 - D);
  rings.forEach(r => { r.rotation.z += r.userData.spin * dt; r.material.opacity = 0.75 * (1 - D); });
  coreShell.rotation.y = time * 0.08; coreWire.rotation.y = time * 0.08;
  dissolveMat.uniforms.uD.value = D;
  horizonMat.uniforms.uH.value = H; floor5Mat.uniforms.uH.value = H; waveMat.uniforms.uH.value = H;

  // only draw stages near the camera
  for (const g of groups) { const { zNear, zFar } = g.userData; g.visible = cz + 6 > zFar && cz - 190 < zNear; }

  composer.render();
  if (!canvas.classList.contains('ready')) canvas.classList.add('ready');
});
