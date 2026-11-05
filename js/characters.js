// Geriggte Figuren: Mensch, Rostbär (eigener Animatronik-Bär) und „Der Lange“ (eigene, gesichtslose Schattenfigur).
// Alle Figuren schauen nach +Z, stehen auf y = 0 und haben ein humanoides Skelett (siehe RIGS → animator.js).
import * as THREE from 'three';
import { RigBuilder, V, capsule, taper, blob, box, torso } from './rigkit.js';
import { RIGS } from './rig-registry.js';
import { furTexture, softBlob } from './spider.js';

/**
 * Humanoides Skelett aus Gelenkpositionen.
 * P: { hips, spine, chest, neck, head, jaw?, shoulder:[x,y,z], elbow, wrist, handEnd, hip:[x,y,z], knee, ankle, toe }
 * Arm-/Beinpositionen werden für die linke Seite (+X) angegeben und gespiegelt.
 */
export function humanoidSkeleton(rb, P) {
  const root = rb.bone('Root', V(0, 0, 0));
  const hips = rb.bone('Hips', P.hips, root);
  const spine = rb.bone('Spine', P.spine, hips);
  const chest = rb.bone('Chest', P.chest, spine);
  const neck = rb.bone('Neck', P.neck, chest);
  const head = rb.bone('Head', P.head, neck);
  const jaw = P.jaw ? rb.bone('Jaw', P.jaw, head) : null;
  const side = (s, name) => {
    const m = (p) => V(p[0] * s, p[1], p[2]);
    const n = s > 0 ? 'Left' : 'Right';
    const upper = rb.bone(`${n}UpperArm`, m(P.shoulder), chest);
    const fore = rb.bone(`${n}ForeArm`, m(P.elbow), upper);
    const hand = rb.bone(`${n}Hand`, m(P.wrist), fore);
    const up = rb.bone(`${n}UpLeg`, m(P.hip), hips);
    const low = rb.bone(`${n}Leg`, m(P.knee), up);
    const foot = rb.bone(`${n}Foot`, m(P.ankle), low);
    return { arm: { upper, fore, hand }, leg: { up, low, foot }, m, name };
  };
  const L = side(1), R = side(-1);
  return { root, hips, spine, chest, neck, head, jaw, L, R };
}

const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0, ...extra });

