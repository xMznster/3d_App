// Prozedurale Beispielmodelle – werden direkt im Browser erzeugt,
// benötigen keine Downloads und funktionieren daher auch offline.
import * as THREE from 'three';

const mat = (color, opts = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.1, ...opts });

function mesh(geometry, material, name) {
  const m = new THREE.Mesh(geometry, material);
  m.name = name;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function torusKnot() {
  const g = new THREE.Group();
  g.add(mesh(new THREE.TorusKnotGeometry(0.7, 0.24, 220, 32), mat('#d9a441', { metalness: 1, roughness: 0.22 }), 'Knoten'));
  return g;
}

function rocket() {
  const g = new THREE.Group();
  const body = new THREE.LatheGeometry(
    [[0, 0], [0.32, 0], [0.36, 0.2], [0.38, 0.9], [0.34, 1.4], [0.22, 1.8], [0, 2.1]]
      .map(([x, y]) => new THREE.Vector2(x, y)), 48);
  g.add(mesh(body, mat('#eceef2', { metalness: 0.3, roughness: 0.35 }), 'Rumpf'));

  const windowMesh = mesh(new THREE.TorusGeometry(0.11, 0.03, 12, 32), mat('#2b2d33', { metalness: 0.8 }), 'Fensterrahmen');
  windowMesh.position.set(0, 1.25, 0.36);
  windowMesh.rotation.x = -0.12;
  g.add(windowMesh);
  const glass = mesh(new THREE.CircleGeometry(0.11, 32), mat('#3e8ef7', { metalness: 0.6, roughness: 0.1 }), 'Fenster');
  glass.position.set(0, 1.25, 0.355);
  glass.rotation.x = -0.12;
  g.add(glass);

  const finShape = new THREE.Shape();
  finShape.moveTo(0, 0); finShape.lineTo(0.42, -0.18); finShape.lineTo(0.42, 0.05); finShape.lineTo(0, 0.6); finShape.closePath();
  const finGeo = new THREE.ExtrudeGeometry(finShape, { depth: 0.04, bevelEnabled: true, bevelSize: 0.01, bevelThickness: 0.01, bevelSegments: 2 });
  finGeo.translate(0, 0, -0.02);
  for (let i = 0; i < 4; i++) {
    const fin = mesh(finGeo, mat('#e5484d'), `Flosse ${i + 1}`);
    const p = new THREE.Group();
    fin.position.set(0.3, 0.12, 0);
    p.add(fin);
    p.rotation.y = (i * Math.PI) / 2;
    g.add(p);
  }
  const nozzle = mesh(new THREE.CylinderGeometry(0.2, 0.28, 0.2, 32, 1, true), mat('#2b2d33', { metalness: 0.9, roughness: 0.3, side: THREE.DoubleSide }), 'Düse');
  nozzle.position.y = -0.08;
  g.add(nozzle);
  return g;
}

function vase() {
  const pts = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const r = 0.35 + 0.28 * Math.sin(t * Math.PI * 1.15 + 0.3) + 0.06 * Math.sin(t * 18) * (1 - t);
    pts.push(new THREE.Vector2(Math.max(0.12, r), t * 1.8));
  }
  pts.unshift(new THREE.Vector2(0, 0));
  const g = new THREE.Group();
  g.add(mesh(new THREE.LatheGeometry(pts, 96), mat('#3e8ef7', { roughness: 0.15, metalness: 0.05, side: THREE.DoubleSide }), 'Vase'));
  return g;
}

function house() {
  const g = new THREE.Group();
  const walls = mesh(new THREE.BoxGeometry(1.6, 1, 1.2), mat('#f1e7d8', { roughness: 0.8 }), 'Wände');
  walls.position.y = 0.5;
  g.add(walls);

  const roofShape = new THREE.Shape();
  roofShape.moveTo(-0.95, 0); roofShape.lineTo(0, 0.75); roofShape.lineTo(0.95, 0); roofShape.closePath();
  const roofGeo = new THREE.ExtrudeGeometry(roofShape, { depth: 1.4, bevelEnabled: false });
  roofGeo.translate(0, 0, -0.7);
  const roof = mesh(roofGeo, mat('#b5452f', { roughness: 0.7 }), 'Dach');
  roof.position.y = 1;
  g.add(roof);

  const door = mesh(new THREE.BoxGeometry(0.3, 0.55, 0.04), mat('#6b4226', { roughness: 0.6 }), 'Tür');
  door.position.set(-0.35, 0.275, 0.61);
  g.add(door);
  const winMat = mat('#9fd3ff', { metalness: 0.5, roughness: 0.1 });
  for (const x of [0.25, 0.6]) {
    const w = mesh(new THREE.BoxGeometry(0.24, 0.24, 0.04), winMat, 'Fenster');
    w.position.set(x, 0.6, 0.61);
    g.add(w);
  }
  const chimney = mesh(new THREE.BoxGeometry(0.18, 0.5, 0.18), mat('#7a7f8a', { roughness: 0.9 }), 'Schornstein');
  chimney.position.set(0.45, 1.5, -0.2);
  g.add(chimney);
  return g;
}

