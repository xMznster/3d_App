// Automatische Bein-Erkennung & prozedurale Animationen (Laufen / Idle)
// Läuft komplett auf dem Gerät. Vier Wege, je nach Modell:
//  1. bekanntes Skelett (z. B. die Wolfsspinne)            → artgerechter Spinnengang
//  2. Skelett aus der Datei (GLB/GLTF mit Knochen)          → Beinketten werden am Knochenbaum erkannt
//  3. Modell aus Einzelteilen                                → beinartige Teile werden erkannt und bekommen Gelenke
//  4. ein einziges Mesh (z. B. STL/OBJ)                      → Füße, Hüfthöhe und Beine werden aus der
//                                                               Geometrie bestimmt und ein Skelett wird eingebaut
// Die Bewegungen werden als AnimationClips "gebacken" – dadurch laufen sie flüssig über den
// AnimationMixer und lassen sich als GLB mit Animation exportieren.
import * as THREE from 'three';
import { RIGS } from './rig-registry.js';

const UP = new THREE.Vector3(0, 1, 0);
const XAXIS = new THREE.Vector3(1, 0, 0);
const TAU = Math.PI * 2;
const frac = (x) => x - Math.floor(x);
const smooth = (x) => x * x * (3 - 2 * x);
const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** Weiche Kurve durch Stützpunkte [[t, wert], …] */
function key(t, pts) {
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i][0]) {
      const [t0, v0] = pts[i - 1], [t1, v1] = pts[i];
      return v0 + (v1 - v0) * smooth((t - t0) / (t1 - t0));
    }
  }
  return pts[pts.length - 1][1];
}
/** Deterministischer Pseudozufall 0..1 (gleiche Animation bei jedem Erzeugen) */
function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// ---------------------------------------------------------------------------
// Gelenke & Hilfen
// ---------------------------------------------------------------------------
/** Gelenk mit Ruhelage. Achsen werden in Modell-/Weltrichtung angegeben und in den Elternraum umgerechnet. */
function joint(node) {
  node.updateWorldMatrix(true, false);
  const pInv = node.parent ? node.parent.getWorldQuaternion(new THREE.Quaternion()).invert() : new THREE.Quaternion();
  return { node, pInv };
}
const _q = new THREE.Quaternion();
const _a = new THREE.Vector3();
function rot(j, axisWorld, angle) {
  if (!j || !angle) return;
  _a.copy(axisWorld).applyQuaternion(j.pInv).normalize();
  j.node.quaternion.premultiply(_q.setFromAxisAngle(_a, angle));
}
/** Verschiebung (in Weltrichtung/-einheiten) im lokalen Raum des Elternknotens */
function localOffset(node, worldVec) {
  node.updateWorldMatrix(true, false);
  const p = node.parent;
  const w = node.getWorldPosition(new THREE.Vector3());
  const a = p.worldToLocal(w.clone());
  const b = p.worldToLocal(w.clone().add(worldVec));
  return b.sub(a);
}

function snapshot(nodes) {
  const data = [...new Set(nodes)].filter(Boolean).map((n) => ({ n, p: n.position.clone(), q: n.quaternion.clone(), s: n.scale.clone() }));
  return () => data.forEach(({ n, p, q, s }) => { n.position.copy(p); n.quaternion.copy(q); n.scale.copy(s); });
}

/** Animierte Knoten brauchen eindeutige, gültige Namen (Spuren werden über Namen gebunden) */
function ensureNames(root, nodes) {
  const used = new Map();
  root.traverse((o) => { if (o.name) used.set(o.name, (used.get(o.name) || 0) + 1); });
  let k = 0;
  for (const n of nodes) {
    let name = THREE.PropertyBinding.sanitizeNodeName(n.name || '');
    if (!name || name !== n.name || used.get(n.name) > 1) {
      const base = name || 'Gelenk';
      do { name = `${base}_${++k}`; } while (used.has(name));
      if (n.name) used.set(n.name, used.get(n.name) - 1);
      n.name = name;
      used.set(name, 1);
    }
  }
}

/**
 * Bewegung abtasten und als AnimationClip speichern.
 * tracks: [{ node, q?: true, p?: true, s?: true }]
 */
function bakeClip(name, duration, tracks, restore, pose, fps = 30) {
  const frames = Math.max(2, Math.round(duration * fps) + 1);
  const times = new Float32Array(frames);
  const buf = tracks.map((t) => ({ q: t.q ? new Float32Array(frames * 4) : null, p: t.p ? new Float32Array(frames * 3) : null, s: t.s ? new Float32Array(frames * 3) : null }));
  for (let f = 0; f < frames; f++) {
    const t = (f / (frames - 1)) * duration;
    times[f] = t;
    restore();
    pose(t % duration === 0 && f === frames - 1 ? duration : t);
    tracks.forEach((tr, i) => {
      if (buf[i].q) tr.node.quaternion.toArray(buf[i].q, f * 4);
      if (buf[i].p) tr.node.position.toArray(buf[i].p, f * 3);
      if (buf[i].s) tr.node.scale.toArray(buf[i].s, f * 3);
    });
  }
  restore();
  const kf = [];
  tracks.forEach((tr, i) => {
    if (buf[i].q) kf.push(new THREE.QuaternionKeyframeTrack(`${tr.node.name}.quaternion`, times, buf[i].q));
    if (buf[i].p) kf.push(new THREE.VectorKeyframeTrack(`${tr.node.name}.position`, times, buf[i].p));
    if (buf[i].s) kf.push(new THREE.VectorKeyframeTrack(`${tr.node.name}.scale`, times, buf[i].s));
  });
  return new THREE.AnimationClip(name, duration, kf);
}

/** Schrittkurve: Stemmphase (Fuß am Boden, wandert nach hinten) und Schwungphase (Fuß angehoben, nach vorne) */
function stepCurve(p, duty) {
  if (p < duty) return { fwd: 1 - 2 * (p / duty), lift: 0 };
  const v = (p - duty) / (1 - duty);
  return { fwd: -1 + 2 * smooth(v), lift: Math.sin(Math.PI * v) };
}

/** Gangart: Phasen je Bein abhängig von Anzahl und Lage der Beine */
function assignPhases(legs) {
  const n = legs.length;
  const cx = legs.reduce((s, l) => s + l.pos.x, 0) / n;
  for (const l of legs) l.side = l.side ?? (l.pos.x >= cx ? 1 : -1);
  const bySide = (s) => legs.filter((l) => l.side === s).sort((a, b) => b.pos.z - a.pos.z); // vorne zuerst
  const R = bySide(1), L = bySide(-1);
  if (n === 2) { legs.forEach((l) => { l.phase = l.side > 0 ? 0.5 : 0; }); return 'Zweibeiner'; }
  if (n === 4 && R.length === 2 && L.length === 2) {
    // Schrittfolge eines Vierbeiners: hinten links, vorne links, hinten rechts, vorne rechts
    L[1].phase = 0; L[0].phase = 0.25; R[1].phase = 0.5; R[0].phase = 0.75;
    return 'Vierbeiner';
  }
  // Mehrbeiner: abwechselnde Dreier-/Vierergruppen
  R.forEach((l, k) => { l.phase = (k % 2) * 0.5; });
  L.forEach((l, k) => { l.phase = ((k + 1) % 2) * 0.5; });
  return n === 6 ? 'Sechsbeiner' : n === 8 ? 'Achtbeiner' : `${n} Beine`;
}

