// „Die Bleiche“ – eigene Geisterfrau: ausgezehrt, überlange Arme mit Krallen, langes nasses Haar vor dem Gesicht,
// zerrissenes Leinenkleid, barfuß. Vollständig prozedural (keine Downloads, offline).
// Skelett: humanoid (wie die anderen Figuren) + Finger-, Kiefer-, Haar- und Kleidknochen → realistische Animationen
// inklusive Angriff (siehe animator.js, flavor 'ghost'). Blickrichtung +Z, steht auf y = 0.
import * as THREE from 'three';
import { RigBuilder, V, capsule, taper, blob, torso } from './rigkit.js';
import { RIGS } from './rig-registry.js';
import { humanoidSkeleton } from './characters.js';
import { mulberry32, softBlob } from './spider.js';

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------------------
// Texturen (Haut, Leinen) – Farbe + Höhenkarte → Normal-Map
// ---------------------------------------------------------------------------
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

function normalFromHeight(hc, strength) {
  const w = hc.width, h = hc.height;
  const src = hc.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = src[i * 4] / 255;
  const out = canvas(w, h), octx = out.getContext('2d');
  const img = octx.createImageData(w, h), dst = img.data;
  for (let y = 0; y < h; y++) {
    const ym = (y > 0 ? y - 1 : y) * w, y0 = y * w, yp = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : w - 1, xp = x < w - 1 ? x + 1 : 0;
      const dx = (lum[ym + xp] + 2 * lum[y0 + xp] + lum[yp + xp]) - (lum[ym + xm] + 2 * lum[y0 + xm] + lum[yp + xm]);
      const dy = (lum[yp + xm] + 2 * lum[yp + x] + lum[yp + xp]) - (lum[ym + xm] + 2 * lum[ym + x] + lum[ym + xp]);
      const nx = -dx * strength, ny = dy * strength, l = Math.sqrt(nx * nx + ny * ny + 1);
      const i = (y0 + x) * 4;
      dst[i] = (nx / l * 0.5 + 0.5) * 255; dst[i + 1] = (ny / l * 0.5 + 0.5) * 255; dst[i + 2] = (1 / l * 0.5 + 0.5) * 255; dst[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

function toTextures(c, hc, strength, repeat = [1, 1]) {
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  const normalMap = new THREE.CanvasTexture(normalFromHeight(hc, strength));
  for (const t of [map, normalMap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
    t.anisotropy = 8;
    t.userData.mimeType = 'image/jpeg'; // kleinere GLB-Dateien
  }
  return { map, normalMap };
}

/** Feines Rauschen direkt in den Pixelspeicher (schnell) */
function grain(ctx, w, h, rnd, amount, mono = true) {
  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * amount;
    d[i] += n; d[i + 1] += mono ? n : (rnd() - 0.5) * amount; d[i + 2] += mono ? n : (rnd() - 0.5) * amount;
  }
  ctx.putImageData(img, 0, 0);
}

let texCache = null;
function ghostTextures() {
  if (texCache) return texCache;
  // --- Haut: fahl, gräulich, fleckig, durchscheinende Adern, Schmutz ---
  const S = 512, rnd = mulberry32(666);
  const c = canvas(S, S), ctx = c.getContext('2d', { willReadFrequently: true });
  const hc = canvas(S, S), hctx = hc.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#9c8b77'; ctx.fillRect(0, 0, S, S);
  hctx.fillStyle = '#808080'; hctx.fillRect(0, 0, S, S);
  const blotch = ['#8a7a67', '#938e7f', '#82725f', '#a59783', '#786c5d', '#8c8172'];
  for (let i = 0; i < 46; i++) softBlob(ctx, rnd() * S, rnd() * S, (0.05 + rnd() * 0.14) * S, (0.05 + rnd() * 0.12) * S, blotch[i % blotch.length], rnd, 7);
  // Adern (bläulich-violett) als verzweigte, dünne Linien
  ctx.lineCap = 'round';
  for (let i = 0; i < 26; i++) {
    let x = rnd() * S, y = rnd() * S, a = rnd() * Math.PI * 2;
    ctx.strokeStyle = `rgba(${70 + rnd() * 20},${62 + rnd() * 15},${86 + rnd() * 20},${0.18 + rnd() * 0.2})`;
    ctx.lineWidth = 0.8 + rnd() * 1.6;
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let k = 0; k < 18; k++) { a += (rnd() - 0.5) * 0.9; x += Math.cos(a) * 9; y += Math.sin(a) * 9; ctx.lineTo(x, y); }
    ctx.stroke();
  }
  // Falten / Hautstruktur in der Höhenkarte
  hctx.lineCap = 'round';
  for (let i = 0; i < 900; i++) {
    const x = rnd() * S, y = rnd() * S, l = 4 + rnd() * 16, a = (rnd() - 0.5) * 0.8;
    hctx.strokeStyle = `rgba(40,40,40,${0.12 + rnd() * 0.2})`;
    hctx.lineWidth = 0.6 + rnd();
    hctx.beginPath(); hctx.moveTo(x, y); hctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); hctx.stroke();
  }
  for (let i = 0; i < 40; i++) softBlob(hctx, rnd() * S, rnd() * S, (0.02 + rnd() * 0.06) * S, (0.02 + rnd() * 0.06) * S, '#b0b0b0', rnd, 8);
  // Schmutz
  for (let i = 0; i < 16; i++) softBlob(ctx, rnd() * S, rnd() * S, (0.01 + rnd() * 0.04) * S, (0.01 + rnd() * 0.04) * S, '#4a4036', rnd, 6);
  grain(ctx, S, S, rnd, 18, false);
  grain(hctx, S, S, rnd, 40);
  const skin = toTextures(c, hc, 2.2, [2, 2]);

  // --- Leinenkleid: vergilbt, senkrechte Falten-Streifen, Flecken, nach unten dreckig ---
  const W = 512, H = 1024, r2 = mulberry32(1313);
  const d = canvas(W, H), dctx = d.getContext('2d', { willReadFrequently: true });
  const dh = canvas(W, H), dhctx = dh.getContext('2d', { willReadFrequently: true });
  dctx.fillStyle = '#ab9673'; dctx.fillRect(0, 0, W, H);
  dhctx.fillStyle = '#808080'; dhctx.fillRect(0, 0, W, H);
  // Längsstreifen (Falten, verwaschene Bahnen)
  for (let i = 0; i < 70; i++) {
    const x = r2() * W, w = 2 + r2() * 22, dark = r2() < 0.6;
    const g = dctx.createLinearGradient(x - w, 0, x + w, 0);
    const col = dark ? '60,45,28' : '205,190,160';
    g.addColorStop(0, `rgba(${col},0)`); g.addColorStop(0.5, `rgba(${col},${0.12 + r2() * 0.22})`); g.addColorStop(1, `rgba(${col},0)`);
    dctx.fillStyle = g; dctx.fillRect(x - w, 0, w * 2, H);
    const gh = dhctx.createLinearGradient(x - w, 0, x + w, 0);
    gh.addColorStop(0, 'rgba(128,128,128,0)'); gh.addColorStop(0.5, dark ? 'rgba(60,60,60,0.35)' : 'rgba(200,200,200,0.35)'); gh.addColorStop(1, 'rgba(128,128,128,0)');
    dhctx.fillStyle = gh; dhctx.fillRect(x - w, 0, w * 2, H);
  }
  // Webstruktur
  for (let y = 0; y < H; y += 3) { dhctx.fillStyle = `rgba(0,0,0,${0.05 + r2() * 0.05})`; dhctx.fillRect(0, y, W, 1); }
  for (let x = 0; x < W; x += 3) { dhctx.fillStyle = `rgba(255,255,255,${0.04 + r2() * 0.05})`; dhctx.fillRect(x, 0, 1, H); }
  // Flecken und Schmutz, nach unten (Saum = unten im Bild) stärker
  for (let i = 0; i < 90; i++) {
    const y = H * (1 - Math.pow(r2(), 1.8));
    softBlob(dctx, r2() * W, y, (0.02 + r2() * 0.08) * W, (0.02 + r2() * 0.1) * W, r2() < 0.5 ? '#4a3a26' : '#6e5a3e', r2, 16);
  }
  const hem = dctx.createLinearGradient(0, H * 0.55, 0, H);
  hem.addColorStop(0, 'rgba(40,28,16,0)'); hem.addColorStop(1, 'rgba(40,28,16,0.75)');
  dctx.fillStyle = hem; dctx.fillRect(0, 0, W, H);
  // Wasserränder
  dctx.lineWidth = 1.5;
  for (let i = 0; i < 18; i++) {
    dctx.strokeStyle = `rgba(70,52,30,${0.2 + r2() * 0.2})`;
    dctx.beginPath();
    dctx.ellipse(r2() * W, H * (0.3 + r2() * 0.7), 10 + r2() * 40, 8 + r2() * 30, r2() * 3, 0, Math.PI * 2);
    dctx.stroke();
  }
  grain(dctx, W, H, r2, 14);
  grain(dhctx, W, H, r2, 30);
  const linen = toTextures(d, dh, 3.0, [3, 1]);
  texCache = { skin, linen };
  return texCache;
}

// ---------------------------------------------------------------------------
// Figur
// ---------------------------------------------------------------------------
export function createGhostWoman() {
  const rb = new RigBuilder('Die Bleiche');
  const P = {
    hips: V(0, 1.0, 0), spine: V(0, 1.12, 0), chest: V(0, 1.33, 0), neck: V(0, 1.53, 0), head: V(0, 1.62, 0.005), jaw: V(0, 1.7, 0.01),
    shoulder: [0.165, 1.49, -0.01], elbow: [0.2, 1.16, -0.03], wrist: [0.23, 0.84, 0.0],
    hip: [0.078, 0.98, 0], knee: [0.084, 0.53, 0.015], ankle: [0.086, 0.075, -0.015],
  };
  const S = humanoidSkeleton(rb, P);
  const tex = ghostTextures();
  const skin = new THREE.MeshStandardMaterial({ name: 'Haut', color: '#a89c90', map: tex.skin.map, normalMap: tex.skin.normalMap, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.62 });
  const dress = new THREE.MeshStandardMaterial({ name: 'Kleid', color: '#d8ccb8', map: tex.linen.map, normalMap: tex.linen.normalMap, roughness: 0.93, side: THREE.DoubleSide });
  const dressInner = new THREE.MeshStandardMaterial({ name: 'Unterkleid', color: '#8a7658', map: tex.linen.map, normalMap: tex.linen.normalMap, roughness: 0.95, side: THREE.DoubleSide });
  const hair = new THREE.MeshPhysicalMaterial({ name: 'Haare', color: '#0d0b0a', roughness: 0.38, metalness: 0, sheen: 0.6, sheenColor: new THREE.Color('#4a423a'), sheenRoughness: 0.35 });
  const claw = new THREE.MeshStandardMaterial({ name: 'Krallen', color: '#3a3024', roughness: 0.3 });
  const eye = new THREE.MeshStandardMaterial({ name: 'Augen', color: '#cfc8b4', roughness: 0.12 });
  const pupil = new THREE.MeshStandardMaterial({ name: 'Pupillen', color: '#2a2622', roughness: 0.1 });
  const dark = new THREE.MeshStandardMaterial({ name: 'Rachen', color: '#120707', roughness: 0.6 });
  const teeth = new THREE.MeshStandardMaterial({ name: 'Zähne', color: '#b3a47e', roughness: 0.35 });

  // ---- Gewichte für weiche Übergänge am Rumpf ----
  const trunkW = (y) => {
    if (y < 1.06) return [[S.hips, 1]];
    if (y < 1.2) { const t = sstep(1.06, 1.2, y); return [[S.hips, 1 - t], [S.spine, t]]; }
    if (y < 1.38) { const t = sstep(1.24, 1.38, y); return [[S.spine, 1 - t], [S.chest, t]]; }
    return [[S.chest, 1]];
  };

  // ---- Rumpf (Haut, wird größtenteils vom Kleid verdeckt) ----
  const trunk = torso(1.02, 1.42, 0.11, 0.62);
  rb.addWeighted(trunk, skin, (p) => trunkW(p.y));
  // Schlüsselbeine, knochige Schultern, Brustbein
  for (const s of [1, -1]) {
    rb.add(capsule(V(0.02 * s, 1.475, 0.055), V(0.15 * s, 1.5, 0.02), 0.011), skin, S.chest);
    rb.add(blob(V(0.15 * s, 1.485, -0.005), 0.042, 0.036, 0.045), skin, S.chest);
    rb.add(capsule(V(0.03 * s, 1.535, -0.02), V(0.13 * s, 1.49, -0.02), 0.03), skin, S.chest); // Trapez
  }
  // Hals mit Sehnen
  rb.add(capsule(V(0, 1.47, 0), V(0, 1.64, 0.012), 0.034), skin, S.neck);
  for (const s of [1, -1]) rb.add(capsule(V(0.02 * s, 1.48, 0.035), V(0.03 * s, 1.63, 0.02), 0.008), skin, S.neck);

  // ---- Kopf: hager, eingefallene Wangen, tiefe Augenhöhlen, offener Mund ----
  const HY = 1.745;
  rb.add(blob(V(0, HY, -0.005), 0.083, 0.106, 0.098), skin, S.head);                // Schädel
  rb.add(blob(V(0, HY - 0.06, 0.035), 0.06, 0.05, 0.06), skin, S.head);            // Oberkiefer/Mittelgesicht
  for (const s of [1, -1]) {
    rb.add(blob(V(0.055 * s, HY - 0.01, 0.06), 0.022, 0.016, 0.022), skin, S.head);  // Wangenknochen
    rb.add(blob(V(0.033 * s, HY + 0.012, 0.072), 0.022, 0.016, 0.016), dark, S.head); // Augenhöhle
    rb.add(blob(V(0.033 * s, HY + 0.012, 0.079), 0.0125, 0.0105, 0.009), eye, S.head);
    rb.add(blob(V(0.033 * s, HY + 0.011, 0.0868), 0.0035, 0.0035, 0.0015), pupil, S.head);
    rb.add(blob(V(0.036 * s, HY + 0.032, 0.078), 0.026, 0.008, 0.012, [0, 0, -0.15 * s]), skin, S.head); // Brauenbogen
    rb.add(blob(V(0.083 * s, HY - 0.005, -0.005), 0.012, 0.026, 0.016), skin, S.head);  // Ohren
  }
  rb.add(blob(V(0, HY - 0.012, 0.092), 0.011, 0.028, 0.014, [-0.25, 0, 0]), skin, S.head); // Nase
  rb.add(blob(V(0, HY - 0.07, 0.06), 0.03, 0.03, 0.03), dark, S.head);              // Rachen
  for (let k = -3; k <= 3; k++) rb.add(blob(V(k * 0.0075, HY - 0.056, 0.083 - Math.abs(k) * 0.004), 0.0038, 0.007, 0.003), teeth, S.head);
  // Unterkiefer (eigener Knochen; in Ruhe leicht geöffnet)
  const JY = HY - 0.098;
  rb.add(blob(V(0, JY, 0.05), 0.048, 0.022, 0.04), skin, S.jaw);
  rb.add(blob(V(0, JY - 0.004, 0.086), 0.02, 0.018, 0.012), skin, S.jaw);           // Kinn
  for (const s of [1, -1]) rb.add(capsule(V(0.06 * s, HY - 0.035, 0.0), V(0.04 * s, JY, 0.05), 0.012), skin, S.jaw);
  for (let k = -3; k <= 3; k++) rb.add(blob(V(k * 0.007, JY + 0.017, 0.079 - Math.abs(k) * 0.004), 0.0034, 0.006, 0.003), teeth, S.jaw);

  // ---- Arme, Hände mit langen Krallenfingern ----
  const fingers = { L: [], R: [] };
  for (const X of [S.L, S.R]) {
    const m = X.m, s = X === S.L ? 1 : -1;
    rb.add(capsule(m(P.shoulder), m(P.elbow), 0.03), skin, X.arm.upper);
    rb.add(blob(m(P.elbow).add(V(0, 0, -0.006)), 0.028, 0.034, 0.028), skin, X.arm.fore); // knochiger Ellbogen
    rb.add(taper(m(P.elbow), m(P.wrist), 0.027, 0.02), skin, X.arm.fore);
    rb.add(blob(m([0.23, 0.842, 0.0]), 0.018, 0.02, 0.021), skin, X.arm.hand);       // Handgelenk
    rb.add(blob(m([0.232, 0.8, 0.005]), 0.014, 0.045, 0.033), skin, X.arm.hand);     // Handfläche (Innenseite zum Körper)
    // vier Finger + Daumen: je 2 Knochen, gebogene Krallen
    const list = [];
    const defs = [
      { z: 0.03, len: 0.15, y: 0.765 }, { z: 0.011, len: 0.175, y: 0.758 },
      { z: -0.008, len: 0.168, y: 0.76 }, { z: -0.026, len: 0.14, y: 0.767 },
    ];
    defs.forEach((f, i) => {
      const k = m([0.233, f.y, f.z]);
      const mid = m([0.226, f.y - f.len * 0.48, f.z + (f.z * 0.25)]);
      const tip = m([0.212, f.y - f.len, f.z + f.z * 0.4]);
      const prox = rb.bone(`${X.name === 'Left' ? 'Left' : 'Right'}Finger${i + 1}_1`, k, X.arm.hand);
      const dist = rb.bone(`${X.name === 'Left' ? 'Left' : 'Right'}Finger${i + 1}_2`, mid, prox);
      rb.add(blob(k, 0.0085, 0.009, 0.0085), skin, prox);                               // Knöchel
      rb.add(taper(k, mid, 0.0072, 0.0062, 8), skin, prox);
      rb.add(blob(mid, 0.0068, 0.0075, 0.0068, null, [10, 8]), skin, dist);
      rb.add(taper(mid, tip, 0.0062, 0.005, 8), skin, dist);
      // Kralle: zwei Kegelstücke, nach innen gebogen
      const c1 = tip.clone().add(V(-0.01 * s, -0.026, 0));
      const c2 = c1.clone().add(V(-0.016 * s, -0.022, 0));
      rb.add(taper(tip, c1, 0.0052, 0.0034, 8), claw, dist);
      rb.add(taper(c1, c2, 0.0034, 0.0006, 8), claw, dist);
      list.push({ prox, dist, i });
    });
    // Daumen (vorne, kürzer)
    const tk = m([0.226, 0.815, 0.032]);
    const tm = m([0.218, 0.77, 0.05]);
    const tt = m([0.208, 0.735, 0.058]);
    const tp = rb.bone(`${X.name}Thumb_1`, tk, X.arm.hand);
    const td = rb.bone(`${X.name}Thumb_2`, tm, tp);
    rb.add(taper(tk, tm, 0.009, 0.007, 8), skin, tp);
    rb.add(taper(tm, tt, 0.0068, 0.0055, 8), skin, td);
    rb.add(taper(tt, tt.clone().add(V(-0.012 * s, -0.03, 0.004)), 0.0052, 0.0007, 8), claw, td);
    list.push({ prox: tp, dist: td, i: 4, thumb: true });
    fingers[s > 0 ? 'L' : 'R'] = list;

    // dünne Beine, knochige Knie, nackte Füße
    rb.add(taper(m(P.hip), m(P.knee), 0.05, 0.034), skin, X.leg.up);
    rb.add(blob(m(P.knee), 0.034, 0.038, 0.034), skin, X.leg.low);
    rb.add(taper(m(P.knee), m(P.ankle), 0.032, 0.021), skin, X.leg.low);
    rb.add(blob(m([0.086, 0.075, -0.012]), 0.024, 0.022, 0.026), skin, X.leg.foot);   // Knöchel
    rb.add(blob(m([0.088, 0.03, 0.035]), 0.03, 0.026, 0.085), skin, X.leg.foot);      // Fuß
    rb.add(blob(m([0.086, 0.028, -0.025]), 0.026, 0.024, 0.03), skin, X.leg.foot);    // Ferse
    for (let t = 0; t < 5; t++) {                                                        // Zehen
      const tx = 0.062 + t * 0.012, tl = t === 0 ? 0.02 : 0.016 - t * 0.0015;
      rb.add(capsule(m([tx + 0.005, 0.014, 0.1]), m([tx + 0.006, 0.01, 0.1 + tl]), t === 4 ? 0.0055 : 0.007 - t * 0.0004, 8), skin, X.leg.foot);
    }
  }

  // ---- Kleid: Schleifenprofil (Saum → Brust), zerrissener Saum, Falten, weiche Gewichte ----
  const skirtBones = [];
  const NS = 8;
  for (let i = 0; i < NS; i++) {
    const a = (i / NS) * Math.PI * 2;
    const dir = V(Math.sin(a), 0, Math.cos(a));
    const b1 = rb.bone(`Rock${i + 1}_1`, V(dir.x * 0.1, 0.98, dir.z * 0.07), S.hips);
    const b2 = rb.bone(`Rock${i + 1}_2`, V(dir.x * 0.15, 0.72, dir.z * 0.12), b1);
    skirtBones.push({ bones: [b1, b2], a, dir, swing: new THREE.Vector3().crossVectors(V(0, -1, 0), dir).normalize() });
  }
  const makeDress = (seed, hemBase, rScale, jag) => {
    const rr = mulberry32(seed);
    // Profil von unten (Saum) nach oben (Brust): [radius, y]
    const prof = [];
    const R = (y) => {
      if (y > 1.33) return lerp(0.118, 0.105, sstep(1.33, 1.46, y));   // Brust
      if (y > 1.15) return lerp(0.1, 0.118, sstep(1.15, 1.33, y));     // Taille → Brust
      if (y > 0.95) return lerp(0.128, 0.1, sstep(0.95, 1.15, y));     // Hüfte → Taille
      return lerp(0.185, 0.13, (0.95 - y) < 0 ? 1 : Math.pow(clamp01((y - hemBase) / (0.95 - hemBase)), 0.8)); // Rock, leicht ausgestellt
    };
    const rows = 46;
    for (let k = 0; k <= rows; k++) {
      const y = lerp(hemBase, 1.46, k / rows);
      prof.push(new THREE.Vector2(R(y) * rScale, y));
    }
    const radial = 128;
    const g = new THREE.LatheGeometry(prof, radial);
    // Zerrissener Saum: Länge je Winkel (Zacken), Spalten zum Saum hin gedehnt
    const teeth = 22, amps = [], offs = [];
    for (let i = 0; i < teeth; i++) { amps.push(0.04 + rr() * jag); offs.push(rr() * 0.6); }
    const hemAt = (a) => {
      const u = ((a / (Math.PI * 2)) % 1 + 1) % 1 * teeth;
      const i = Math.floor(u), f = u - i;
      const tri = 1 - Math.abs(f - 0.5) * 2;               // Spitze in der Mitte des Zackens
      const sharp = Math.pow(tri, 2.2);
      return hemBase - amps[i] * sharp + offs[i] * 0.04 * (1 - sharp);
    };
    const pos = g.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const a = Math.atan2(v.x, v.z);
      const top = 1.0;
      if (v.y < top) {
        const h = hemAt(a);
        v.y = top - (top - v.y) * (top - h) / (top - hemBase);
      }
      // Falten: senkrechte Wellen, unten stärker; vorne-hinten etwas flacher
      const low = sstep(1.0, hemBase, v.y);
      const fold = 1 + (0.05 + 0.08 * low) * Math.sin(a * 9 + Math.sin(a * 3) * 1.5) + 0.03 * low * Math.sin(a * 23);
      const r = Math.hypot(v.x, v.z) * fold;
      const depth = lerp(0.72, 0.9, low);
      v.x = Math.sin(a) * r;
      v.z = Math.cos(a) * r * depth;
      // Halsausschnitt vorne/hinten tiefer
      if (v.y > 1.36) {
        const front = Math.pow(Math.abs(Math.cos(a)), 1.5);
        v.y = 1.36 + (v.y - 1.36) * (1 - 0.75 * front);
      }
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    return g;
  };
  const dressW = (p) => {
    if (p.y >= 0.98) return trunkW(p.y);
    const t = clamp01((0.98 - p.y) / 0.45);
    const a = Math.atan2(p.x, p.z);
    const u = ((a / (Math.PI * 2)) % 1 + 1) % 1 * NS;
    const i0 = Math.floor(u) % NS, i1 = (i0 + 1) % NS, f = u - Math.floor(u);
    const lvl = sstep(0.82, 0.62, p.y); // oben Knochen 1, unten Knochen 2
    const leg = 0.42 * sstep(0.1, 0.8, t);
    const sideL = sstep(-0.02, 0.06, p.x), sideR = sstep(-0.02, 0.06, -p.x);
    const hipsW = Math.pow(1 - t, 3);
    const cloth = Math.max(0, 1 - leg - hipsW);
    const out = [[S.hips, hipsW], [S.L.leg.up, leg * sideL], [S.R.leg.up, leg * sideR]];
    const b0 = skirtBones[i0].bones, b1 = skirtBones[i1].bones;
    out.push([lvl < 0.5 ? b0[0] : b0[1], cloth * (1 - f)], [lvl < 0.5 ? b1[0] : b1[1], cloth * f]);
    return out;
  };
  rb.addWeighted(makeDress(77, 0.6, 1.0, 0.13), dress, dressW);
  rb.addWeighted(makeDress(91, 0.52, 0.93, 0.1), dressInner, dressW);              // längere Unterlage, zerfetzt
  // Träger
  for (const s of [1, -1]) {
    rb.add(capsule(V(0.07 * s, 1.43, 0.06), V(0.12 * s, 1.505, 0.0), 0.009, 8), dress, S.chest);
    rb.add(capsule(V(0.12 * s, 1.505, 0.0), V(0.08 * s, 1.43, -0.06), 0.009, 8), dress, S.chest);
  }

  // ---- Haare: Kappe + nasse, verklebte Strähnen; Haarknochen-Ketten für Bewegung ----
  const C = V(0, HY + 0.002, -0.004), RH = V(0.088, 0.112, 0.104);
  const cap = new THREE.SphereGeometry(1, 40, 28);
  {
    const p = cap.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      // Gesicht freilassen: vorne unterhalb des Haaransatzes im Schädel verstecken
      const face = sstep(0.1, 0.5, v.z) * sstep(0.62, 0.3, v.y);
      const k = 1.03 - 0.25 * face;
      pos3(v, C, RH, k);
      p.setXYZ(i, v.x, v.y, v.z);
    }
    cap.computeVertexNormals();
  }
  rb.add(cap, hair, S.head);

  // Haarketten (Sektoren nach Winkel) mit 4 Knochen
  const NH = 10;
  const hrnd = mulberry32(4242);
  const clumps = [];
  const nClumps = 84;
  for (let c = 0; c < nClumps; c++) {
    let phi = (c / nClumps) * Math.PI * 2 + (hrnd() - 0.5) * 0.08;
    phi = Math.atan2(Math.sin(phi), Math.cos(phi));
    const front = Math.cos(phi);
    // Scheitel vorne: Lücke in der Mitte, damit ein schmaler Streifen Gesicht sichtbar bleibt
    if (Math.abs(phi) < 0.2) phi = Math.sign(phi || 1) * (0.2 + Math.abs(phi) * 0.5);
    const theta0 = front > 0.6 ? 0.1 + hrnd() * 0.25 : 0.12 + hrnd() * 0.45;
    const yEnd = front > 0.3 ? 1.2 - hrnd() * 0.12 : front > -0.4 ? 1.16 - hrnd() * 0.1 : 1.04 - hrnd() * 0.1;
    clumps.push({ phi, theta0, yEnd, n: 3 + Math.floor(hrnd() * 3) });
  }
  // Körperhülle, über die die Haare fallen (vorne oder hinten über die Schulter)
  const bodyHalf = (y) => {
    if (y > 1.6) return [0.04, 0.045];
    if (y > 1.5) { const t = sstep(1.6, 1.5, y); return [lerp(0.05, 0.2, t), lerp(0.055, 0.11, t)]; }
    if (y > 1.3) return [0.19, 0.11];
    return [0.17, 0.105];
  };
  const pathFor = (cl, jit) => {
    const pts = [];
    const { phi } = cl;
    const sx = Math.sin(phi), cz = Math.cos(phi);
    const thetaE = Math.PI / 2 + (cz > 0.5 ? -0.05 : 0.12);
    for (let k = 0; k <= 4; k++) {
      const th = lerp(cl.theta0, thetaE, k / 4);
      const v = V(Math.sin(th) * sx, Math.cos(th), Math.sin(th) * cz);
      pos3(v, C, RH, 1.045 + jit.r);
      pts.push(v);
    }
    const e = pts[pts.length - 1];
    const drop = e.y - cl.yEnd;
    const steps = 9;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const y = e.y - drop * t;
      const flare = 1 + 0.35 * t * (cz > 0.3 ? 0.6 : 1);
      let x = e.x * flare + jit.x * (1 - t * 0.7) + 0.006 * Math.sin(t * 9 + jit.w);
      let z = e.z * flare + jit.z * (1 - t * 0.7) + 0.006 * Math.cos(t * 7 + jit.w);
      // nach vorne bzw. hinten aus dem Körper schieben
      const [hw, hd] = bodyHalf(y);
      const q = (x / hw) * (x / hw);
      if (q < 1) {
        const need = hd * Math.sqrt(1 - q) + 0.012;
        if (cz >= -0.05) z = Math.max(z, need); else z = Math.min(z, -need);
      }
      if (cz > 0.5 && y > 1.55) z = Math.max(z, 0.108 + 0.01 * (1 - Math.abs(x) / 0.09)); // vor dem Gesicht
      pts.push(V(x, y, z));
    }
    return pts;
  };
  const hairChains = [];
  const sectorClumps = Array.from({ length: NH }, () => []);
  const sectorOf = (phi) => Math.floor((((phi / (Math.PI * 2)) % 1 + 1) % 1) * NH + 0.5) % NH;
  const strands = [];
  for (const cl of clumps) {
    const base = pathFor(cl, { x: 0, z: 0, r: 0, w: hrnd() * 6 });
    sectorClumps[sectorOf(cl.phi)].push(base);
    for (let s = 0; s < cl.n; s++) {
      const jit = { x: (hrnd() - 0.5) * 0.012, z: (hrnd() - 0.5) * 0.008, r: hrnd() * 0.02, w: hrnd() * 6 };
      const pts = pathFor({ ...cl, yEnd: cl.yEnd - hrnd() * 0.05, theta0: cl.theta0 + (hrnd() - 0.5) * 0.15 }, jit);
      strands.push({ pts, sector: sectorOf(cl.phi), r: 0.0042 + hrnd() * 0.0025 });
    }
  }
  const HL = [1.66, 1.52, 1.38, 1.22];
  sectorClumps.forEach((list, k) => {
    let parent = S.head;
    const chain = [];
    const at = (y) => {
      if (!list.length) { const a = (k / NH) * Math.PI * 2; return V(Math.sin(a) * 0.12, y, Math.cos(a) * 0.12); }
      const acc = V(0, 0, 0);
      for (const pts of list) {
        let best = pts[0];
        for (const p of pts) if (Math.abs(p.y - y) < Math.abs(best.y - y)) best = p;
        acc.add(best);
      }
      return acc.multiplyScalar(1 / list.length).setY(y);
    };
    HL.forEach((y, j) => {
      const b = rb.bone(`Haar${k + 1}_${j + 1}`, at(y), parent);
      chain.push(b);
      parent = b;
    });
    const a = (k / NH) * Math.PI * 2;
    const dir = V(Math.sin(a), 0, Math.cos(a));
    hairChains.push({ bones: chain, dir, lateral: new THREE.Vector3().crossVectors(V(0, -1, 0), dir).normalize() });
  });
  const hairW = (sector) => (p) => {
    const ch = hairChains[sector].bones;
    if (p.y >= HL[0]) return [[S.head, 1]];
    for (let j = 0; j < HL.length - 1; j++) {
      if (p.y >= HL[j + 1]) {
        const t = (HL[j] - p.y) / (HL[j] - HL[j + 1]);
        if (j === 0) { const h = 0.5 * (1 - t), c1 = 0.4 * t; return [[S.head, h], [ch[0], 1 - h - c1], [ch[1], c1]]; }
        return [[ch[j], 1 - t], [ch[j + 1], t]];
      }
    }
    return [[ch[HL.length - 1], 1]];
  };
  for (const st of strands) {
    const curve = new THREE.CatmullRomCurve3(st.pts, false, 'centripetal');
    const T = 30, Rr = 5;
    const g = new THREE.TubeGeometry(curve, T, st.r, Rr, false);
    // zur Spitze dünner, leicht abgeflacht
    const p = g.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i <= T; i++) {
      const u = i / T;
      const c = curve.getPointAt(u);
      const k = 1 - 0.75 * Math.pow(u, 1.4);
      for (let j = 0; j <= Rr; j++) {
        const idx = i * (Rr + 1) + j;
        v.fromBufferAttribute(p, idx).sub(c).multiplyScalar(k);
        v.z *= 0.7;
        p.setXYZ(idx, c.x + v.x, c.y + v.y, c.z + v.z);
      }
    }
    g.computeVertexNormals();
    rb.addWeighted(g, hair, hairW(st.sector));
  }

  const g = rb.finish();
  // in Ruhe leicht geöffneter Mund
  S.jaw.rotation.x = 0.12;
  RIGS.set(g, { type: 'humanoid', flavor: 'ghost', ...S, fingers, hair: hairChains, skirt: skirtBones });
  return g;
}

/** Punkt auf Einheitskugel → Ellipsoid um C mit Radien R, Faktor k */
function pos3(v, C, R, k) {
  v.set(C.x + v.x * R.x * k, C.y + v.y * R.y * k, C.z + v.z * R.z * k);
  return v;
}