// ---------------------------------------------------------------------------
// Mensch
// ---------------------------------------------------------------------------
export function createHuman() {
  const rb = new RigBuilder('Mensch');
  const P = {
    hips: V(0, 0.95, 0), spine: V(0, 1.06, 0), chest: V(0, 1.28, 0), neck: V(0, 1.47, 0), head: V(0, 1.56, 0),
    shoulder: [0.2, 1.42, 0], elbow: [0.235, 1.17, -0.01], wrist: [0.255, 0.93, 0.02],
    hip: [0.095, 0.93, 0], knee: [0.105, 0.5, 0.01], ankle: [0.11, 0.09, -0.01],
  };
  const S = humanoidSkeleton(rb, P);
  const skin = std('#d9a27f', { roughness: 0.6, name: 'Haut' });
  const shirt = std('#3e6fb0', { roughness: 0.85, name: 'Shirt' });
  const pants = std('#2f3542', { roughness: 0.9, name: 'Hose' });
  const shoes = std('#1d1d1f', { roughness: 0.5, name: 'Schuhe' });
  const hair = std('#3b2a1e', { roughness: 0.8, name: 'Haare' });
  const white = std('#f4f4f4', { roughness: 0.3, name: 'Augen' });
  const dark = std('#1a1410', { roughness: 0.3, name: 'Pupillen' });

  rb.add(blob(V(0, 0.96, 0), 0.165, 0.115, 0.105), pants, S.hips);
  rb.add(torso(1.0, 1.16, 0.15, 0.66), shirt, S.spine);
  rb.add(torso(1.2, 1.32, 0.18, 0.6), shirt, S.chest);
  for (const s of [1, -1]) rb.add(blob(V(0.18 * s, 1.41, 0), 0.07, 0.06, 0.068), shirt, S.chest);
  rb.add(capsule(V(0, 1.45, 0), V(0, 1.56, 0.005), 0.05), skin, S.neck);
  // Kopf
  const HY = 1.68;
  rb.add(blob(V(0, HY, 0.01), 0.1, 0.125, 0.11), skin, S.head);
  const cap = new THREE.SphereGeometry(0.113, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.55);
  cap.scale(1, 1.08, 1.05); cap.rotateX(-0.25); cap.translate(0, HY + 0.015, -0.008);
  rb.add(cap, hair, S.head);
  rb.add(blob(V(0, HY - 0.015, 0.115), 0.016, 0.022, 0.02), skin, S.head);           // Nase
  for (const s of [1, -1]) {
    rb.add(blob(V(0.1 * s, HY - 0.005, 0), 0.016, 0.03, 0.02), skin, S.head);        // Ohren
    rb.add(blob(V(0.038 * s, HY + 0.017, 0.093), 0.017, 0.012, 0.01), white, S.head);// Augen
    rb.add(blob(V(0.038 * s, HY + 0.017, 0.1), 0.008, 0.008, 0.005), dark, S.head);
    rb.add(box(V(0.04 * s, HY + 0.045, 0.1), 0.035, 0.007, 0.01, [0, 0, -0.1 * s]), hair, S.head); // Augenbrauen
  }
  rb.add(box(V(0, HY - 0.055, 0.104), 0.04, 0.006, 0.01), dark, S.head);              // Mund
  // Arme, Hände, Beine, Füße
  for (const X of [S.L, S.R]) {
    const m = X.m;
    rb.add(capsule(m(P.shoulder), m(P.elbow), 0.05), shirt, X.arm.upper);
    rb.add(capsule(m(P.elbow), m(P.wrist), 0.04), skin, X.arm.fore);
    rb.add(blob(m([0.262, 0.865, 0.025]), 0.032, 0.065, 0.022), skin, X.arm.hand);
    rb.add(blob(m([0.262, 0.885, 0.05]), 0.012, 0.03, 0.012, [0.4, 0, 0]), skin, X.arm.hand); // Daumen
    rb.add(capsule(m(P.hip), m(P.knee), 0.074), pants, X.leg.up);
    rb.add(capsule(m(P.knee), m(P.ankle), 0.057), pants, X.leg.low);
    rb.add(blob(m([0.115, 0.045, 0.06]), 0.052, 0.042, 0.125), shoes, X.leg.foot);
  }
  const g = rb.finish();
  RIGS.set(g, { type: 'humanoid', flavor: 'human', ...S });
  return g;
}

// ---------------------------------------------------------------------------
// Rostbär – eigener, abgenutzter Animatronik-Bär
// ---------------------------------------------------------------------------
let bearTex = null;
function bearTextures() {
  if (bearTex) return bearTex;
  const palette = ['#4e5541', '#6b7356', '#3a3f30', '#80876a', '#2c2f24'];
  const grime = (ctx, w, h, rnd) => {
    for (let i = 0; i < 40; i++) softBlob(ctx, rnd() * w, rnd() * h, (0.02 + rnd() * 0.06) * w, (0.02 + rnd() * 0.05) * h, '#22241b', rnd, 12);
    // Flicken mit Nähten
    for (let i = 0; i < 6; i++) {
      const x = rnd() * w, y = rnd() * h, s = (0.05 + rnd() * 0.05) * w;
      ctx.fillStyle = 'rgba(120,110,80,0.35)';
      ctx.fillRect(x, y, s, s * 0.8);
      ctx.strokeStyle = 'rgba(25,20,15,0.8)';
      ctx.lineWidth = Math.max(1, w / 400);
      for (let k = 0; k < s; k += s / 6) { ctx.beginPath(); ctx.moveTo(x + k, y - 3); ctx.lineTo(x + k + 3, y + 3); ctx.stroke(); }
    }
  };
  bearTex = {
    fur: furTexture({ w: 512, h: 512, seed: 91, base: '#5d6450', palette, pattern: grime, strokes: 16000, strokeLen: 9 }),
    light: furTexture({ w: 512, h: 512, seed: 92, base: '#8d8a68', palette: ['#a39f7c', '#77735a', '#5e5b45'], pattern: grime, strokes: 14000, strokeLen: 8 }),
  };
  return bearTex;
}