// ---------------------------------------------------------------------------
// 1. Spinnen-Skelett (artgerechter Wechselgang)
// ---------------------------------------------------------------------------
function analyzeArachnid(root, rig) {
  root.updateMatrixWorld(true);
  const legs = rig.legs.map((l) => ({ ...l, j: l.bones.map(joint) }));
  const palps = rig.palps.map((p) => ({ ...p, j: p.bones.map(joint) }));
  const body = joint(rig.body), abd = joint(rig.abdomen), chel = joint(rig.chelicerae);
  const animated = [rig.body, rig.abdomen, rig.chelicerae, rig.web, ...legs.flatMap((l) => [0, 2, 3, 4, 5].map((k) => l.bones[k])), ...palps.flatMap((p) => [p.bones[1], p.bones[3]])];
  ensureNames(root, animated);
  const restore = snapshot(animated);
  const bodyRestY = rig.body.position.y;
  const bodyRestZ = rig.body.position.z;
  const tracks = [
    { node: rig.body, q: true, p: true }, { node: rig.abdomen, q: true, s: true }, { node: rig.chelicerae, q: true },
    ...(rig.web ? [{ node: rig.web, s: true }] : []),
    ...legs.flatMap((l) => [0, 2, 3, 4, 5].map((k) => ({ node: l.bones[k], q: true }))),
    ...palps.flatMap((p) => [{ node: p.bones[1], q: true }, { node: p.bones[3], q: true }]),
  ];
  const AMP = [0.21, 0.17, 0.17, 0.2];

  const T = 0.9;
  const walk = bakeClip('Laufen', T, tracks, restore, (t) => {
    const g = t / T;
    for (const l of legs) {
      const groupA = (l.side < 0) === (l.index % 2 === 0); // L1, R2, L3, R4 gemeinsam
      const { fwd, lift } = stepCurve(frac(g + (groupA ? 0 : 0.5)), 0.55);
      rot(l.j[0], UP, -l.side * AMP[l.index] * fwd);
      rot(l.j[2], l.lateral, 0.42 * lift);
      rot(l.j[3], l.lateral, -0.15 * lift);
      rot(l.j[4], l.lateral, -0.2 * lift);
      rot(l.j[5], l.lateral, 0.12 * lift);
    }
    rig.body.position.y = bodyRestY + 0.007 * Math.sin(2 * TAU * g);
    rot(body, new THREE.Vector3(0, 0, 1), 0.015 * Math.sin(TAU * g));
    rot(body, UP, 0.02 * Math.sin(TAU * g));
    rot(abd, XAXIS, 0.03 * Math.sin(TAU * g + 0.8));
    rot(abd, UP, -0.035 * Math.sin(TAU * g));
    for (const p of palps) {
      const w = Math.sin(TAU * g + (p.side > 0 ? 0 : Math.PI));
      rot(p.j[1], p.lateral, 0.22 * w);
      rot(p.j[3], p.lateral, -0.15 * w);
    }
  });

  const D = 4;
  const bump = (t, a, b) => (t > a && t < b ? Math.sin(Math.PI * (t - a) / (b - a)) : 0);
  const idle = bakeClip('Idle', D, tracks, restore, (t) => {
    const w = TAU / D;
    rig.abdomen.scale.setScalar(1 + 0.02 * Math.sin(2 * w * t)); // Atmen
    rig.body.position.y = bodyRestY + 0.004 * Math.sin(w * t);
    rot(body, UP, 0.025 * Math.sin(w * t));
    rot(abd, XAXIS, 0.02 * Math.sin(w * t + 1));
    rot(chel, XAXIS, 0.05 * Math.sin(2 * w * t));
    for (const p of palps) {
      const s = Math.sin(2 * w * t + (p.side > 0 ? 0 : Math.PI));
      rot(p.j[1], p.lateral, 0.16 * s);
      rot(p.j[3], p.lateral, -0.2 * Math.max(0, s));
    }
    for (const l of legs) {
      rot(l.j[2], l.lateral, 0.012 * Math.sin(w * t + l.index + l.side));
      const tap = l.index === 0 ? (l.side > 0 ? bump(t, 0.9, 1.7) : bump(t, 2.4, 3.2)) : 0; // Vorderbeine tasten
      if (tap) {
        rot(l.j[0], UP, -l.side * 0.12 * tap);
        rot(l.j[2], l.lateral, 0.38 * tap);
        rot(l.j[4], l.lateral, -0.25 * tap);
      }
    }
  });

  // --- Aktionen ---
  const front = (l) => l.index === 0 ? 1 : l.index === 1 ? 0.65 : 0;
  const attack = bakeClip('Angriff', 1.5, tracks, restore, (t) => {
    const r = key(t, [[0, 0], [0.35, 1], [0.5, 0.3], [0.9, 0.2], [1.5, 0]]); // aufbäumen
    const L = key(t, [[0, 0], [0.36, 0], [0.48, 1], [0.8, 1], [1.5, 0]]);     // zustoßen
    rot(body, XAXIS, -0.32 * r + 0.1 * L);
    rig.body.position.y = bodyRestY + 0.05 * r;
    rig.body.position.z = bodyRestZ + 0.14 * L;
    rot(abd, XAXIS, -0.1 * r);
    rot(chel, XAXIS, -0.45 * r + 0.15 * L);
    for (const l of legs) {
      const f = front(l);
      if (!f) continue;
      rot(l.j[0], UP, -l.side * 0.25 * r * f);
      rot(l.j[2], l.lateral, (0.95 * r - 0.35 * L) * f);
      rot(l.j[4], l.lateral, -0.45 * r * f);
    }
    for (const p of palps) rot(p.j[1], p.lateral, 0.55 * r);
  });

  const web = bakeClip('Netz spinnen', 5, tracks, restore, (t) => {
    const e = key(t, [[0, 0], [0.5, 1], [4.3, 1], [5, 0]]);
    rot(abd, XAXIS, 0.45 * e);                                   // Hinterleib hoch
    rot(abd, UP, 0.28 * e * Math.sin(TAU * 1.2 * t));            // Spinnwarzen hin und her
    rot(body, XAXIS, 0.08 * e);
    for (const l of legs) {
      if (l.index !== 3) continue;                               // Hinterbeine ziehen den Faden
      const v = Math.max(0, Math.sin(TAU * 1.2 * t + (l.side > 0 ? 0 : Math.PI)));
      rot(l.j[0], UP, l.side * 0.28 * e * v);
      rot(l.j[2], l.lateral, 0.4 * e * v);
    }
    if (rig.web) rig.web.scale.setScalar(Math.max(0.001, key(t, [[0, 0.001], [0.5, 0.001], [4, 1], [5, 1]])));
  });

  const threat = bakeClip('Drohen', 2.6, tracks, restore, (t) => {
    const e = key(t, [[0, 0], [0.4, 1], [2.1, 1], [2.6, 0]]);
    rot(body, XAXIS, -0.26 * e);
    rot(body, UP, 0.12 * e * Math.sin(TAU * 1.5 * t));
    rig.body.position.y = bodyRestY + 0.05 * e;
    rot(chel, XAXIS, -0.35 * e);
    for (const l of legs) {
      const f = front(l);
      if (!f) continue;
      rot(l.j[0], UP, -l.side * 0.12 * e);
      rot(l.j[2], l.lateral, 1.15 * e * f);
      rot(l.j[4], l.lateral, -0.25 * e * f);
      rot(l.j[5], l.lateral, 0.15 * e * Math.sin(TAU * 3 * t) * f);
    }
    for (const p of palps) rot(p.j[1], p.lateral, 0.65 * e);
  });

  return {
    ok: true, method: 'Spinnen-Skelett', legs: legs.length, gait: 'Achtbeiner (Wechselgang)',
    clips: [
      { id: 'idle', name: 'Idle', clip: idle }, { id: 'walk', name: 'Laufen', clip: walk },
      { id: 'attack', name: 'Angriff', clip: attack, once: true },
      { id: 'web', name: 'Netz spinnen', clip: web, once: true },
      { id: 'threat', name: 'Drohen', clip: threat, once: true },
    ],
    restore,
  };
}

// ---------------------------------------------------------------------------
// 1b. Humanoide Figuren (Mensch, Rostbär, Der Lange)
// ---------------------------------------------------------------------------
const ZAXIS = new THREE.Vector3(0, 0, 1);

