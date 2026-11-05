// Realistische Wolfsspinne – vollständig prozedural erzeugt (keine Downloads, offline-fähig).
// - Fell-Texturen (Farbe + Normal-Map) werden zur Laufzeit in Canvas gemalt
// - echte 3D-Behaarung und Borsten an Körper und Beinen
// - anatomisch: Prosoma, Opisthosoma, 8 Augen, Cheliceren mit Klauen, Pedipalpen,
//   8 Beine mit Coxa, Femur, Patella, Tibia, Metatarsus, Tarsus, Spinnwarzen
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// ---------------------------------------------------------------------------
// Fell-Texturen
// ---------------------------------------------------------------------------
/**
 * Malt eine Fell-Textur. pattern(ctx, w, h, rnd) zeichnet Zeichnungen (Flecken, Bänder),
 * danach werden tausende Haarstriche darüber gelegt. Gleichzeitig entsteht eine
 * Höhenkarte, aus der die Normal-Map berechnet wird.
 */
const spriteCache = new Map();
/** Weicher runder Farbpunkt als vorgerenderte Grafik (viel schneller als Gradienten pro Aufruf) */
function softSprite(color) {
  let c = spriteCache.get(color);
  if (!c) {
    c = makeCanvas(64, 64);
    const x = c.getContext('2d');
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, color + '55');
    g.addColorStop(1, color + '00');
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 64);
    spriteCache.set(color, c);
  }
  return c;
}

// Haarfarben [r, g, b, alpha, Anteil]
const STROKE_COLORS = [
  [24, 18, 12, 0.6, 0.24],     // dunkle Haare
  [78, 63, 46, 0.45, 0.3],     // mittelbraun
  [178, 163, 138, 0.34, 0.34], // graubeige
  [222, 210, 184, 0.4, 0.12],  // helle Spitzen
];

/**
 * Malt eine Fell-Textur:
 * 1. Grundfarbe, Marmorierung und Zeichnung (pattern) in niedriger Auflösung (weich, schnell)
 * 2. zehntausende Haarstriche direkt in den Pixelspeicher (schnell auf jedem Gerät)
 * 3. Normal-Map aus der Haar-Höhenkarte (Sobel)
 */
function furTexture({ w, h, seed, base, palette, pattern, strokes, strokeLen, normalStrength = 2.4 }) {
  const rnd = mulberry32(seed);
  const lw = w / 4, lh = h / 4;
  const low = makeCanvas(lw, lh), lctx = low.getContext('2d');
  lctx.fillStyle = base;
  lctx.fillRect(0, 0, lw, lh);
  for (let i = 0; i < 320; i++) {
    const x = rnd() * lw, y = rnd() * lh, r = (0.03 + rnd() * 0.09) * lw;
    const spr = softSprite(palette[Math.floor(rnd() * palette.length)]);
    for (const dx of [-lw, 0, lw]) lctx.drawImage(spr, x + dx - r, y - r, r * 2, r * 2);
  }
  if (pattern) pattern(lctx, lw, lh, rnd);

  const c = makeCanvas(w, h), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(low, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  const height = new Float32Array(w * h).fill(0.5);

  for (let i = 0; i < strokes; i++) {
    const x0 = rnd() * w, y0 = rnd() * h;
    const len = strokeLen * (0.5 + rnd());
    const ang = Math.PI / 2 + (rnd() - 0.5) * 0.7;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    let r = rnd(), ci = 0;
    while (ci < STROKE_COLORS.length - 1 && r > STROKE_COLORS[ci][4]) { r -= STROKE_COLORS[ci][4]; ci++; }
    const [cr, cg, cb, ca] = STROKE_COLORS[ci];
    const wide = rnd() < 0.45;
    const steps = Math.ceil(len);
    for (let t = 0; t <= steps; t++) {
      const fade = 1 - (t / steps) * 0.6; // Haar wird zur Spitze dünner/blasser
      const a = ca * fade;
      const yy = Math.round(y0 + dy * t);
      if (yy < 0 || yy >= h) continue;
      const xx0 = Math.round(x0 + dx * t);
      for (let k = 0; k < (wide ? 2 : 1); k++) {
        const xx = ((xx0 + k) % w + w) % w;
        const j = yy * w + xx, q = j * 4;
        px[q] += (cr - px[q]) * a;
        px[q + 1] += (cg - px[q + 1]) * a;
        px[q + 2] += (cb - px[q + 2]) * a;
        height[j] += (1 - height[j]) * 0.35 * fade;
      }
    }
  }
  ctx.putImageData(img, 0, 0);

  // Normal-Map (Sobel, mit horizontalem Umbruch)
  const hc = makeCanvas(w, h), hctx = hc.getContext('2d');
  const nimg = hctx.createImageData(w, h);
  const dst = nimg.data;
  const lum = height;
  for (let y = 0; y < h; y++) {
    const ym = (y > 0 ? y - 1 : y) * w, y0 = y * w, yp = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : w - 1, xp = x < w - 1 ? x + 1 : 0;
      const ddx = (lum[ym + xp] + 2 * lum[y0 + xp] + lum[yp + xp]) - (lum[ym + xm] + 2 * lum[y0 + xm] + lum[yp + xm]);
      const ddy = (lum[yp + xm] + 2 * lum[yp + x] + lum[yp + xp]) - (lum[ym + xm] + 2 * lum[ym + x] + lum[ym + xp]);
      const nx = -ddx * normalStrength, ny = ddy * normalStrength;
      const l = Math.sqrt(nx * nx + ny * ny + 1);
      const i = (y0 + x) * 4;
      dst[i] = (nx / l * 0.5 + 0.5) * 255;
      dst[i + 1] = (ny / l * 0.5 + 0.5) * 255;
      dst[i + 2] = (1 / l * 0.5 + 0.5) * 255;
      dst[i + 3] = 255;
    }
  }
  hctx.putImageData(nimg, 0, 0);

  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  map.wrapS = THREE.RepeatWrapping;
  map.userData.mimeType = 'image/jpeg'; // kleinere GLB-Dateien beim Export
  const normalMap = new THREE.CanvasTexture(hc);
  normalMap.anisotropy = 8;
  normalMap.wrapS = THREE.RepeatWrapping;
  normalMap.userData.mimeType = 'image/jpeg';
  return { map, normalMap };
}