export function createAnimatronicBear() {
  const rb = new RigBuilder('Rostbär');
  const P = {
    hips: V(0, 0.9, 0), spine: V(0, 1.08, 0), chest: V(0, 1.36, 0), neck: V(0, 1.6, 0), head: V(0, 1.7, 0), jaw: V(0, 1.74, 0.1),
    shoulder: [0.36, 1.5, 0], elbow: [0.42, 1.16, 0.02], wrist: [0.44, 0.86, 0.06],
    hip: [0.15, 0.86, 0], knee: [0.16, 0.48, 0.02], ankle: [0.16, 0.13, 0],
  };
  const S = humanoidSkeleton(rb, P);
  const tex = bearTextures();
  const furM = (t, color = '#ffffff') => new THREE.MeshStandardMaterial({ color, map: t.map, normalMap: t.normalMap, roughness: 0.92 });
  const fur = furM(tex.fur); fur.name = 'Fell';
  const light = furM(tex.light); light.name = 'Fell hell';
  const metal = std('#8a8f94', { metalness: 1, roughness: 0.38, name: 'Metall' });
  const rust = std('#6a4430', { metalness: 0.6, roughness: 0.7, name: 'Rost' });
  const black = std('#0d0d0d', { roughness: 0.4, name: 'Schwarz' });
  const glow = std('#ff4a1c', { emissive: '#ff3b12', emissiveIntensity: 2.4, roughness: 0.3, name: 'Augenlicht' });
  const wireR = std('#9b2222', { roughness: 0.5, name: 'Kabel rot' });
  const wireB = std('#24508f', { roughness: 0.5, name: 'Kabel blau' });

  // Rumpf
  rb.add(blob(V(0, 0.9, 0), 0.28, 0.17, 0.24), fur, S.hips);
  rb.add(blob(V(0, 1.15, 0.02), 0.33, 0.36, 0.29), fur, S.spine);
  rb.add(blob(V(0, 1.12, 0.24), 0.23, 0.27, 0.07), light, S.spine);             // Bauchfleck
  rb.add(blob(V(0, 1.42, 0), 0.35, 0.24, 0.27), fur, S.chest);
  rb.add(taper(V(0, 1.55, 0), V(0, 1.72, 0), 0.07, 0.06), metal, S.neck);         // Metallhals
  for (let k = 0; k < 3; k++) rb.add(new THREE.TorusGeometry(0.075, 0.012, 8, 20).rotateX(Math.PI / 2).translate(0, 1.6 + k * 0.04, 0), rust, S.neck);
  // Kopf
  rb.add(blob(V(0, 1.86, 0), 0.25, 0.22, 0.22), fur, S.head);
  rb.add(blob(V(0, 1.8, 0.19), 0.135, 0.075, 0.11), light, S.head);              // Oberschnauze
  rb.add(blob(V(0, 1.83, 0.3), 0.05, 0.035, 0.035), black, S.head);              // Nase
  for (let k = -3; k <= 3; k++) rb.add(box(V(k * 0.028, 1.74, 0.27 - Math.abs(k) * 0.012), 0.018, 0.03, 0.012), metal, S.head); // obere Zähne
  for (const s of [1, -1]) {
    rb.add(blob(V(0.095 * s, 1.92, 0.17), 0.05, 0.045, 0.035), black, S.head);   // Augenhöhlen
    rb.add(blob(V(0.095 * s, 1.92, 0.2), 0.018, 0.018, 0.012), glow, S.head);    // glühende Augen
    rb.add(box(V(0.095 * s, 1.985, 0.19), 0.09, 0.018, 0.03, [0, 0, 0.32 * s]), black, S.head); // Brauen
    const ear = blob(V(0.18 * s, 2.06, -0.02), 0.085, 0.085, 0.035, [0, 0, -0.3 * s]);
    rb.add(ear, fur, S.head);
    rb.add(blob(V(0.18 * s, 2.06, 0.005), 0.05, 0.05, 0.02, [0, 0, -0.3 * s]), light, S.head);
  }
  // Unterkiefer (eigener Knochen)
  rb.add(blob(V(0, 1.7, 0.18), 0.12, 0.045, 0.1), light, S.jaw);
  for (let k = -3; k <= 3; k++) rb.add(box(V(k * 0.027, 1.74, 0.25 - Math.abs(k) * 0.012), 0.016, 0.026, 0.012), metal, S.jaw);
  rb.add(blob(V(0, 1.72, 0.12), 0.08, 0.02, 0.06), black, S.jaw);                // Rachen
  // Arme – rechts mit freiliegendem Endoskelett
  for (const X of [S.L, S.R]) {
    const m = X.m, right = X === S.R;
    rb.add(capsule(m(P.shoulder), m(P.elbow), 0.09), fur, X.arm.upper);
    rb.add(blob(m(P.elbow), 0.07, 0.07, 0.07), right ? metal : fur, X.arm.fore);
    if (right) {
      rb.add(capsule(m(P.elbow), m(P.wrist), 0.032), metal, X.arm.fore);
      rb.add(capsule(m([0.45, 1.12, 0.0]), m([0.47, 0.9, 0.09]), 0.009), wireR, X.arm.fore);
      rb.add(capsule(m([0.4, 1.1, 0.05]), m([0.43, 0.9, 0.03]), 0.008), wireB, X.arm.fore);
      rb.add(new THREE.CylinderGeometry(0.075, 0.08, 0.06, 18).translate(m(P.elbow).x, 1.08, 0.03), fur, X.arm.fore); // zerrissener Ärmel
    } else {
      rb.add(capsule(m(P.elbow), m(P.wrist), 0.078), fur, X.arm.fore);
    }
    rb.add(blob(m([0.45, 0.78, 0.07]), 0.075, 0.095, 0.065), right ? metal : fur, X.arm.hand);
    for (let f = -1; f <= 1; f++) rb.add(blob(m([0.45 + f * 0.035, 0.69, 0.1]), 0.022, 0.035, 0.022), right ? rust : black, X.arm.hand);
    rb.add(capsule(m(P.hip), m(P.knee), 0.115), fur, X.leg.up);
    rb.add(capsule(m(P.knee), m(P.ankle), 0.095), fur, X.leg.low);
    rb.add(new THREE.TorusGeometry(0.075, 0.015, 8, 20).rotateX(Math.PI / 2).translate(m(P.ankle).x, 0.15, 0), rust, X.leg.low);
    rb.add(blob(m([0.16, 0.07, 0.07]), 0.105, 0.07, 0.18), fur, X.leg.foot);
    rb.add(blob(m([0.16, 0.05, 0.22]), 0.07, 0.035, 0.04), light, X.leg.foot);
  }
  const g = rb.finish();
  RIGS.set(g, { type: 'humanoid', flavor: 'animatronic', ...S });
  return g;
}