function analyzeHumanoid(root, rig) {
  root.updateMatrixWorld(true);
  const flavor = rig.flavor;
  const J = {};
  for (const k of ['root', 'hips', 'spine', 'chest', 'neck', 'head', 'jaw']) if (rig[k]) J[k] = joint(rig[k]);
  const sides = [
    { s: 1, ph: 0, ...rig.L }, // links (+X)
    { s: -1, ph: 0.5, ...rig.R },
  ].map((X) => ({
    s: X.s, ph: X.ph,
    upper: joint(X.arm.upper), fore: joint(X.arm.fore), hand: joint(X.arm.hand),
    up: joint(X.leg.up), low: joint(X.leg.low), foot: joint(X.leg.foot),
  }));
  const [Ls, Rs] = sides;
  const tendrils = (rig.tendrils || []).map((t) => ({ ...t, j: t.bones.map(joint) }));
  const hair = (rig.hair || []).map((h) => ({ ...h, j: h.bones.map(joint) }));
  const skirt = (rig.skirt || []).map((h) => ({ ...h, j: h.bones.map(joint) }));
  const fingers = rig.fingers ? [1, -1].map((s) => ({ s, list: rig.fingers[s > 0 ? 'L' : 'R'].map((f) => ({ ...f, pj: joint(f.prox), dj: joint(f.dist) })) })) : [];
  const nodes = [
    ...Object.values(J).map((j) => j.node),
    ...sides.flatMap((x) => [x.upper, x.fore, x.hand, x.up, x.low, x.foot].map((j) => j.node)),
    ...tendrils.flatMap((t) => t.bones),
    ...hair.flatMap((h) => h.bones),
    ...skirt.flatMap((h) => h.bones),
    ...fingers.flatMap((f) => f.list.flatMap((x) => [x.prox, x.dist])),
  ];
  ensureNames(root, nodes);
  const restore = snapshot(nodes);
  const tracks = nodes.map((node) => ({
    node, q: true,
    p: node === rig.root || node === rig.hips,
    s: node === rig.root,
  }));
  const hipsRest = rig.hips.position.clone();
  const rootRest = rig.root.position.clone();
  const tendrilSway = (t, amp, speed) => tendrils.forEach((td, k) => td.j.forEach((j, i) => {
    rot(j, td.lateral, amp * Math.sin(TAU * speed * t - i * 0.6 + k * 1.7));
    rot(j, UP, amp * 0.7 * Math.sin(TAU * speed * 0.7 * t + i * 0.4 + k));
  }));

  // --- Laufen ---
  const F = {
    human: { T: 1.1, A: 0.42, arm: 0.35, bob: 0.022, lean: 0.04, q: 0 },
    animatronic: { T: 1.4, A: 0.3, arm: 0.14, bob: 0.03, lean: 0.03, q: 18 },
    shadow: { T: 1.8, A: 0.34, arm: 0.05, bob: 0.012, lean: 0.1, q: 0 },
    ghost: { T: 2.3, A: 0.24, arm: 0.06, bob: 0.014, lean: 0.22, q: 0 },
  }[flavor] || { T: 1.1, A: 0.42, arm: 0.35, bob: 0.022, lean: 0.04, q: 0 };
  // --- Geisterfrau: Hilfen für Haare, Kleid, Finger und gebeugte Haltung ---
  const hairSway = (t, amp, speed, bias = 0) => hair.forEach((h, k) => h.j.forEach((j, i) => {
    const a = amp * (0.5 + i * 0.35);
    rot(j, XAXIS, bias * (0.6 + i * 0.3) + a * Math.sin(TAU * speed * t - i * 0.7 + k * 0.9));
    rot(j, ZAXIS, a * 0.6 * Math.sin(TAU * speed * 0.8 * t - i * 0.5 + k * 1.7));
  }));
  const skirtSway = (t, amp, speed, flare = 0) => skirt.forEach((sk, k) => sk.j.forEach((j, i) => {
    rot(j, sk.swing, flare * (i ? 0.6 : 1) + amp * (i ? 1.4 : 1) * Math.sin(TAU * speed * t - i * 0.9 + k * 0.8));
  }));
  const curl = (side, c, spread = 0, twitch = null) => {
    const F2 = fingers.find((f) => f.s === side);
    if (!F2) return;
    for (const f of F2.list) {
      const tw = twitch ? twitch(f.i) : 0;
      const k = f.thumb ? 0.5 : 1;
      rot(f.pj, ZAXIS, -side * (c + tw) * 0.55 * k);
      rot(f.dj, ZAXIS, -side * (c + tw) * 0.75 * k);
      if (!f.thumb) rot(f.pj, XAXIS, (f.i - 1.5) * spread);
    }
  };
  // Schwerkraft: Haarketten hängen trotz Kopfbewegung überwiegend nach unten (vor hairSway aufrufen)
  const hairRestQ = hair.map((h) => h.bones[0].getWorldQuaternion(new THREE.Quaternion()));
  const _pq = new THREE.Quaternion(), _wq = new THREE.Quaternion();
  const gravity = (k = 0.75) => {
    if (!hair.length) return;
    rig.root.updateMatrixWorld(true);
    hair.forEach((h, i) => {
      const b = h.bones[0];
      b.parent.getWorldQuaternion(_pq);
      _wq.copy(_pq).multiply(b.quaternion).slerp(hairRestQ[i], k);
      b.quaternion.copy(_pq.invert().multiply(_wq));
    });
  };
  const hunch = (e) => {
    rot(J.spine, XAXIS, 0.16 * e);
    rot(J.chest, XAXIS, 0.14 * e);
    rot(J.neck, XAXIS, 0.2 * e);
    rot(J.head, XAXIS, -0.12 * e);
    for (const x of sides) { rot(x.upper, XAXIS, -0.12 * e); rot(x.upper, ZAXIS, x.s * 0.07 * e); rot(x.fore, XAXIS, -0.12 * e); }
  };

  const walk = flavor === 'ghost' ? bakeClip('Laufen', F.T, tracks, restore, (t) => {
    // langsames, schleppendes Schlurfen; das rechte Bein zieht nach, der Kopf ruckt
    const g = t / F.T;
    hunch(1);
    for (const x of sides) {
      const drag = x.s < 0;
      const { fwd, lift } = stepCurve(frac(g + x.ph), 0.62);
      rot(x.up, XAXIS, -(drag ? 0.7 : 1) * F.A * fwd - 0.05);
      rot(x.low, XAXIS, 0.1 + (drag ? 0.35 : 0.85) * lift);
      rot(x.foot, XAXIS, drag ? 0.15 * lift : -0.25 * lift);
      // Arme baumeln träge hinterher
      rot(x.upper, XAXIS, 0.12 * Math.sin(TAU * g + (x.s > 0 ? Math.PI : 0) - 0.9));
      rot(x.fore, XAXIS, -0.06 - 0.08 * Math.max(0, Math.sin(TAU * g + (x.s > 0 ? Math.PI : 0) - 1.4)));
      curl(x.s, 0.18, 0.06);
    }
    rig.hips.position.y = hipsRest.y + F.bob * Math.cos(2 * TAU * g) - 0.02;
    rot(J.hips, ZAXIS, 0.05 * Math.sin(TAU * g));
    rot(J.hips, UP, 0.06 * Math.sin(TAU * g));
    rot(J.chest, ZAXIS, -0.06 * Math.sin(TAU * g));
    const jerk = Math.exp(-Math.pow((g - 0.55) * 18, 2));
    rot(J.head, ZAXIS, 0.22 + 0.25 * jerk);
    rot(J.head, UP, 0.12 * jerk);
    rot(J.jaw, XAXIS, 0.05 + 0.04 * Math.sin(TAU * 2 * g));
    gravity(); hairSway(t, 0.035, 2 / F.T, 0.05);
    skirtSway(t, 0.05, 2 / F.T);
  }) : bakeClip('Laufen', F.T, tracks, restore, (t) => {
    let g = t / F.T;
    if (F.q) g = Math.floor(g * F.q) / F.q; // ruckartig wie eine alte Maschine
    for (const x of sides) {
      const { fwd, lift } = stepCurve(frac(g + x.ph), 0.6);
      rot(x.up, XAXIS, -F.A * fwd - 0.03);
      rot(x.low, XAXIS, 0.06 + 1.05 * lift);
      rot(x.foot, XAXIS, -0.3 * lift);
      rot(x.upper, ZAXIS, x.s * 0.07);
      rot(x.upper, XAXIS, F.arm * fwd);
      rot(x.fore, XAXIS, -0.2 - 0.6 * F.arm * Math.max(0, -fwd));
    }
    rig.hips.position.y = hipsRest.y + F.bob * Math.cos(2 * TAU * g);
    rot(J.hips, UP, 0.08 * Math.sin(TAU * g));
    rot(J.chest, UP, -0.12 * Math.sin(TAU * g));
    rot(J.spine, XAXIS, F.lean);
    rot(J.head, XAXIS, -F.lean * 0.5);
    if (flavor === 'shadow') { rot(J.head, ZAXIS, 0.25); rot(J.neck, XAXIS, 0.1); tendrilSway(t, 0.12, 0.6); }
    if (flavor === 'animatronic') { rot(J.jaw, XAXIS, Math.sin(TAU * 2 * g) > 0.6 ? 0.08 : 0); rot(J.head, ZAXIS, 0.05 * Math.sin(TAU * g)); }
  });

  // --- Idle ---
  const idle = flavor === 'ghost' ? bakeClip('Idle', 5, tracks, restore, (t) => {
    // gebeugt, schweres Atmen, Finger zucken, ruckartige Kopfbewegungen
    const w = TAU / 5;
    hunch(1);
    rot(J.chest, XAXIS, -0.035 * Math.sin(2 * w * t));
    rot(J.spine, XAXIS, 0.015 * Math.sin(2 * w * t));
    rig.hips.position.x = hipsRest.x + 0.008 * Math.sin(w * t);
    rot(J.hips, ZAXIS, 0.02 * Math.sin(w * t));
    const j1 = key(t, [[0, 0], [1.5, 0], [1.58, 1], [2.6, 1], [2.75, 0], [5, 0]]);
    const j2 = key(t, [[0, 0], [3.6, 0], [3.66, 1], [4.2, 1], [4.6, 0], [5, 0]]);
    rot(J.head, ZAXIS, 0.18 + 0.05 * Math.sin(w * t) + 0.32 * j1 - 0.1 * j2);
    rot(J.head, UP, -0.1 * j1 + 0.22 * j2);
    rot(J.neck, XAXIS, 0.06 * j2);
    rot(J.jaw, XAXIS, 0.04 + 0.04 * Math.sin(2 * w * t));
    for (const x of sides) {
      rot(x.upper, ZAXIS, x.s * 0.012 * Math.sin(2 * w * t));
      curl(x.s, 0.15, 0.08, (i) => 0.25 * Math.max(0, Math.sin(TAU * 0.9 * t + i * 1.3 + x.s)) * (i === 1 || i === 3 ? 1 : 0.4));
    }
    gravity(); hairSway(t, 0.02, 0.4);
    skirtSway(t, 0.025, 0.4);
  }) : bakeClip('Idle', 4, tracks, restore, (t) => {
    const w = TAU / 4;
    rot(J.chest, XAXIS, -0.02 * Math.sin(2 * w * t));
    rig.hips.position.x = hipsRest.x + 0.01 * Math.sin(w * t);
    rot(J.hips, ZAXIS, 0.015 * Math.sin(w * t));
    for (const x of sides) { rot(x.upper, ZAXIS, x.s * (0.07 + 0.015 * Math.sin(2 * w * t))); rot(x.fore, XAXIS, -0.12); }
    if (flavor === 'human') rot(J.head, UP, key(t, [[0, 0], [0.8, 0.4], [1.8, 0.4], [2.6, -0.3], [3.4, -0.3], [4, 0]]));
    if (flavor === 'animatronic') {
      rot(J.spine, XAXIS, 0.06);
      rot(J.head, UP, t > 1.5 && t < 2.7 ? 0.45 : 0);   // ruckartiger Blick
      rot(J.head, ZAXIS, t > 2.0 && t < 2.7 ? -0.2 : 0);
      rot(J.jaw, XAXIS, Math.sin(6 * w * t) > 0.7 ? 0.08 : 0);
    }
    if (flavor === 'shadow') { rot(J.head, ZAXIS, 0.2 + 0.12 * Math.sin(w * t)); rot(J.neck, XAXIS, 0.06); tendrilSway(t, 0.15, 0.5); }
  });

  const clips = [{ id: 'idle', name: 'Idle', clip: idle }, { id: 'walk', name: 'Laufen', clip: walk }];
  const action = (id, name, dur, pose) => clips.push({ id, name, clip: bakeClip(name, dur, tracks, restore, pose), once: true });

  if (flavor === 'human' || !flavor) {
    action('wave', 'Winken', 2.6, (t) => {
      const u = key(t, [[0, 0], [0.45, 1], [2.15, 1], [2.6, 0]]);
      rot(Rs.upper, ZAXIS, -2.5 * u);
      rot(Rs.fore, ZAXIS, u * (-0.25 + 0.4 * Math.sin(TAU * 2.2 * t)));
      rot(J.head, ZAXIS, 0.1 * u);
      rot(J.head, UP, -0.15 * u);
      rot(J.chest, ZAXIS, 0.05 * u);
      for (const x of sides) rot(x.upper, ZAXIS, x === Ls ? 0.07 : 0);
    });
    action('jump', 'Springen', 1.6, (t) => {
      const c = key(t, [[0, 0], [0.35, 1], [0.47, 0], [0.95, 0], [1.1, 0.7], [1.6, 0]]);
      const air = t > 0.45 && t < 1.0 ? Math.sin(Math.PI * (t - 0.45) / 0.55) : 0;
      rig.root.position.y = rootRest.y + 0.38 * air;
      rig.hips.position.y = hipsRest.y - 0.17 * c;
      for (const x of sides) {
        rot(x.up, XAXIS, -0.9 * c - 0.5 * air);
        rot(x.low, XAXIS, 1.7 * c + 0.9 * air);
        rot(x.foot, XAXIS, -0.75 * c);
        rot(x.upper, XAXIS, 0.7 * c - 2.4 * air);
      }
      rot(J.spine, XAXIS, 0.35 * c);
      rot(J.head, XAXIS, -0.2 * c);
    });
    action('dance', 'Tanzen', 4, (t) => {
      const e = key(t, [[0, 0], [0.3, 1], [3.7, 1], [4, 0]]);
      const b = TAU * 2 * t;
      rig.hips.position.x = hipsRest.x + 0.06 * e * Math.sin(b / 2);
      rig.hips.position.y = hipsRest.y - 0.03 * e * (0.5 + 0.5 * Math.cos(b));
      rot(J.hips, ZAXIS, 0.1 * e * Math.sin(b / 2));
      rot(J.chest, ZAXIS, -0.08 * e * Math.sin(b / 2));
      rot(J.head, XAXIS, 0.12 * e * Math.sin(b));
      for (const x of sides) {
        const v = Math.max(0, Math.sin(b / 2 + (x.s > 0 ? 0 : Math.PI))) * e;
        rot(x.up, XAXIS, -0.2 * v);
        rot(x.low, XAXIS, 0.4 * v);
        rot(x.upper, ZAXIS, x.s * e * (1.3 + 0.6 * Math.sin(b / 2 + (x.s > 0 ? 0 : Math.PI))));
        rot(x.fore, ZAXIS, x.s * 0.5 * e * Math.sin(b));
      }
    });
  }

  if (flavor === 'animatronic') {
    action('scare', 'Erschrecken', 1.8, (t) => {
      const e = key(t, [[0, 0], [0.22, 1], [1.3, 1], [1.8, 0]]);
      rig.root.position.z = rootRest.z + 0.25 * e;
      rot(J.spine, XAXIS, 0.35 * e);
      rot(J.chest, XAXIS, 0.15 * e);
      rot(J.jaw, XAXIS, 0.75 * e);
      rot(J.head, XAXIS, -0.25 * e);
      rot(J.head, UP, 0.18 * e * Math.sin(TAU * 9 * t));
      for (const x of sides) { rot(x.upper, XAXIS, -1.6 * e); rot(x.upper, ZAXIS, x.s * 0.3 * e); rot(x.fore, XAXIS, -0.5 * e); }
    });
    action('glitch', 'Defekt', 3, (t) => {
      const e = key(t, [[0, 0], [0.2, 1], [2.7, 1], [3, 0]]);
      const seg = Math.floor(t * 8);
      const r = (k) => hash(seg * 7 + k);
      rot(J.spine, XAXIS, 0.25 * e);
      rot(J.head, UP, e * (r(1) > 0.45 ? (r(2) - 0.5) * 1.0 : 0));
      rot(J.head, ZAXIS, e * (r(3) > 0.6 ? (r(4) - 0.5) * 0.6 : 0));
      rot(J.jaw, XAXIS, e * r(5) * 0.5);
      rot(Rs.upper, XAXIS, e * (r(6) > 0.6 ? -0.8 : 0));
      rot(Ls.fore, XAXIS, e * (r(8) > 0.5 ? -0.5 : 0));
    });
    action('dance', 'Tanzen', 3.2, (t) => {
      const e = key(t, [[0, 0], [0.2, 1], [3.0, 1], [3.2, 0]]);
      const step = Math.floor(t * 3);
      const sgn = step % 2 ? 1 : -1;
      rot(J.hips, ZAXIS, 0.1 * e * sgn);
      rot(J.head, ZAXIS, -0.2 * e * sgn);
      rot(J.jaw, XAXIS, (step % 2 ? 0.3 : 0) * e);
      for (const x of sides) rot(x.upper, XAXIS, -1.2 * e * ((step + (x.s > 0 ? 0 : 1)) % 2));
    });
  }

  if (flavor === 'shadow') {
    action('appear', 'Erscheinen', 2.6, (t) => {
      const seg = Math.floor(t * 14);
      const visible = t >= 1.8 || hash(seg) < (t / 1.8) * 0.8 + 0.15;
      const sx = visible ? 1 : 0.04;
      rig.root.scale.set(sx, 1, sx);
      if (!visible) rig.root.position.x = rootRest.x + (hash(seg + 9) - 0.5) * 0.4;
      rot(J.head, UP, visible ? 0 : (hash(seg + 3) - 0.5) * 0.5);
    });
    action('tendrils', 'Tentakel', 3.6, (t) => {
      const e = key(t, [[0, 0], [0.6, 1], [3.0, 1], [3.6, 0]]);
      tendrils.forEach((td, k) => {
        rot(td.j[0], td.lateral, 0.9 * e);
        td.j.forEach((j, i) => {
          rot(j, td.lateral, 0.3 * e * Math.sin(TAU * 1.1 * t - i * 0.8 + k));
          rot(j, UP, 0.2 * e * Math.sin(TAU * 0.7 * t + i * 0.5 + k * 1.3));
        });
      });
      for (const x of sides) rot(x.upper, ZAXIS, x.s * 0.5 * e);
      rot(J.head, ZAXIS, 0.3 * e);
    });
    action('stare', 'Anstarren', 3.6, (t) => {
      const e = key(t, [[0, 0], [1.0, 1], [2.8, 1], [3.6, 0]]);
      rig.root.position.z = rootRest.z + 0.12 * e;
      rot(J.spine, XAXIS, 0.18 * e);
      rot(J.chest, XAXIS, 0.12 * e);
      rot(J.neck, XAXIS, 0.15 * e);
      rot(J.head, ZAXIS, 0.55 * e);
      for (const x of sides) { rot(x.upper, XAXIS, -0.5 * e); rot(x.fore, XAXIS, -0.3 * e); }
      tendrilSway(t, 0.1 * e, 0.4);
    });
  }

  if (flavor === 'ghost') {
    action('attack', 'Angriff', 2.4, (t) => {
      // ausholen → Doppelschlag mit beiden Krallen nach vorne → zweiter Hieb → zurück
      const back = key(t, [[0, 0], [0.45, 1], [0.62, 0], [2.4, 0]]);
      const strike = key(t, [[0, 0], [0.45, 0], [0.62, 1], [0.82, 0.75], [1.0, 1.08], [1.5, 1], [2.4, 0]]);
      const hold = key(t, [[0, 0], [0.5, 1], [1.7, 1], [2.4, 0]]);
      hunch(1 - 0.6 * back);
      rig.root.position.z = rootRest.z - 0.06 * back + 0.42 * strike;
      rig.hips.position.y = hipsRest.y - 0.07 * strike - 0.02 * back;
      rot(J.spine, XAXIS, -0.22 * back + 0.42 * strike);
      rot(J.chest, XAXIS, -0.12 * back + 0.2 * strike);
      rot(J.neck, XAXIS, 0.1 * strike);
      rot(J.head, XAXIS, -0.35 * back - 0.4 * strike);
      rot(J.head, ZAXIS, 0.1 * (1 - hold));
      rot(J.jaw, XAXIS, 0.55 * back + 0.85 * strike);
      const e2 = key(t, [[0, 0], [0.82, 0], [1.0, 1], [1.5, 1], [2.0, 0]]);
      for (const x of sides) {
        // Ausholen: Arme hoch über den Kopf, Schlag: nach vorne unten
        rot(x.upper, XAXIS, -2.5 * back - 1.25 * strike + (x.s > 0 ? 0.25 : -0.15) * e2);
        rot(x.upper, ZAXIS, x.s * (0.35 * back + 0.12 * strike));
        rot(x.fore, XAXIS, -0.7 * back - 0.25 * strike);
        rot(x.hand, XAXIS, 0.3 * back - 0.35 * strike);
        curl(x.s, -0.35 * back + 0.95 * strike, 0.22 * back + 0.08 * strike);
      }
      // Ausfallschritt: linkes Bein vor, rechtes zurück
      rot(Ls.up, XAXIS, -0.65 * strike + 0.1 * back);
      rot(Ls.low, XAXIS, 0.55 * strike);
      rot(Ls.foot, XAXIS, 0.1 * strike);
      rot(Rs.up, XAXIS, 0.38 * strike);
      rot(Rs.low, XAXIS, 0.25 * strike);
      rot(Rs.foot, XAXIS, 0.25 * strike);
      // Haare und Kleid schwingen träge nach
      const vel = key(t, [[0, 0], [0.45, -0.6], [0.62, 1], [0.9, -0.3], [1.1, 0.5], [1.6, 0], [2.4, 0]]);
      gravity(0.6); hairSway(t, 0.03, 1.2, -0.25 * vel);
      skirtSway(t, 0.05 * hold, 1.6, 0.12 * Math.abs(vel));
    });
    action('scream', 'Schrei', 2.6, (t) => {
      const e = key(t, [[0, 0], [0.5, 1], [2.0, 1], [2.6, 0]]);
      const pre = key(t, [[0, 0], [0.3, 1], [0.6, 0], [2.6, 0]]);
      const shake = e * Math.sin(TAU * 11 * t);
      hunch(1 - e * 0.8);
      rot(J.spine, XAXIS, 0.25 * pre - 0.18 * e);
      rot(J.chest, XAXIS, -0.12 * e + 0.015 * shake);
      rot(J.head, XAXIS, 0.25 * pre - 0.42 * e + 0.03 * shake);
      rot(J.head, ZAXIS, 0.04 * shake);
      rot(J.jaw, XAXIS, 0.95 * e + 0.05 * shake);
      for (const x of sides) {
        rot(x.upper, ZAXIS, x.s * 0.7 * e);
        rot(x.upper, XAXIS, 0.35 * e);
        rot(x.fore, XAXIS, -0.45 * e);
        rot(x.fore, ZAXIS, x.s * 0.25 * e);
        curl(x.s, -0.3 * e + 0.15 * pre, 0.28 * e, (i) => 0.08 * shake * (i % 2 ? 1 : -1));
      }
      gravity(0.6); hairSway(t, 0.04 * e, 1.6, -0.2 * e);
      skirtSway(t, 0.04 * e, 2.4, 0.08 * e);
    });
    action('twist', 'Kopf verdrehen', 3.2, (t) => {
      // ruckartig, in Stufen verdreht und zurückgeschnappt
      const e = key(t, [[0, 0], [0.3, 1], [2.7, 1], [3.2, 0]]);
      const seg = Math.floor(t * 6);
      const r = (k) => hash(seg * 5 + k);
      const steps = key(t, [[0, 0], [0.4, 0.35], [0.45, 0.35], [0.9, 0.7], [1.0, 0.7], [1.6, 1], [2.3, 1], [2.45, 0], [3.2, 0]]);
      hunch(1);
      rot(J.neck, ZAXIS, 0.45 * steps);
      rot(J.head, ZAXIS, 0.75 * steps + e * (r(1) > 0.6 ? (r(2) - 0.5) * 0.15 : 0));
      rot(J.head, UP, 0.35 * steps);
      rot(J.jaw, XAXIS, 0.1 + 0.35 * steps);
      rot(Rs.upper, ZAXIS, -e * (r(3) > 0.55 ? 0.15 : 0));
      rot(Ls.upper, XAXIS, -e * (r(4) > 0.6 ? 0.18 : 0));
      rot(J.chest, ZAXIS, -0.1 * steps);
      for (const x of sides) curl(x.s, 0.2, 0.1, (i) => e * (hash(seg * 3 + i + x.s * 7) > 0.5 ? 0.35 : 0));
      gravity(0.8); hairSway(t, 0.02, 0.6, 0);
      skirtSway(t, 0.02, 0.6);
    });
  }

  const names = { human: 'Menschen-Skelett', animatronic: 'Animatronik-Skelett', shadow: 'Schattenfigur-Skelett', ghost: 'Geister-Skelett' };
  return { ok: true, method: names[flavor] || 'Humanoides Skelett', legs: 2, gait: 'Zweibeiner', clips, restore };
}