// Unregelmäßige, weiche Form (Fleck) aus vielen weichen Punkten
function softBlob(ctx, x, y, rx, ry, color, rnd, n = 60) {
  const spr = softSprite(color);
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd());
    const px = x + Math.cos(a) * rx * r, py = y + Math.sin(a) * ry * r;
    const s = (0.25 + rnd() * 0.5) * Math.min(rx, ry);
    ctx.drawImage(spr, px - s, py - s, s * 2, s * 2);
  }
}

// Texturkoordinaten der Körper-Ellipsoide: u = 0.25 Rücken, 0.75 Bauch; Canvas-y: 0 = hinten, h = vorne
function abdomenPattern(ctx, w, h, rnd) {
  const x0 = 0.25 * w;
  // Bauch heller
  softBlob(ctx, 0.75 * w, 0.5 * h, 0.16 * w, 0.45 * h, '#c9bea6', rnd, 120);
  // dunkle Rückenfläche mit unregelmäßigem Rand
  for (let y = 0.04 * h; y < 0.97 * h; y += 0.02 * h) {
    const wid = (0.1 + 0.035 * Math.sin(y / h * 19) + 0.02 * rnd()) * w;
    softBlob(ctx, x0, y, wid, 0.03 * h, '#3d3125', rnd, 10);
  }
  // Herzmal (hell, lanzettförmig) in der vorderen Hälfte
  for (let y = 0.5 * h; y < 0.96 * h; y += 0.012 * h) {
    const t = (y - 0.5 * h) / (0.46 * h);
    const wid = (0.012 + 0.03 * Math.sin(t * Math.PI)) * w;
    softBlob(ctx, x0, y, wid, 0.015 * h, '#b9a682', rnd, 6);
  }
  // Winkelflecken (Chevrons) und helle Punktpaare hinten
  for (let k = 0; k < 6; k++) {
    const y = (0.1 + k * 0.07) * h;
    for (const s of [-1, 1]) {
      softBlob(ctx, x0 + s * (0.035 + k * 0.004) * w, y, 0.022 * w, 0.012 * h, '#cbb994', rnd, 8);
      softBlob(ctx, x0 + s * 0.09 * w, y + 0.02 * h, 0.01 * w, 0.008 * h, '#d8c8a5', rnd, 5);
    }
  }
  // dunkle Sprenkel an den Seiten
  for (let i = 0; i < 160; i++) {
    const side = rnd() < 0.5 ? 0 : 0.5;
    softBlob(ctx, (side + (rnd() - 0.5) * 0.18) * w, rnd() * h, 0.008 * w, 0.006 * h, '#2c2219', rnd, 3);
  }
}

