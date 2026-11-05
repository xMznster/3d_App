// Test der automatischen Bein-Erkennung und der Animationen.
// Prüft: Wolfsspinne (eigenes Skelett), Vierbeiner aus Einzelteilen (GLB), einteiliger Vierbeiner (STL,
// automatisches Skelett), Zweibeiner mit Skelett (GLB), Modelle ohne Beine, GLB-Export mit Animationen.
// Aufruf: node tests/animation-test.mjs [screenshot-ordner]
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.argv[2] || join(ROOT, 'tests', 'screenshots');
mkdirSync(SHOTS, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  try {
    let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    if (!p || p.endsWith('/')) p += 'index.html';
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(await readFile(join(ROOT, p)));
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const BASE = `http://localhost:${server.address().port}/`;

let failures = 0;
const check = (c, msg) => { console.log(`   ${c ? '✓' : '✗'} ${msg}`); if (!c) failures++; };

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ ...devices['iPhone 16 Pro'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(BASE + '?demo=spider');
await page.waitForFunction(() => window.__studio?.model, null, { timeout: 90000 });
await page.tap('#help-close');

// Hilfsfunktionen im Browser
await page.evaluate(() => {
  window.__t = {
    async analyze() { const r = await window.__studio.ensureAnalysis(); return r && { ok: r.ok, method: r.method, legs: r.legs, gait: r.gait, clips: (r.clips || []).map((c) => c.id), reason: r.reason }; },
    // Summe der Positionsänderung aller (ggf. geskinnten) Vertices in Weltkoordinaten
    snapshot() {
      const out = [];
      const v = new (window.__studio.camera.position.constructor)();
      window.__studio.model.traverse((o) => {
        if (!o.isMesh) return;
        const p = o.geometry.attributes.position;
        const step = Math.max(1, Math.floor(p.count / 400));
        for (let i = 0; i < p.count; i += step) {
          v.fromBufferAttribute(p, i);
          if (o.isSkinnedMesh) o.applyBoneTransform(i, v);
          v.applyMatrix4(o.matrixWorld);
          out.push(v.x, v.y, v.z);
        }
      });
      return out;
    },
  };
});
const motion = async (mode, ms = 700) => {
  const a = await page.evaluate(() => window.__t.snapshot());
  await page.evaluate((m) => window.__studio.playAnimation(m), mode);
  await page.waitForTimeout(ms);
  await page.evaluate(() => window.__studio.model.updateMatrixWorld(true));
  const b = await page.evaluate(() => window.__t.snapshot());
  let d = 0; for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  return d;
};

// --- 1. Wolfsspinne ---
console.log('\n▶ Wolfsspinne');
let r = await page.evaluate(() => window.__t.analyze());
check(r.ok && r.legs === 8 && r.method === 'Spinnen-Skelett', `8 Beine erkannt (${JSON.stringify(r)})`);
let d = await motion('walk', 900);
check(d > 0.02, `Laufen bewegt die Beine (max. Δ ${d.toFixed(3)})`);
await page.tap('.tool[data-panel="panel-anim"]');
await page.waitForTimeout(400);
await page.screenshot({ path: join(SHOTS, 'anim-1-spinne-panel.png') });
await page.tap('#panel-anim .close');
await page.waitForTimeout(300);
await page.screenshot({ path: join(SHOTS, 'anim-2-spinne-laufen.png') });
d = await motion('idle', 1200);
check(d > 0.001, `Idle bewegt sich (max. Δ ${d.toFixed(4)})`);
await page.evaluate(() => window.__studio.playAnimation('off'));
await page.waitForTimeout(500);
// Aktionen der Spinne
for (const id of ['attack', 'web', 'threat']) {
  d = await motion(id, 900);
  check(d > 0.01, `Aktion ${id} bewegt die Spinne (max. Δ ${d.toFixed(3)})`);
}
await page.evaluate(() => window.__studio.playAnimation('off'));
await page.waitForTimeout(400);

// Figuren mit humanoidem Skelett
for (const [id, method, acts] of [
  ['human', 'Menschen-Skelett', ['wave', 'jump', 'dance']],
  ['bear', 'Animatronik-Skelett', ['scare', 'glitch', 'dance']],
  ['tall', 'Schattenfigur-Skelett', ['appear', 'tendrils', 'stare']],
  ['ghost', 'Geister-Skelett', ['attack', 'scream', 'twist']],
]) {
  console.log(`\n▶ Figur ${id}`);
  await page.evaluate((id) => window.__studio.loadBuiltin(id), id);
  const rr = await page.evaluate(() => window.__t.analyze());
  check(rr.ok && rr.method === method && ['idle', 'walk', ...acts].every((a) => rr.clips.includes(a)), `${method}, Clips ${JSON.stringify(rr.clips)}`);
  for (const a of ['walk', 'idle', ...acts]) {
    d = await motion(a, 700);
    check(d > 0.005, `${a} bewegt die Figur (max. Δ ${d.toFixed(3)})`);
  }
  await page.evaluate(() => window.__studio.playAnimation('off'));
  await page.waitForTimeout(400);
}
// zurück zur Spinne für den Export-Test
await page.evaluate(() => window.__studio.loadBuiltin('spider'));
await page.evaluate(() => window.__t.analyze());

const glbInfo = await page.evaluate(async () => {
  const [x] = await window.__studio.exportAs('glb');
  const buf = await x.blob.arrayBuffer();
  const len = new DataView(buf).getUint32(12, true);
  const j = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, len)));
  window.__glb = buf; // bleibt im Browser (nicht als Zahlenliste übertragen)
  return { size: buf.byteLength, anims: (j.animations || []).map((a) => a.name), skins: (j.skins || []).length };
});
check(['Laufen', 'Idle', 'Angriff', 'Netz spinnen', 'Drohen'].every((n) => glbInfo.anims.includes(n)) && glbInfo.skins > 0, `GLB enthält Skelett + Animationen ${JSON.stringify(glbInfo.anims)} (${(glbInfo.size / 1e6).toFixed(1)} MB)`);