// ---------------------------------------------------------------------------
// Allgemeiner Gang für erkannte Beine (Wege 2–4)
// ---------------------------------------------------------------------------
/**
 * legs: [{ upper: joint, knee?: joint, liftNode?: {node, up: Vector3}, pos: Vector3 (Hüfte, Welt), foot: Vector3 }]
 * extra: { body?: {node, up(local) }, arms?: [{ j, side }], spine?: [joint], height }
 */
function buildGenericClips(root, legs, extra, method) {
  const gait = assignPhases(legs);
  for (const l of legs) {
    const d = l.foot.clone().sub(l.pos);
    const drop = Math.max(1e-6, -d.y);
    d.y = 0;
    l.splayed = d.length() > 0.8 * drop; // Spinnenartig abgespreizt → Drehung um die Hochachse
    l.dir = d.lengthSq() > 1e-9 ? d.normalize() : new THREE.Vector3(l.side, 0, 0);
    l.lateral = new THREE.Vector3().crossVectors(l.dir, UP).normalize();
  }
  const nodes = [
    ...legs.flatMap((l) => [l.upper?.node, l.knee?.node, l.liftNode?.node]),
    extra.body?.node, ...(extra.arms || []).map((a) => a.j.node), ...(extra.spine || []).map((s) => s.node), root,
  ].filter(Boolean);
  ensureNames(root, nodes);
  const restore = snapshot(nodes);
  const rest = new Map(nodes.map((n) => [n, n.position.clone()]));
  const tracks = [...new Set(nodes)].map((node) => ({
    node, q: true,
    p: node === extra.body?.node || node === root || legs.some((l) => l.liftNode?.node === node),
  }));
  const H = modelBox(root).H;
  const rootUp = localOffset(root, UP.clone().multiplyScalar(H));
  const rootRest = root.position.clone();
  const turnJ = joint(extra.body?.node || root);
  const biped = legs.length === 2;
  const A = biped ? 0.42 : legs.length === 4 ? 0.32 : 0.24;
  const duty = biped ? 0.58 : 0.62;
  const T = biped ? 1.05 : legs.length === 4 ? 0.95 : 0.85;

  const walk = bakeClip('Laufen', T, tracks, restore, (t) => {
    const g = t / T;
    const legFwd = { 1: 0, '-1': 0 };
    for (const l of legs) {
      const { fwd, lift } = stepCurve(frac(g + l.phase), duty);
      legFwd[l.side] = fwd;
      if (l.splayed) {
        rot(l.upper, UP, -l.side * A * fwd);
        rot(l.upper, l.lateral, 0.35 * lift);
        rot(l.knee, l.lateral, -0.25 * lift);
      } else {
        rot(l.upper, XAXIS, -A * fwd);
        rot(l.knee, XAXIS, 0.08 + 0.95 * lift);
      }
      if (l.liftNode) l.liftNode.node.position.copy(rest.get(l.liftNode.node)).addScaledVector(l.liftNode.up, lift);
    }
    if (extra.body) extra.body.node.position.copy(rest.get(extra.body.node)).addScaledVector(extra.body.up, Math.sin(2 * TAU * g) * 0.5 + 0.5);
    for (const a of extra.arms || []) rot(a.j, XAXIS, 0.6 * A * legFwd[a.side]);
    for (const s of extra.spine || []) rot(s, UP, 0.04 * Math.sin(TAU * g));
  });

  const D = 3;
  const idle = bakeClip('Idle', D, tracks, restore, (t) => {
    const w = TAU / D;
    if (extra.body) extra.body.node.position.copy(rest.get(extra.body.node)).addScaledVector(extra.body.up, 0.4 * (Math.sin(w * t) * 0.5 + 0.5));
    for (const s of extra.spine || []) rot(s, XAXIS, -0.03 * Math.sin(w * t));
    for (const a of extra.arms || []) rot(a.j, new THREE.Vector3(0, 0, 1), a.side * 0.04 * Math.sin(w * t));
    legs.forEach((l, i) => {
      // leichtes Gewichtverlagern
      const s = 0.025 * Math.sin(w * t + (l.side > 0 ? 0 : Math.PI) + i * 0.3);
      if (l.splayed) rot(l.upper, UP, s); else rot(l.knee || l.upper, XAXIS, Math.abs(s));
    });
  });

  // --- Aktionen für alle erkannten Modelle ---
  const crouchLegs = (c) => legs.forEach((l) => {
    if (l.splayed) rot(l.upper, l.lateral, -0.25 * c);
    else { rot(l.upper, XAXIS, -0.45 * c); rot(l.knee, XAXIS, 0.9 * c); }
  });
  const jump = bakeClip('Springen', 1.5, tracks, restore, (t) => {
    const c = key(t, [[0, 0], [0.35, 1], [0.47, 0], [0.95, 0], [1.1, 0.7], [1.5, 0]]);
    const air = t > 0.45 && t < 1.0 ? Math.sin(Math.PI * (t - 0.45) / 0.55) : 0;
    root.position.copy(rootRest).addScaledVector(rootUp, 0.3 * air - 0.05 * c);
    crouchLegs(c);
    legs.forEach((l) => { if (!l.splayed) { rot(l.upper, XAXIS, -0.3 * air); rot(l.knee, XAXIS, 0.6 * air); } else rot(l.upper, l.lateral, 0.3 * air); });
    for (const a of extra.arms || []) rot(a.j, XAXIS, 0.6 * c - 1.6 * air);
  });
  const look = bakeClip('Umschauen', 3.2, tracks, restore, (t) => {
    rot(turnJ, UP, key(t, [[0, 0], [0.7, 0.55], [1.4, 0.55], [2.2, -0.55], [2.7, -0.55], [3.2, 0]]));
  });
  const dance = bakeClip('Tanzen', 4, tracks, restore, (t) => {
    const e = key(t, [[0, 0], [0.3, 1], [3.7, 1], [4, 0]]);
    const b = TAU * 2 * t;
    root.position.copy(rootRest).addScaledVector(rootUp, 0.05 * e * Math.abs(Math.sin(b / 2)));
    rot(turnJ, UP, 0.3 * e * Math.sin(b / 4));
    legs.forEach((l) => {
      const v = Math.max(0, Math.sin(b / 2 + (l.phase || 0) * TAU)) * e;
      if (l.splayed) rot(l.upper, l.lateral, 0.35 * v);
      else { rot(l.upper, XAXIS, -0.3 * v); rot(l.knee, XAXIS, 0.6 * v); }
    });
    for (const a of extra.arms || []) rot(a.j, new THREE.Vector3(0, 0, 1), a.side * e * (1.2 + 0.5 * Math.sin(b / 2)));
  });

  return {
    ok: true, method, legs: legs.length, gait,
    clips: [
      { id: 'idle', name: 'Idle', clip: idle }, { id: 'walk', name: 'Laufen', clip: walk },
      { id: 'jump', name: 'Springen', clip: jump, once: true },
      { id: 'look', name: 'Umschauen', clip: look, once: true },
      { id: 'dance', name: 'Tanzen', clip: dance, once: true },
    ],
    restore,
  };
}