function prosomaPattern(ctx, w, h, rnd) {
  const x0 = 0.25 * w;
  const band = (dx, wid, col, n = 8) => {
    for (let y = 0.02 * h; y < 0.98 * h; y += 0.015 * h) softBlob(ctx, x0 + dx, y, wid, 0.02 * h, col, rnd, n);
  };
  // seitlich dunkel
  softBlob(ctx, 0.0 * w, 0.5 * h, 0.08 * w, 0.5 * h, '#3a2e22', rnd, 80);
  softBlob(ctx, 0.5 * w, 0.5 * h, 0.08 * w, 0.5 * h, '#3a2e22', rnd, 80);
  // dunkle Längsbänder neben hellem Mittelband, helle Randbänder
  for (const s of [-1, 1]) {
    band(s * 0.075 * w, 0.03 * w, '#33281d');
    band(s * 0.14 * w, 0.022 * w, '#c2b18e', 6);
  }
  band(0, 0.022 * w, '#cdbb96');
  // Fovea + Radiärstreifen
  const fy = 0.42 * h;
  ctx.strokeStyle = 'rgba(40,30,20,0.35)';
  ctx.lineWidth = Math.max(1, w / 340);
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(x0, fy);
    ctx.lineTo(x0 + Math.cos(a) * 0.12 * w, fy + Math.sin(a) * 0.3 * h);
    ctx.stroke();
  }
  softBlob(ctx, x0, fy, 0.008 * w, 0.03 * h, '#1e1710', rnd, 8);
  // Augenregion vorne dunkel
  softBlob(ctx, x0, 0.95 * h, 0.06 * w, 0.05 * h, '#1f1810', rnd, 30);
}

function legPattern(ctx, w, h, rnd) {
  // Bänder (Ringel) – dunkel an den Gelenken, hell dazwischen
  const ring = (y, hh, col, n) => {
    for (let x = 0; x < w; x += 0.04 * w) softBlob(ctx, x, y, 0.05 * w, hh, col, rnd, n);
  };
  ring(0.04 * h, 0.07 * h, '#1e1710', 7);
  ring(0.96 * h, 0.07 * h, '#1e1710', 7);
  ring(0.3 * h, 0.06 * h, '#1f1810', 8);
  ring(0.55 * h, 0.08 * h, '#b3a283', 7);
  ring(0.78 * h, 0.05 * h, '#1f1810', 7);
  // Unterseite etwas dunkler
  softBlob(ctx, 0.75 * w, 0.5 * h, 0.15 * w, 0.5 * h, '#4a3c2c', rnd, 40);
}

let cachedTextures = null;
function getTextures() {
  if (cachedTextures) return cachedTextures;
  const palette = ['#4a3d2f', '#6e5f4a', '#8a7a62', '#2e251c', '#a39378'];
  cachedTextures = {
    abdomen: furTexture({ w: 1024, h: 1024, seed: 11, base: '#5c4f40', palette, pattern: abdomenPattern, strokes: 26000, strokeLen: 12 }),
    prosoma: furTexture({ w: 1024, h: 1024, seed: 23, base: '#51463a', palette, pattern: prosomaPattern, strokes: 20000, strokeLen: 10 }),
    leg: furTexture({ w: 512, h: 1024, seed: 37, base: '#5a4d3e', palette, pattern: legPattern, strokes: 14000, strokeLen: 14 }),
  };
  return cachedTextures;
}

// ---------------------------------------------------------------------------
// Geometrie-Bausteine
// ---------------------------------------------------------------------------
/** Ellipsoid mit Längsachse Z (Pole vorne/hinten), deform(x,y,z) auf Einheitskugel → Vector3 */
function ellipsoid(scale, deform, seg = [72, 56]) {
  const g = new THREE.SphereGeometry(1, seg[0], seg[1]);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    deform(v);
    v.multiply(scale);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

/** Konisches, leicht bauchiges Beinglied von a nach b */
function limbSegment(a, b, r0, r1, bulge = 0.12, radial = 14) {
  const dir = b.clone().sub(a);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, radial, 8, false);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const t = y / len + 0.5;
    const k = 1 + bulge * Math.sin(Math.PI * t);
    p.setX(i, p.getX(i) * k);
    p.setZ(i, p.getZ(i) * k);
  }
  g.computeVertexNormals();
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