// ---------------------------------------------------------------------------
// „Der Lange“ – eigene, gesichtslose Schattenfigur
// ---------------------------------------------------------------------------
export function createTallOne() {
  const rb = new RigBuilder('Der Lange');
  const P = {
    hips: V(0, 1.45, 0), spine: V(0, 1.65, 0), chest: V(0, 1.95, 0), neck: V(0, 2.28, 0), head: V(0, 2.4, 0),
    shoulder: [0.2, 2.18, 0], elbow: [0.24, 1.64, -0.02], wrist: [0.26, 1.1, 0.02],
    hip: [0.09, 1.42, 0], knee: [0.09, 0.76, 0.01], ankle: [0.09, 0.08, -0.01],
  };
  const S = humanoidSkeleton(rb, P);
  const coat = std('#141418', { roughness: 0.85, name: 'Mantel' });
  const shirt = std('#2a2a30', { roughness: 0.8, name: 'Hemd' });
  const pale = std('#e6e3de', { roughness: 0.55, name: 'Haut' });
  const shoe = std('#050506', { roughness: 0.35, name: 'Schuhe' });
  const shadow = std('#07070a', { roughness: 0.6, name: 'Schatten' });

  rb.add(blob(V(0, 1.47, 0), 0.15, 0.1, 0.1), coat, S.hips);
  // kurzer Mantelschoß
  rb.add(new THREE.CylinderGeometry(0.17, 0.22, 0.32, 20, 1, true).translate(0, 1.3, 0), coat, S.hips);
  rb.add(torso(1.5, 1.82, 0.14, 0.66), coat, S.spine);
  rb.add(torso(1.84, 2.1, 0.17, 0.6), coat, S.chest);
  rb.add(blob(V(0, 2.0, 0.085), 0.045, 0.2, 0.025), shirt, S.chest);
  for (const s of [1, -1]) rb.add(blob(V(0.17 * s, 2.16, 0), 0.07, 0.05, 0.07), coat, S.chest);
  rb.add(blob(V(0, 2.22, 0), 0.09, 0.05, 0.08), shirt, S.chest);                  // hoher Kragen
  rb.add(capsule(V(0, 2.25, 0), V(0, 2.4, 0), 0.04), pale, S.neck);
  rb.add(blob(V(0, 2.52, 0.005), 0.11, 0.155, 0.125), pale, S.head);              // gesichtsloser Kopf
  for (const X of [S.L, S.R]) {
    const m = X.m;
    rb.add(capsule(m(P.shoulder), m(P.elbow), 0.04), coat, X.arm.upper);
    rb.add(capsule(m(P.elbow), m(P.wrist), 0.034), coat, X.arm.fore);
    rb.add(blob(m([0.262, 1.05, 0.02]), 0.03, 0.055, 0.016), pale, X.arm.hand);
    for (let f = 0; f < 4; f++) {                                                  // überlange Finger
      const x = 0.245 + f * 0.013;
      rb.add(capsule(m([x, 1.0, 0.02 + (f - 1.5) * 0.008]), m([x + 0.005, 0.84 - (f === 1 || f === 2 ? 0.03 : 0), 0.03]), 0.0065, 8), pale, X.arm.hand);
    }
    rb.add(capsule(m(P.hip), m(P.knee), 0.05), coat, X.leg.up);
    rb.add(capsule(m(P.knee), m(P.ankle), 0.042), coat, X.leg.low);
    rb.add(blob(m([0.09, 0.04, 0.07]), 0.042, 0.035, 0.14), shoe, X.leg.foot);
  }
  // Schattententakel am Rücken
  const tendrils = [];
  const dirs = [[0.7, 0.55], [-0.7, 0.55], [0.85, -0.15], [-0.85, -0.15]];
  dirs.forEach(([dx, dy], k) => {
    let parent = S.chest;
    let p = V(0.06 * Math.sign(dx), 2.05, -0.1);
    const d = V(dx, dy, -0.45).normalize();
    const chain = [];
    for (let j = 0; j < 6; j++) {
      const b = rb.bone(`Tentakel${k + 1}_${j + 1}`, p, parent);
      chain.push(b);
      // hängen in Ruhe nach unten durch
      const seg = d.clone().multiplyScalar(0.19).add(V(0, -0.07 * j, -0.015));
      const q = p.clone().add(seg);
      rb.add(taper(p, q, 0.032 * (1 - j / 7), 0.032 * (1 - (j + 1) / 7) + 0.003, 10), shadow, b);
      rb.add(blob(p, 0.032 * (1 - j / 7), 0.032 * (1 - j / 7), 0.032 * (1 - j / 7), null, [12, 8]), shadow, b);
      p = q;
      parent = b;
    }
    tendrils.push({ bones: chain, dir: d, lateral: new THREE.Vector3().crossVectors(d, V(0, 1, 0)).normalize() });
  });
  const g = rb.finish();
  RIGS.set(g, { type: 'humanoid', flavor: 'shadow', tendrils, ...S });
  return g;
}