function modelBox(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  return { box, H: box.max.y - box.min.y, size: box.getSize(new THREE.Vector3()) };
}

// ---------------------------------------------------------------------------
// 2. Skelett aus der Datei
// ---------------------------------------------------------------------------
function analyzeSkeleton(root, bones) {
  const { box, H } = modelBox(root);
  const isBone = (o) => o && o.isBone;
  const wp = (b) => b.getWorldPosition(new THREE.Vector3());
  const leaves = bones.filter((b) => !b.children.some(isBone) && wp(b).y < box.min.y + 0.22 * H);
  const chains = new Map();
  for (const leaf of leaves) {
    const chain = [leaf];
    let cur = leaf;
    while (isBone(cur.parent) && cur.parent.children.filter(isBone).length < 2) { cur = cur.parent; chain.unshift(cur); }
    if (!isBone(cur.parent)) continue; // kein Verzweigungspunkt (Becken) gefunden
    const top = chain[0];
    if (wp(top).y - wp(leaf).y < 0.2 * H) continue; // zu kurz für ein Bein (z. B. Zehen)
    if (!chains.has(top) || chains.get(top).length < chain.length) chains.set(top, chain);
  }
  const legChains = [...chains.values()];
  if (legChains.length < 2 || legChains.length > 8) return null;

  const legs = legChains.map((c) => ({
    upper: joint(c[0]),
    knee: c.length > 2 ? joint(c[1]) : null,
    pos: wp(c[0]),
    foot: wp(c[Math.min(c.length - 1, 2)]),
  }));
  // Körper (gemeinsamer Elternknochen der Beine) wippt
  const hips = legChains[0][0].parent;
  const amp = 0.012 * H;
  const extra = { body: { node: hips, up: localOffset(hips, UP.clone().multiplyScalar(amp)) } };
  // Arme & Wirbelsäule über Namen (optional)
  const cx = (box.min.x + box.max.x) / 2;
  const legSet = new Set(legChains.flat());
  const armCands = bones.filter((b) => !legSet.has(b) && /arm/i.test(b.name) && !/fore|lower|hand|finger|twist|low/i.test(b.name));
  const arms = [];
  for (const side of [1, -1]) {
    const c = armCands.filter((b) => Math.sign(wp(b).x - cx) === side);
    if (c.length) {
      const depth = (b) => { let d = 0; for (let o = b; o.parent; o = o.parent) d++; return d; };
      c.sort((a, b) => depth(a) - depth(b));
      arms.push({ j: joint(c[0]), side });
    }
  }
  extra.arms = arms;
  extra.spine = bones.filter((b) => /spine|chest/i.test(b.name) && !legSet.has(b)).slice(0, 2).map(joint);
  return buildGenericClips(root, legs, extra, 'Skelett aus der Datei');
}