function jointBall(p, r) {
  const g = new THREE.SphereGeometry(r, 14, 10);
  g.translate(p.x, p.y, p.z);
  return g;
}

/** Sammelt Haare als dünne dreiseitige Pyramiden (sehr günstig zu rendern) */
class HairBuilder {
  constructor() { this.pos = []; this.col = []; }
  add(p, dir, len, rad, shade) {
    const d = dir.clone().normalize();
    const e1 = Math.abs(d.y) < 0.9 ? new THREE.Vector3().crossVectors(d, UP).normalize() : new THREE.Vector3(1, 0, 0);
    const e2 = new THREE.Vector3().crossVectors(d, e1);
    const b = [0, 1, 2].map((k) => {
      const a = (k / 3) * Math.PI * 2;
      return p.clone().addScaledVector(e1, Math.cos(a) * rad).addScaledVector(e2, Math.sin(a) * rad);
    });
    const tip = p.clone().addScaledVector(d, len);
    for (let k = 0; k < 3; k++) {
      for (const q of [b[k], b[(k + 1) % 3], tip]) this.pos.push(q.x, q.y, q.z);
      // Spitze heller (Lichtdurchlässigkeit der Haare)
      this.col.push(shade, shade * 0.95, shade * 0.88, shade, shade * 0.95, shade * 0.88, shade * 1.25, shade * 1.2, shade * 1.1);
    }
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    return g;
  }
}

/** Haare auf einer Oberfläche verteilen, flach nach "flow" (Richtung) gekämmt */
function hairOnSurface(hb, geo, count, rnd, { flow, len = [0.025, 0.05], rad = 0.0028, lift = 0.45, minY = -Infinity, shadeFn }) {
  const p = geo.attributes.position, n = geo.attributes.normal;
  const P = new THREE.Vector3(), N = new THREE.Vector3(), T = new THREE.Vector3();
  let placed = 0, guard = 0;
  while (placed < count && guard++ < count * 4) {
    const i = Math.floor(rnd() * p.count);
    P.fromBufferAttribute(p, i);
    if (P.y < minY) continue;
    N.fromBufferAttribute(n, i);
    // leicht versetzen, damit die Haare nicht auf dem Vertex-Raster stehen
    P.x += (rnd() - 0.5) * 0.012; P.y += (rnd() - 0.5) * 0.012; P.z += (rnd() - 0.5) * 0.012;
    const f = typeof flow === 'function' ? flow(P) : flow;
    T.copy(f).addScaledVector(N, -N.dot(f)).normalize();
    const dir = N.clone().multiplyScalar(lift + rnd() * 0.3).addScaledVector(T, 1)
      .add(V((rnd() - 0.5) * 0.35, (rnd() - 0.5) * 0.35, (rnd() - 0.5) * 0.35));
    const l = len[0] + rnd() * (len[1] - len[0]);
    hb.add(P.clone().addScaledVector(N, -0.002), dir, l, rad, shadeFn ? shadeFn(P, rnd) : 1);
    placed++;
  }
}

