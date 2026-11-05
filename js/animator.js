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
  const animated = [rig.body, rig.abdomen, rig.chelicerae, ...legs.flatMap((l) => [0, 2, 3, 4, 5].map((k) => l.bones[k])), ...palps.flatMap((p) => [p.bones[1], p.bones[3]])];
  ensureNames(root, animated);
  const restore = snapshot(animated);
  const bodyRestY = rig.body.position.y;
  const tracks = [
    { node: rig.body, q: true, p: true }, { node: rig.abdomen, q: true, s: true }, { node: rig.chelicerae, q: true },
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

  return {
    ok: true, method: 'Spinnen-Skelett', legs: legs.length, gait: 'Achtbeiner (Wechselgang)',
    clips: [{ id: 'idle', name: 'Idle', clip: idle }, { id: 'walk', name: 'Laufen', clip: walk }],
    restore,
  };
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
    extra.body?.node, ...(extra.arms || []).map((a) => a.j.node), ...(extra.spine || []).map((s) => s.node),
  ].filter(Boolean);
  ensureNames(root, nodes);
  const restore = snapshot(nodes);
  const rest = new Map(nodes.map((n) => [n, n.position.clone()]));
  const tracks = [...new Set(nodes)].map((node) => ({
    node, q: true,
    p: node === extra.body?.node || legs.some((l) => l.liftNode?.node === node),
  }));
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

  return {
    ok: true, method, legs: legs.length, gait,
    clips: [{ id: 'idle', name: 'Idle', clip: idle }, { id: 'walk', name: 'Laufen', clip: walk }],
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

  // Punkte verschweißen (STL hat getrennte Dreiecke)
  const bb = geo.boundingBox || (geo.computeBoundingBox(), geo.boundingBox);
  const eps = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) * 1e-5 || 1e-6;
  const weld = new Int32Array(n);
  const map = new Map();
  let m = 0;
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos.getX(i) / eps)},${Math.round(pos.getY(i) / eps)},${Math.round(pos.getZ(i) / eps)}`;
    let id = map.get(k);
    if (id === undefined) { id = m++; map.set(k, id); }
    weld[i] = id;
  }
  const wpos = new Float32Array(m * 3), h = new Float32Array(m);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i);
    const id = weld[i];
    wpos[id * 3] = v.x; wpos[id * 3 + 1] = v.y; wpos[id * 3 + 2] = v.z;
    h[id] = v.dot(upL);
  }
  let minH = Infinity, maxH = -Infinity;
  for (let i = 0; i < m; i++) { if (h[i] < minH) minH = h[i]; if (h[i] > maxH) maxH = h[i]; }
  const HL = maxH - minH;
  if (!(HL > 0)) return null;

  // Kanten
  const idx = geo.index ? geo.index.array : null;
  const triCount = idx ? idx.length / 3 : n / 3;
  const edges = new Int32Array(triCount * 6);
  for (let t = 0; t < triCount; t++) {
    const a = weld[idx ? idx[t * 3] : t * 3], b = weld[idx ? idx[t * 3 + 1] : t * 3 + 1], c = weld[idx ? idx[t * 3 + 2] : t * 3 + 2];
    edges.set([a, b, b, c, c, a], t * 6);
  }
  // Union-Find
  const parent = new Int32Array(m);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const components = (inside) => {
    for (let i = 0; i < m; i++) parent[i] = i;
    for (let e = 0; e < edges.length; e += 2) {
      const a = edges[e], b = edges[e + 1];
      if (inside(a) && inside(b)) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
    }
    const size = new Map();
    for (let i = 0; i < m; i++) if (inside(i)) { const r = find(i); size.set(r, (size.get(r) || 0) + 1); }
    const maxSize = Math.max(0, ...size.values());
    return [...size.entries()].filter(([, s]) => s >= Math.max(3, 0.04 * maxSize)).map(([r]) => r);
  };

  // Füße: getrennte Bereiche ganz unten
  const footTop = minH + 0.04 * HL;
  const feet = components((i) => h[i] <= footTop);
  if (feet.length < 2 || feet.length > 8) return null;
  // Hüfthöhe: ab wo laufen die Beine im Querschnitt zusammen?
  let hipH = null;
  for (let j = 1; j <= 34; j++) {
    const lo = minH + j * 0.025 * HL, hi = lo + 0.03 * HL;
    if (components((i) => h[i] >= lo && h[i] <= hi).length < feet.length) { hipH = lo; break; }
  }
  if (hipH === null || hipH < minH + 0.08 * HL) return null;

  // Beinbereiche = alles unterhalb der Hüfte, was mit einem Fuß verbunden ist
  const footRep = components((i) => h[i] <= footTop); // parent[] gehört jetzt wieder zu den Fuß-Komponenten
  const footMember = new Int32Array(m).fill(-1);
  for (let i = 0; i < m; i++) if (h[i] <= footTop) { const r = find(i); const k = footRep.indexOf(r); if (k >= 0) footMember[i] = k; }
  components((i) => h[i] < hipH);
  const legOfRoot = new Map();
  for (let i = 0; i < m; i++) if (footMember[i] >= 0) { const r = find(i); if (!legOfRoot.has(r)) legOfRoot.set(r, legOfRoot.size); }
  const legCount = legOfRoot.size;
  if (legCount < 2 || legCount > 8) return null;
  const legOf = new Int32Array(m).fill(-1);
  for (let i = 0; i < m; i++) if (h[i] < hipH) { const r = find(i); const k = legOfRoot.get(r); if (k !== undefined) legOf[i] = k; }

  // Gelenkpunkte je Bein (Mittelwerte von Querschnitten)
  const legH = hipH - minH;
  const kneeH = minH + 0.5 * legH;
  const acc = () => ({ s: new THREE.Vector3(), c: 0 });
  const hipAcc = [], kneeAcc = [], footAcc = [];
  for (let k = 0; k < legCount; k++) { hipAcc.push(acc()); kneeAcc.push(acc()); footAcc.push(acc()); }
  const bodyAcc = acc();
  for (let i = 0; i < m; i++) {
    v.set(wpos[i * 3], wpos[i * 3 + 1], wpos[i * 3 + 2]);
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
    const id = weld[i], k = legOf[id], hv = h[id];
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

  const bones = new Set();
  root.traverse((o) => { if (o.isSkinnedMesh && o.skeleton) o.skeleton.bones.forEach((b) => bones.add(b)); });
  if (bones.size >= 3) return withFile(analyzeSkeleton(root, [...bones]));

  return withFile(analyzeParts(root) || autoRig(root, onReplaceMesh));
}