// ---------------------------------------------------------------------------
// 3. Einzelteile (z. B. Beine als eigene Meshes)
// ---------------------------------------------------------------------------
function analyzeParts(root) {
  const { box, H, size } = modelBox(root);
  const W = Math.max(size.x, size.z);
  const cands = [];
  root.traverse((o) => {
    if (!o.isMesh || o.isSkinnedMesh || !o.geometry) return;
    const b = new THREE.Box3().setFromObject(o);
    const s = b.getSize(new THREE.Vector3());
    const h = s.y, horiz = Math.max(s.x, s.z), thin = Math.min(s.x, s.z);
    const touchesGround = b.min.y < box.min.y + 0.05 * H;
    const ok = touchesGround && h > 0.15 * H && b.max.y < box.min.y + 0.75 * H &&
      horiz < 0.4 * W && thin > 0.2 * horiz && h > 1.2 * horiz; // länglich, rundlich, nicht plattenförmig
    if (ok) cands.push({ mesh: o, b });
  });
  // Teile, die in einem anderen Kandidaten stecken, nicht doppelt zählen
  const legsParts = cands.filter((c) => !cands.some((d) => d !== c && c.mesh.parent === d.mesh));
  if (legsParts.length < 2 || legsParts.length > 8) return null;

  const legs = legsParts.map(({ mesh, b }, i) => {
    const top = new THREE.Vector3((b.min.x + b.max.x) / 2, b.max.y, (b.min.z + b.max.z) / 2);
    const foot = new THREE.Vector3(top.x, b.min.y, top.z);
    const parent = mesh.parent;
    const pivot = new THREE.Object3D();
    pivot.name = `Gelenk_Bein_${i + 1}`;
    parent.add(pivot);
    pivot.position.copy(parent.worldToLocal(top.clone()));
    pivot.updateMatrixWorld(true);
    pivot.attach(mesh); // Weltlage bleibt erhalten
    return {
      upper: joint(pivot), knee: null, pos: top, foot,
      liftNode: { node: pivot, up: localOffset(pivot, UP.clone().multiplyScalar(0.05 * H)) },
    };
  });
  return buildGenericClips(root, legs, {}, 'Einzelteile mit Gelenken');
}