// ---------------------------------------------------------------------------
// Spinne zusammenbauen
// ---------------------------------------------------------------------------
export function createSpider() {
  const rnd = mulberry32(2024);
  const tex = getTextures();
  const group = new THREE.Group();
  group.name = 'Wolfsspinne';

  const furMat = (t, color = '#ffffff', extra = {}) => new THREE.MeshPhysicalMaterial({
    color, map: t.map, normalMap: t.normalMap, normalScale: new THREE.Vector2(0.9, 0.9),
    roughness: 0.82, metalness: 0,
    sheen: 0.45, sheenColor: new THREE.Color('#a89878'), sheenRoughness: 0.5,
    ...extra,
  });
  const abdomenMat = furMat(tex.abdomen); abdomenMat.name = 'Fell Hinterleib';
  const prosomaMat = furMat(tex.prosoma); prosomaMat.name = 'Fell Vorderkörper';
  const legMat = furMat(tex.leg); legMat.name = 'Fell Beine';
  const chelMat = furMat(tex.leg, '#5a4a3a'); chelMat.name = 'Cheliceren';
  const eyeMat = new THREE.MeshPhysicalMaterial({ color: '#050505', roughness: 0.04, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02, name: 'Augen' });
  const fangMat = new THREE.MeshPhysicalMaterial({ color: '#1b0f09', roughness: 0.25, clearcoat: 0.8, name: 'Giftklauen' });
  const hairMat = new THREE.MeshStandardMaterial({ color: '#8f8068', vertexColors: true, roughness: 0.65, name: 'Haare' });
  const spineMat = new THREE.MeshStandardMaterial({ color: '#1f1812', roughness: 0.5, name: 'Borsten' });

  const add = (geo, mat, name) => {
    const m = new THREE.Mesh(geo, mat);
    m.name = name; m.castShadow = true; m.receiveShadow = true;
    group.add(m);
    return m;
  };

  // --- Vorderkörper (Prosoma) ---
  const PRO_C = V(0, 0.36, 0.22), PRO_S = V(0.3, 0.19, 0.38);
  const proDeform = (v) => {
    if (v.y > 0) v.y *= 1 + 0.38 * Math.max(0, v.z) - 0.12 * Math.max(0, -v.z);
    else v.y *= 0.62;
    if (v.z > 0.78) v.z = 0.78 + (v.z - 0.78) * 0.45; // stumpfe Front für die Augen
    v.x *= 1 - 0.18 * Math.max(0, v.z) ** 2;
    return v;
  };
  const proGeo = ellipsoid(PRO_S, proDeform);
  proGeo.translate(PRO_C.x, PRO_C.y, PRO_C.z);
  add(proGeo, prosomaMat, 'Vorderkörper');
  const proSurface = (dir) => proDeform(dir.clone().normalize()).multiply(PRO_S).add(PRO_C);

  // --- Hinterleib (Opisthosoma) ---
  const ABD_C = V(0, 0.42, -0.5), ABD_S = V(0.37, 0.32, 0.53);
  const abdDeform = (v) => {
    const narrow = 1 - 0.22 * Math.max(0, v.z) ** 2 - 0.08 * Math.max(0, -v.z) ** 3;
    v.x *= narrow; v.y *= narrow;
    if (v.y < 0) v.y *= 0.85;
    // leichte organische Unregelmäßigkeit
    const n = 1 + 0.015 * Math.sin(v.x * 9 + v.z * 5) * Math.cos(v.y * 7);
    return v.multiplyScalar(n);
  };
  const abdGeo = ellipsoid(ABD_S, abdDeform);
  abdGeo.rotateX(-0.12);
  abdGeo.translate(ABD_C.x, ABD_C.y, ABD_C.z);
  add(abdGeo, abdomenMat, 'Hinterleib');

  // Taille (Pedicel)
  add(limbSegment(V(0, 0.33, -0.1), V(0, 0.37, -0.02), 0.07, 0.07, 0), legMat, 'Taille');

  // Spinnwarzen
  const spin = [];
  for (const s of [-1, 1]) {
    const g = new THREE.ConeGeometry(0.022, 0.07, 10);
    g.rotateX(-Math.PI / 2 - 0.35);
    g.translate(s * 0.022, 0.36, -1.04);
    spin.push(g);
  }
  add(mergeGeometries(spin), chelMat, 'Spinnwarzen');

  // --- Augen (Wolfsspinnen-Anordnung: 4 klein vorne, 2 sehr groß, 2 oben) ---
  const eyes = [];
  const eye = (dir, r) => {
    const surf = proSurface(dir);
    const nrm = surf.clone().sub(PRO_C).normalize();
    const g = new THREE.SphereGeometry(r, 24, 16);
    const c = surf.addScaledVector(nrm, -r * 0.35);
    g.translate(c.x, c.y, c.z);
    eyes.push(g);
  };
  for (const s of [-1, 1]) {
    eye(V(s * 0.26, 0.5, 0.83), 0.045);   // große Hauptaugen
    eye(V(s * 0.5, 0.82, 0.32), 0.033);   // hintere Augen oben
    eye(V(s * 0.1, 0.12, 0.99), 0.017);   // vordere Reihe innen
    eye(V(s * 0.3, 0.1, 0.95), 0.016);    // vordere Reihe außen
  }
  add(mergeGeometries(eyes), eyeMat, 'Augen');

  // --- Cheliceren mit Giftklauen ---
  const chel = [], fangs = [];
  for (const s of [-1, 1]) {
    const g = new THREE.SphereGeometry(1, 28, 20);
    g.scale(0.062, 0.12, 0.068);
    g.rotateX(0.25);
    g.rotateZ(-s * 0.08);
    g.translate(s * 0.066, 0.22, 0.585);
    chel.push(g);
    const f = new THREE.ConeGeometry(0.013, 0.07, 10);
    f.rotateX(Math.PI);          // Spitze nach unten
    f.translate(0, -0.035, 0);   // Basis am Ursprung
    f.rotateZ(-s * 0.9);         // Spitze nach innen
    f.rotateX(-0.25);
    f.translate(s * 0.07, 0.125, 0.615);
    fangs.push(f);
  }
  const chelGeo = mergeGeometries(chel);
  add(chelGeo, chelMat, 'Cheliceren');
  add(mergeGeometries(fangs), fangMat, 'Giftklauen');

  // --- Beine ---
  const hairs = new HairBuilder();
  const spines = new HairBuilder();
  const shade = (rnd2) => (rnd2() < 0.32 ? 0.32 : 0.65 + rnd2() * 0.45);

  // Beine I–IV: Ansatzwinkel am Prosoma, Spreizwinkel, Gliedlängen [Femur, Patella, Tibia, Metatarsus, Tarsus]
  const LEGS = [
    { attach: 58, spread: 64, femurUp: 50, len: [0.62, 0.2, 0.52, 0.5, 0.25] },
    { attach: 26, spread: 24, femurUp: 46, len: [0.58, 0.19, 0.48, 0.47, 0.23] },
    { attach: -6, spread: -18, femurUp: 44, len: [0.53, 0.17, 0.43, 0.48, 0.22] },
    { attach: -38, spread: -54, femurUp: 42, len: [0.68, 0.2, 0.58, 0.72, 0.28] },
  ];
  const RADII = [0.05, 0.047, 0.041, 0.039, 0.032, 0.022, 0.015];

  const buildLeg = (joints, radii, name, { bulges, spineSegs }) => {
    const parts = [];
    for (let k = 0; k < joints.length - 1; k++) {
      const a = joints[k], b = joints[k + 1];
      parts.push(limbSegment(a, b, radii[k], radii[k + 1], bulges[k] ?? 0.08));
      if (k > 0) parts.push(jointBall(a, radii[k] * 1.04));

      // Behaarung entlang des Glieds (zur Spitze hin gekämmt)
      const dir = b.clone().sub(a);
      const len = dir.length();
      dir.normalize();
      const e1 = new THREE.Vector3().crossVectors(dir, UP).normalize();
      if (e1.lengthSq() < 0.1) e1.set(1, 0, 0);
      const e2 = new THREE.Vector3().crossVectors(e1, dir);
      const count = Math.round(len * 300);
      for (let i = 0; i < count; i++) {
        const t = rnd(), ang = rnd() * Math.PI * 2;
        const r = THREE.MathUtils.lerp(radii[k], radii[k + 1], t) * (1 + (bulges[k] ?? 0.08) * Math.sin(Math.PI * t));
        const radial = e1.clone().multiplyScalar(Math.cos(ang)).addScaledVector(e2, Math.sin(ang));
        const p = a.clone().addScaledVector(dir, t * len).addScaledVector(radial, r * 0.96);
        const hd = radial.clone().multiplyScalar(0.3 + rnd() * 0.25).addScaledVector(dir, 1)
          .add(V((rnd() - 0.5) * 0.3, (rnd() - 0.5) * 0.3, (rnd() - 0.5) * 0.3));
        hairs.add(p, hd, 0.016 + rnd() * 0.028, 0.0019, shade(rnd));
      }
      // kräftige dunkle Borsten (Stacheln) an Femur, Tibia, Metatarsus
      if (spineSegs.includes(k)) {
        const n = 2 + Math.floor(rnd() * 3);
        for (let i = 0; i < n; i++) {
          const t = 0.15 + rnd() * 0.75;
          const ang = Math.PI * (0.25 + rnd() * 1.5); // bevorzugt Seiten/Unterseite
          const radial = e1.clone().multiplyScalar(Math.cos(ang)).addScaledVector(e2, Math.sin(ang) - 0.4).normalize();
          const r = THREE.MathUtils.lerp(radii[k], radii[k + 1], t);
          const p = a.clone().addScaledVector(dir, t * len).addScaledVector(radial, r * 0.9);
          spines.add(p, radial.clone().multiplyScalar(0.8).addScaledVector(dir, 1.2), 0.045 + rnd() * 0.035, 0.0034, 1);
        }
      }
    }
    return add(mergeGeometries(parts), legMat, name);
  };

  const deg = THREE.MathUtils.degToRad;
  LEGS.forEach((L, i) => {
    for (const s of [1, -1]) {
      const jit = (rnd() - 0.5) * 6;
      const aAtt = deg(L.attach), aDir = deg(L.spread + jit * s);
      const d = V(s * Math.cos(aDir), 0, Math.sin(aDir));
      const attach = V(s * 0.25 * Math.cos(aAtt), 0.3, 0.22 + 0.3 * Math.sin(aAtt));
      // Gelenkpunkte in der Ebene (radial r, Höhe y) entlang d
      const pts = [attach];
      let cur = attach.clone().addScaledVector(d, 0.07); cur.y = 0.32; pts.push(cur.clone()); // Coxa
      cur.addScaledVector(d, 0.05); cur.y = 0.34; pts.push(cur.clone());                       // Trochanter
      const step = (len, elev) => { cur.addScaledVector(d, len * Math.cos(elev)); cur.y += len * Math.sin(elev); pts.push(cur.clone()); };
      const scale = i === 3 ? 1.05 : 1;
      step(L.len[0] * scale, deg(L.femurUp + jit));   // Femur
      step(L.len[1] * scale, deg(-12));               // Patella
      step(L.len[2] * scale, deg(-46 + jit * 0.5));   // Tibia
      // Metatarsus so neigen, dass der Tarsus am Boden aufsetzt
      const tars = L.len[4] * scale, met = L.len[3] * scale;
      const need = 0.016 - cur.y + tars * Math.sin(deg(12));
      step(met, Math.asin(THREE.MathUtils.clamp(need / met, -0.99, 0.99)));
      step(tars, deg(-12));                            // Tarsus
      const radii = RADII.map((r) => r * scale);
      radii.splice(1, 0, radii[0]); // Trochanter
      buildLeg(pts, radii, `Bein ${s > 0 ? 'R' : 'L'}${i + 1}`, {
        bulges: [0.05, 0.05, 0.14, 0.1, 0.1, 0.05, 0.04, 0.03],
        spineSegs: [2, 4, 5],
      });
    }
  });

  // --- Pedipalpen (Taster) ---
  for (const s of [1, -1]) {
    const d = V(s * Math.sin(deg(14)), 0, Math.cos(deg(14)));
    const start = V(s * 0.1, 0.22, 0.5);
    const pts = [start];
    const cur = start.clone();
    const step = (len, elev) => { cur.addScaledVector(d, len * Math.cos(elev)); cur.y += len * Math.sin(elev); pts.push(cur.clone()); };
    step(0.06, deg(10));
    step(0.17, deg(38));
    step(0.07, deg(0));
    step(0.1, deg(-45));
    step(0.11, deg(-75));
    buildLeg(pts, [0.03, 0.028, 0.026, 0.025, 0.026, 0.03, 0.02], `Taster ${s > 0 ? 'R' : 'L'}`, {
      bulges: [0.05, 0.1, 0.05, 0.08, 0.25],
      spineSegs: [],
    });
  }

  // --- Körperbehaarung ---
  const backFlow = V(0, -0.15, -1);
  hairOnSurface(hairs, abdGeo, 3800, rnd, {
    flow: backFlow, len: [0.022, 0.048], lift: 0.22,
    shadeFn: (P, r) => (r() < 0.28 ? 0.3 : 0.7 + r() * 0.45),
  });
  hairOnSurface(hairs, proGeo, 1500, rnd, {
    flow: (P) => V(P.x * 0.6, 0.1, -1), len: [0.016, 0.034], lift: 0.2, minY: 0.2,
    shadeFn: (P, r) => (Math.abs(P.x) < 0.035 ? 1.1 : r() < 0.4 ? 0.3 : 0.7 + r() * 0.35),
  });
  hairOnSurface(hairs, chelGeo, 500, rnd, {
    flow: V(0, -1, 0.3), len: [0.02, 0.045], lift: 0.5,
    shadeFn: (P, r) => (r() < 0.45 ? 1.15 : 0.35),
  });

  add(hairs.build(), hairMat, 'Behaarung');
  add(spines.build(), spineMat, 'Borsten');

  return group;
}