// Re-Import des exportierten GLB: Animationen aus der Datei werden erkannt
await page.evaluate(async () => {
  await window.__studio.openFiles([{ name: 'Spinne_animiert.glb', type: 'model/gltf-binary', data: window.__glb }], { save: false });
});
r = await page.evaluate(() => window.__t.analyze());
check(r.ok && r.clips.some((c) => c.startsWith('file:')), `Re-Import: Animationen aus Datei gefunden (${JSON.stringify(r)})`);

// --- Testmodelle im Browser erzeugen ---
async function makeModel(kind) {
  return page.evaluate(async (kind) => {
    const THREE = await import('three');
    const { mergeGeometries } = await import('three/addons/utils/BufferGeometryUtils.js');
    const mat = new THREE.MeshStandardMaterial({ color: '#c08040' });
    if (kind === 'parts' || kind === 'stl') {
      const body = new THREE.BoxGeometry(1.6, 0.5, 0.7); body.translate(0, 1.0, 0);
      const head = new THREE.BoxGeometry(0.45, 0.45, 0.45); head.translate(0.95, 1.3, 0);
      const legs = [[-0.6, -0.25], [-0.6, 0.25], [0.6, -0.25], [0.6, 0.25]].map(([x, z]) => {
        const g = new THREE.CylinderGeometry(0.1, 0.08, 0.85, 12, 6); g.translate(x, 0.425, z); return g;
      });
      if (kind === 'parts') {
        const grp = new THREE.Group();
        grp.add(new THREE.Mesh(body, mat), new THREE.Mesh(head, mat));
        legs.forEach((g, i) => { const m = new THREE.Mesh(g, mat); m.name = `Bein${i}`; grp.add(m); });
        const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
        const buf = await new GLTFExporter().parseAsync(grp, { binary: true });
        return { name: 'Vierbeiner_Teile.glb', bytes: Array.from(new Uint8Array(buf)) };
      }
      // einteilig (verschmolzen) → STL, Z-oben wie beim 3D-Druck
      const all = [body, head, ...legs].map((g) => g.toNonIndexed());
      all.forEach((g) => { g.deleteAttribute('uv'); g.deleteAttribute('normal'); });
      const merged = mergeGeometries(all);
      // Beine mit dem Körper verbinden (Zylinder ragen 0,1 in den Körper)
      const m = new THREE.Mesh(merged, mat);
      m.rotation.x = Math.PI / 2; m.updateMatrixWorld();
      const { STLExporter } = await import('three/addons/exporters/STLExporter.js');
      const dv = new STLExporter().parse(m, { binary: true });
      return { name: 'Vierbeiner.stl', bytes: Array.from(new Uint8Array(dv.buffer)) };
    }
    if (kind === 'biped') {
      // Zweibeiner mit Skelett: Becken → Oberschenkel → Unterschenkel → Fuß
      const bones = [];
      const B = (name, x, y, z, parent) => { const b = new THREE.Bone(); b.name = name; b.position.set(x, y, z); if (parent) parent.add(b); bones.push(b); return b; };
      const hips = B('Hips', 0, 1.0, 0);
      const spine = B('Spine', 0, 0.3, 0, hips);
      for (const [s, n] of [[1, 'Left'], [-1, 'Right']]) {
        const up = B(`${n}UpLeg`, 0.15 * s, -0.05, 0, hips);
        const lo = B(`${n}Leg`, 0, -0.45, 0, up);
        const ft = B(`${n}Foot`, 0, -0.45, 0, lo);
        B(`${n}ToeBase`, 0, -0.04, 0.1, ft);
        B(`${n}Arm`, 0.25 * s, 0.35, 0, spine);
      }
      const parts = [];
      const torso = new THREE.BoxGeometry(0.5, 0.7, 0.3); torso.translate(0, 1.35, 0);
      parts.push([torso, 0]);
      for (const [s, ui, li] of [[1, 2, 3], [-1, 7, 8]]) {
        const thigh = new THREE.CylinderGeometry(0.08, 0.07, 0.45, 10, 4); thigh.translate(0.15 * s, 0.725, 0); parts.push([thigh, ui]);
        const shin = new THREE.CylinderGeometry(0.07, 0.06, 0.45, 10, 4); shin.translate(0.15 * s, 0.275, 0); parts.push([shin, li]);
      }
      const geos = parts.map(([g, bi]) => {
        g = g.toNonIndexed();
        const n = g.attributes.position.count;
        g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4).map((_, i) => (i % 4 === 0 ? bi : 0)), 4));
        g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4));
        return g;
      });
      const sk = new THREE.SkinnedMesh(mergeGeometries(geos), mat);
      const grp = new THREE.Group();
      grp.add(sk); sk.add(hips); sk.updateMatrixWorld(true);
      sk.bind(new THREE.Skeleton(bones));
      const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
      const buf = await new GLTFExporter().parseAsync(grp, { binary: true });
      return { name: 'Zweibeiner.glb', bytes: Array.from(new Uint8Array(buf)) };
    }
  }, kind);
}
async function openModel(m) {
  await page.evaluate(async (m) => {
    await window.__studio.openFiles([{ name: m.name, type: '', data: new Uint8Array(m.bytes).buffer }], { save: false });
  }, m);
}