// ---------------------------------------------------------------------------
// 4. Ein einziges Mesh → automatisches Skelett (Auto-Rigging)
// ---------------------------------------------------------------------------
function autoRig(root, onReplaceMesh) {
  const { box, H } = modelBox(root);
  let mesh = null, best = 0;
  root.traverse((o) => {
    if (!o.isMesh || o.isSkinnedMesh || !o.geometry?.attributes.position) return;
    const b = new THREE.Box3().setFromObject(o);
    if (b.min.y > box.min.y + 0.03 * H || b.max.y - b.min.y < 0.5 * H) return;
    const n = o.geometry.attributes.position.count;
    if (n > best) { best = n; mesh = o; }
  });
  if (!mesh) return null;
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const n = pos.count;
  if (n > 800000) return { ok: false, reason: 'Modell ist zu groß für die automatische Erkennung.' };

  mesh.updateWorldMatrix(true, false);
  const invq = mesh.getWorldQuaternion(new THREE.Quaternion()).invert();
  const upL = UP.clone().applyQuaternion(invq).normalize();

  // Koordinaten im "Hochachsen"-System: a, b horizontal, h = Höhe
  const e1 = Math.abs(upL.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
  e1.addScaledVector(upL, -e1.dot(upL)).normalize();
  const e2 = new THREE.Vector3().crossVectors(upL, e1);
  const A = new Float32Array(n), h = new Float32Array(n), Bc = new Float32Array(n);
  const v = new THREE.Vector3();
  let minA = Infinity, maxA = -Infinity, minH = Infinity, maxH = -Infinity, minB = Infinity, maxB = -Infinity;
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i);
    A[i] = v.dot(e1); h[i] = v.dot(upL); Bc[i] = v.dot(e2);
    if (A[i] < minA) minA = A[i]; if (A[i] > maxA) maxA = A[i];
    if (h[i] < minH) minH = h[i]; if (h[i] > maxH) maxH = h[i];
    if (Bc[i] < minB) minB = Bc[i]; if (Bc[i] > maxB) maxB = Bc[i];
  }
  const HL = maxH - minH;
  if (!(HL > 0)) return null;

  // Oberfläche in ein Voxelgitter rastern. Räumliche Nähe statt Mesh-Topologie: so werden auch
  // Beine erkannt, die nur im Körper stecken (häufig bei STL-Dateien aus Tinkercad & Co.)
  let c = HL / 48;
  const dims = () => [Math.floor((maxA - minA) / c) + 1, Math.floor(HL / c) + 1, Math.floor((maxB - minB) / c) + 1];
  let [nx, ny, nz] = dims();
  while (nx * ny * nz > 6e6) { c *= 1.25; [nx, ny, nz] = dims(); }
  const N = nx * ny * nz;
  const occ = new Uint8Array(N);
  const cell = (a, hh, b) => {
    const ix = Math.min(nx - 1, Math.max(0, Math.floor((a - minA) / c)));
    const iy = Math.min(ny - 1, Math.max(0, Math.floor((hh - minH) / c)));
    const iz = Math.min(nz - 1, Math.max(0, Math.floor((b - minB) / c)));
    return (iy * nz + iz) * nx + ix;
  };
  const idx = geo.index ? geo.index.array : null;
  const triCount = idx ? idx.length / 3 : n / 3;
  for (let t = 0; t < triCount; t++) {
    const i0 = idx ? idx[t * 3] : t * 3, i1 = idx ? idx[t * 3 + 1] : t * 3 + 1, i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
    const e = Math.max(
      Math.hypot(A[i1] - A[i0], h[i1] - h[i0], Bc[i1] - Bc[i0]),
      Math.hypot(A[i2] - A[i1], h[i2] - h[i1], Bc[i2] - Bc[i1]),
      Math.hypot(A[i0] - A[i2], h[i0] - h[i2], Bc[i0] - Bc[i2]));
    const k = Math.min(96, Math.max(1, Math.ceil(e / (0.5 * c))));
    for (let u = 0; u <= k; u++) {
      for (let w = 0; w <= k - u; w++) {
        const l1 = u / k, l2 = w / k, l0 = 1 - l1 - l2;
        occ[cell(A[i0] * l0 + A[i1] * l1 + A[i2] * l2, h[i0] * l0 + h[i1] * l1 + h[i2] * l2, Bc[i0] * l0 + Bc[i1] * l1 + Bc[i2] * l2)] = 1;
      }
    }
  }

  // Zusammenhängende Voxel-Bereiche innerhalb eines Höhenbands (26er-Nachbarschaft)
  const lab = new Int32Array(N);
  const stack = new Int32Array(N);
  const components = (y0, y1) => {
    lab.fill(-1);
    const comps = [];
    for (let y = y0; y <= y1; y++) {
      for (let zz = 0; zz < nz; zz++) {
        for (let xx = 0; xx < nx; xx++) {
          const s0 = (y * nz + zz) * nx + xx;
          if (!occ[s0] || lab[s0] !== -1) continue;
          const id = comps.length;
          let sp = 0, size = 0;
          stack[sp++] = s0; lab[s0] = id;
          while (sp) {
            const q = stack[--sp]; size++;
            const qx = q % nx, qz = Math.floor(q / nx) % nz, qy = Math.floor(q / (nx * nz));
            for (let dy = -1; dy <= 1; dy++) {
              const yy = qy + dy; if (yy < y0 || yy > y1) continue;
              for (let dz = -1; dz <= 1; dz++) {
                const z2 = qz + dz; if (z2 < 0 || z2 >= nz) continue;
                for (let dx = -1; dx <= 1; dx++) {
                  const x2 = qx + dx; if (x2 < 0 || x2 >= nx) continue;
                  const r = (yy * nz + z2) * nx + x2;
                  if (occ[r] && lab[r] === -1) { lab[r] = id; stack[sp++] = r; }
                }
              }
            }
          }
          comps.push({ id, seed: s0, size });
        }
      }
    }
    const maxSize = Math.max(0, ...comps.map((q) => q.size));
    return comps.filter((q) => q.size >= Math.max(2, 0.04 * maxSize));
  };

  // Füße: getrennte Bereiche ganz unten
  const footLayers = Math.max(1, Math.round(0.04 * HL / c));
  const feet = components(0, footLayers);
  if (feet.length < 2 || feet.length > 8) return null;
  // Hüfthöhe: ab wo laufen die Beine im Querschnitt zusammen?
  let hipLayer = null;
  for (let y = footLayers; y < Math.floor(0.85 * ny); y++) {
    if (components(y, y + 1).length < feet.length) { hipLayer = y; break; }
  }
  if (hipLayer === null || hipLayer * c < 0.08 * HL) return null;
  const hipH = minH + hipLayer * c;

  // Beinbereiche = alles unterhalb der Hüfte, was mit einem Fuß verbunden ist
  components(0, hipLayer - 1);
  const legOfComp = new Map();
  for (const f of feet) { const id = lab[f.seed]; if (id >= 0 && !legOfComp.has(id)) legOfComp.set(id, legOfComp.size); }
  const legCount = legOfComp.size;
  if (legCount < 2 || legCount > 8) return null;
  const legOf = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (h[i] >= hipH) continue;
    const k = legOfComp.get(lab[cell(A[i], h[i], Bc[i])]);
    if (k !== undefined) legOf[i] = k;
  }
  const bb = geo.boundingBox || (geo.computeBoundingBox(), geo.boundingBox);

  // Gelenkpunkte je Bein (Mittelwerte von Querschnitten)
  const legH = hipH - minH;
  const kneeH = minH + 0.5 * legH;
  const acc = () => ({ s: new THREE.Vector3(), c: 0 });
  const hipAcc = [], kneeAcc = [], footAcc = [];
  for (let k = 0; k < legCount; k++) { hipAcc.push(acc()); kneeAcc.push(acc()); footAcc.push(acc()); }
  const bodyAcc = acc();
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i);
    const k = legOf[i];
    if (k < 0) { bodyAcc.s.add(v); bodyAcc.c++; continue; }
    if (h[i] > hipH - 0.08 * legH) { hipAcc[k].s.add(v); hipAcc[k].c++; }
    if (Math.abs(h[i] - kneeH) < 0.06 * legH) { kneeAcc[k].s.add(v); kneeAcc[k].c++; }
    if (h[i] < minH + 0.06 * legH) { footAcc[k].s.add(v); footAcc[k].c++; }
  }
  const avg = (a, fb) => (a.c ? a.s.divideScalar(a.c) : fb);
  const bodyPos = avg(bodyAcc, bb.getCenter(new THREE.Vector3()));

  // Knochen im lokalen Raum des Meshes
  const bones = [];
  const rootBone = new THREE.Bone();
  rootBone.name = 'Auto_Koerper';
  rootBone.position.copy(bodyPos);
  bones.push(rootBone);
  const legBones = [];
  for (let k = 0; k < legCount; k++) {
    const foot = avg(footAcc[k], null);
    const hip = avg(hipAcc[k], foot ? foot.clone().addScaledVector(upL, legH) : bodyPos.clone());
    const knee = avg(kneeAcc[k], hip.clone().lerp(foot || hip, 0.5));
    const hb = new THREE.Bone(); hb.name = `Auto_Bein${k + 1}_Huefte`;
    hb.position.copy(hip).sub(bodyPos); rootBone.add(hb);
    const kb = new THREE.Bone(); kb.name = `Auto_Bein${k + 1}_Knie`;
    kb.position.copy(knee).sub(hip); hb.add(kb);
    bones.push(hb, kb);
    legBones.push({ hb, kb, hip, foot: foot || knee });
  }

  // Gewichte (weiche Übergänge an Knie und Hüfte)
  const skinIndex = new Uint16Array(n * 4), skinWeight = new Float32Array(n * 4);
  const bw = 0.12 * legH;
  for (let i = 0; i < n; i++) {
    const k = legOf[i], hv = h[i];
    if (k < 0) { skinIndex[i * 4] = 0; skinWeight[i * 4] = 1; continue; }
    const hipI = 1 + k * 2, kneeI = hipI + 1;
    let wHip, wKnee;
    if (hv >= kneeH + bw) { wHip = 1; wKnee = 0; } else if (hv <= kneeH - bw) { wHip = 0; wKnee = 1; } else { wHip = (hv - (kneeH - bw)) / (2 * bw); wKnee = 1 - wHip; }
    const tb = clamp01((hipH - hv) / (0.15 * legH)); // nahe der Hüfte in den Körper überblenden
    const wRoot = wHip * (1 - tb);
    wHip *= tb;
    skinIndex.set([kneeI, hipI, 0, 0], i * 4);
    skinWeight.set([wKnee, wHip, wRoot, 0], i * 4);
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));

  const sk = new THREE.SkinnedMesh(geo, mesh.material);
  sk.name = mesh.name || 'Modell';
  sk.position.copy(mesh.position); sk.quaternion.copy(mesh.quaternion); sk.scale.copy(mesh.scale);
  sk.castShadow = mesh.castShadow; sk.receiveShadow = mesh.receiveShadow; sk.visible = mesh.visible;
  const par = mesh.parent;
  par.add(sk);
  for (const c of [...mesh.children]) sk.add(c);
  par.remove(mesh);
  sk.add(rootBone);
  sk.updateMatrixWorld(true);
  sk.bind(new THREE.Skeleton(bones));
  sk.computeBoundingBox();
  sk.computeBoundingSphere();
  if (onReplaceMesh) onReplaceMesh(mesh, sk);

  const toWorld = (p) => p.clone().applyMatrix4(sk.matrixWorld);
  const legs = legBones.map((l) => ({ upper: joint(l.hb), knee: joint(l.kb), pos: toWorld(l.hip), foot: toWorld(l.foot) }));
  const extra = { body: { node: rootBone, up: upL.clone().multiplyScalar(0.012 * HL) } };
  return buildGenericClips(root, legs, extra, 'Automatisches Skelett');
}