function planet() {
  const g = new THREE.Group();
  g.add(mesh(new THREE.SphereGeometry(0.75, 64, 48), mat('#d9a441', { roughness: 0.55 }), 'Planet'));
  const ring = mesh(new THREE.RingGeometry(1.0, 1.5, 96, 1), mat('#c9b48a', { side: THREE.DoubleSide, roughness: 0.6, transparent: true, opacity: 0.85 }), 'Ring');
  ring.rotation.x = -Math.PI / 2 + 0.35;
  g.add(ring);
  const moon = mesh(new THREE.IcosahedronGeometry(0.16, 2), mat('#9aa0ab', { flatShading: true, roughness: 0.9 }), 'Mond');
  moon.position.set(1.7, 0.4, 0.4);
  g.add(moon);
  return g;
}

function gear() {
  const teeth = 16, rOuter = 0.9, rInner = 0.75, rHole = 0.25;
  const s = new THREE.Shape();
  for (let i = 0; i < teeth; i++) {
    const a0 = (i / teeth) * Math.PI * 2;
    const step = (Math.PI * 2) / teeth;
    const pts = [
      [rInner, a0], [rOuter, a0 + step * 0.15], [rOuter, a0 + step * 0.45], [rInner, a0 + step * 0.6],
    ];
    pts.forEach(([r, a], j) => {
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (i === 0 && j === 0) s.moveTo(x, y); else s.lineTo(x, y);
    });
  }
  s.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, rHole, 0, Math.PI * 2, true);
  s.holes.push(hole);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    const h = new THREE.Path();
    h.absarc(Math.cos(a) * 0.52, Math.sin(a) * 0.52, 0.1, 0, Math.PI * 2, true);
    s.holes.push(h);
  }
  const geo = new THREE.ExtrudeGeometry(s, { depth: 0.25, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 2, curveSegments: 24 });
  geo.translate(0, 0, -0.125);
  const g = new THREE.Group();
  const m = mesh(geo, mat('#9aa0ab', { metalness: 1, roughness: 0.3 }), 'Zahnrad');
  m.rotation.x = -Math.PI / 2;
  g.add(m);
  return g;
}

function tree() {
  const g = new THREE.Group();
  const trunk = mesh(new THREE.CylinderGeometry(0.1, 0.15, 0.7, 10), mat('#7a4b2a', { roughness: 0.9 }), 'Stamm');
  trunk.position.y = 0.35;
  g.add(trunk);
  const leaf = mat('#30a46c', { flatShading: true, roughness: 0.8 });
  [[0.7, 0.75, 0.55], [1.1, 0.6, 0.45], [1.45, 0.42, 0.35]].forEach(([y, r, h], i) => {
    const c = mesh(new THREE.ConeGeometry(r, h * 1.6, 9), leaf, `Krone ${i + 1}`);
    c.position.y = y;
    g.add(c);
  });
  return g;
}

function diamond() {
  const g = new THREE.Group();
  const pts = [[0, -0.9], [0.8, 0.15], [0.55, 0.45], [0, 0.45]].map(([x, y]) => new THREE.Vector2(x, y));
  g.add(mesh(new THREE.LatheGeometry(pts, 12), mat('#9fd3ff', { metalness: 0.2, roughness: 0.05, flatShading: true }), 'Diamant'));
  return g;
}

export const BUILTIN_MODELS = [
  { id: 'rocket', name: 'Rakete', create: rocket },
  { id: 'knot', name: 'Torusknoten', create: torusKnot },
  { id: 'house', name: 'Haus', create: house },
  { id: 'planet', name: 'Planet', create: planet },
  { id: 'gear', name: 'Zahnrad', create: gear },
  { id: 'vase', name: 'Vase', create: vase },
  { id: 'tree', name: 'Baum', create: tree },
  { id: 'diamond', name: 'Diamant', create: diamond },
];