for (const [kind, label, expectLegs, expectMethod] of [
  ['parts', 'Vierbeiner aus Einzelteilen (GLB)', 4, 'Einzelteile mit Gelenken'],
  ['stl', 'Vierbeiner einteilig (STL)', 4, 'Automatisches Skelett'],
  ['biped', 'Zweibeiner mit Skelett (GLB)', 2, 'Skelett aus der Datei'],
]) {
  console.log(`\n▶ ${label}`);
  await openModel(await makeModel(kind));
  r = await page.evaluate(() => window.__t.analyze());
  check(r.ok && r.legs === expectLegs && r.method === expectMethod, `${expectLegs} Beine, ${expectMethod} (${JSON.stringify(r)})`);
  if (r.ok) {
    d = await motion('walk', 800);
    check(d > 0.02, `Laufen bewegt das Modell (max. Δ ${d.toFixed(3)})`);
    await page.screenshot({ path: join(SHOTS, `anim-3-${kind}.png`) });
    d = await motion('idle', 800);
    check(d > 0.001, `Idle bewegt das Modell (max. Δ ${d.toFixed(4)})`);
    await page.evaluate(() => window.__studio.playAnimation('off'));
    await page.waitForTimeout(400);
  }
}

console.log('\n▶ Modelle ohne Beine');
for (const id of ['rocket', 'house', 'planet', 'vase']) {
  await page.evaluate((id) => window.__studio.loadBuiltin(id), id);
  r = await page.evaluate(() => window.__t.analyze());
  check(!r.ok, `${id}: keine Beine erkannt`);
}
await page.tap('.tool[data-panel="panel-anim"]');
await page.waitForTimeout(400);
await page.screenshot({ path: join(SHOTS, 'anim-4-keine-beine.png') });

check(errors.length === 0, `keine JS-Fehler ${errors.join(' | ')}`);
await browser.close();
server.close();
console.log(failures ? `\n✗ ${failures} Problem(e)` : '\n✓ Alle Animations-Prüfungen bestanden');
process.exit(failures ? 1 : 0);
