// Bausteine für geriggte (geskinnte) Figuren: Knochen anlegen, Körperteile fest an Knochen binden,
// am Ende pro Material zu einem SkinnedMesh zusammenfassen (wenige Draw-Calls, als GLB exportierbar).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const V = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);

export function setSkin(geo, bone) {
  const n = geo.attributes.position.count;
  const idx = new Uint16Array(n * 4), w = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { idx[i * 4] = bone; w[i * 4] = 1; }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4));
  return geo;
}

/** Kapsel zwischen zwei Punkten */
export function capsule(a, b, r, radial = 16) {
  const dir = b.clone().sub(a);
  const len = Math.max(0.001, dir.length());
  const g = new THREE.CapsuleGeometry(r, len, 6, radial);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}
/** Senkrechte, vorne/hinten abgeflachte Kapsel (Rumpf) */
export function torso(yBottom, yTop, r, depth = 0.65, z = 0) {
  const len = Math.max(0.001, yTop - yBottom);
  const g = new THREE.CapsuleGeometry(r, len, 8, 24);
  g.scale(1, 1, depth);
  g.translate(0, (yBottom + yTop) / 2, z);
  return g;
}
/** Kegelstumpf zwischen zwei Punkten */
export function taper(a, b, r0, r1, radial = 14) {
  const dir = b.clone().sub(a);
  const len = Math.max(0.001, dir.length());
  const g = new THREE.CylinderGeometry(r1, r0, len, radial, 2);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}
/** Ellipsoid an Position, optional gedreht (Euler) */
export function blob(pos, sx, sy, sz, rot = null, seg = [28, 20]) {
  const g = new THREE.SphereGeometry(1, seg[0], seg[1]);
  g.scale(sx, sy, sz);
  if (rot) g.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2])));
  g.translate(pos.x, pos.y, pos.z);
  return g;
}
export function box(pos, sx, sy, sz, rot = null) {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  if (rot) g.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2])));
  g.translate(pos.x, pos.y, pos.z);
  return g;
}

export class RigBuilder {
  constructor(name) {
    this.group = new THREE.Group();
    this.group.name = name;
    this.bones = [];
    this.world = new Map();
    this.parts = new Map(); // Material → Geometrien
    this.names = new Map();
  }
  /** Knochen an Weltposition anlegen (keine Eigenrotation) – gibt den Bone zurück */
  bone(name, world, parent = null) {
    const b = new THREE.Bone();
    b.name = name;
    b.position.copy(world).sub(parent ? this.world.get(parent) : V(0, 0, 0));
    if (parent) parent.add(b);
    this.world.set(b, world.clone());
    this.bones.push(b);
    return b;
  }
  /** Körperteil (Geometrie in Weltkoordinaten) fest an einen Knochen binden */
  add(geo, material, bone, meshName) {
    for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    const g = geo.index ? geo : geo; // alle Grundkörper sind indiziert
    setSkin(g, this.bones.indexOf(bone));
    if (!this.parts.has(material)) this.parts.set(material, []);
    this.parts.get(material).push(g);
    if (meshName) this.names.set(material, meshName);
    return g;
  }
  /**
   * Körperteil mit weichen Gewichten (mehrere Knochen pro Vertex, z. B. Kleid oder Haare).
   * weights(pos: Vector3) → [[bone, gewicht], …]; die vier stärksten werden normalisiert übernommen.
   */
  addWeighted(geo, material, weights) {
    for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    const pos = geo.attributes.position, n = pos.count;
    const idx = new Uint16Array(n * 4), w = new Float32Array(n * 4);
    const v = new THREE.Vector3();
    const index = new Map(this.bones.map((b, k) => [b, k]));
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, i);
      const list = weights(v).filter(([b, x]) => b && x > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4);
      const sum = list.reduce((a, [, x]) => a + x, 0) || 1;
      list.forEach(([b, x], k) => { idx[i * 4 + k] = index.get(b); w[i * 4 + k] = x / sum; });
      if (!list.length) { idx[i * 4] = 0; w[i * 4] = 1; }
    }
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4));
    if (!this.parts.has(material)) this.parts.set(material, []);
    this.parts.get(material).push(geo);
    return geo;
  }
  finish(extra = []) {
    const root = this.bones[0];
    this.group.add(root);
    for (const o of extra) this.group.add(o);
    this.group.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(this.bones);
    for (const [mat, geos] of this.parts) {
      const geo = mergeGeometries(geos.map((g) => (g.index ? g : g)));
      const m = new THREE.SkinnedMesh(geo, mat);
      m.name = this.names.get(mat) || mat.name || 'Teil';
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
      m.bind(skeleton);
      m.computeBoundingBox();
      m.computeBoundingSphere();
    }
    return this.group;
  }
}