// ---------------------------------------------------------------------------
// Einstieg
// ---------------------------------------------------------------------------
/**
 * Analysiert ein Modell und erzeugt passende Animationen.
 * Rückgabe: { ok, method, legs, gait, clips: [{id, name, clip}], restore(), reason? }
 */
export function analyzeModel(root, { onReplaceMesh } = {}) {
  const fileClips = (root.animations || []).map((clip, i) => ({ id: `file:${i}`, name: clip.name || `Animation ${i + 1}`, clip, fromFile: true }));
  const withFile = (res) => {
    if (res && res.ok) { res.clips.push(...fileClips); return res; }
    if (fileClips.length) return { ok: true, method: 'Animationen aus der Datei', legs: 0, clips: fileClips, restore: () => {} };
    return res || { ok: false, reason: 'Keine Beine erkannt.' };
  };

  const rig = RIGS.get(root);
  if (rig && rig.type === 'arachnid') return withFile(analyzeArachnid(root, rig));
  if (rig && rig.type === 'humanoid') return withFile(analyzeHumanoid(root, rig));

  const bones = new Set();
  root.traverse((o) => { if (o.isSkinnedMesh && o.skeleton) o.skeleton.bones.forEach((b) => bones.add(b)); });
  if (bones.size >= 3) return withFile(analyzeSkeleton(root, [...bones]));

  return withFile(analyzeParts(root) || autoRig(root, onReplaceMesh));
}
