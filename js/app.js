// 3D Studio – WebGL-Viewer für iPhone 16 Pro (Safari / Home-Bildschirm-App)
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { BUILTIN_MODELS } from './models.js';
import * as store from './storage.js';
import { analyzeModel } from './animator.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------------------------------------------------------------------------
// Einstellungen (pro Gerät gemerkt)
// ---------------------------------------------------------------------------
const prefs = Object.assign(
  { autoRotate: false, wireframe: false, shadow: true, grid: false, bg: 'dark', color: '', quality: 'auto', helpSeen: false },
  safeRead('3d-studio-prefs'),
);
function safeRead(key) {
  try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; }
}
function savePrefs() {
  try { localStorage.setItem('3d-studio-prefs', JSON.stringify(prefs)); } catch { /* privat-Modus */ }
}

const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const DPR = Math.min(window.devicePixelRatio || 1, 3); // iPhone 16 Pro: 3×

// ---------------------------------------------------------------------------
// Renderer & Szene
// ---------------------------------------------------------------------------
const canvas = $('#scene');
const viewportEl = $('#viewport');

let renderer;
try {
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  });
} catch (err) {
  document.body.innerHTML = '<div class="nojs">WebGL ist auf diesem Gerät nicht verfügbar.</div>';
  throw err;
}
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 200);
const HOME = { pos: new THREE.Vector3(2.6, 1.9, 3.6), target: new THREE.Vector3(0, 0.85, 0) };
camera.position.copy(HOME.pos);

// Licht für Schatten (Umgebung kommt vom RoomEnvironment)
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(2.5, 5, 2);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -2.5; sun.shadow.camera.right = 2.5;
sun.shadow.camera.top = 2.5; sun.shadow.camera.bottom = -2.5;
sun.shadow.camera.near = 0.5; sun.shadow.camera.far = 12;
sun.shadow.bias = -0.0005;
sun.shadow.radius = 4;
scene.add(sun);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.ShadowMaterial({ opacity: 0.28 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(6, 24, 0x888888, 0x444444);
grid.material.transparent = true;
grid.material.opacity = 0.35;
grid.position.y = 0.001;
scene.add(grid);

// displayGroup skaliert/zentriert für die Anzeige, currentModel bleibt unverändert (für Export)
const displayGroup = new THREE.Group();
scene.add(displayGroup);
let currentModel = null;
let currentMeta = null; // { name, kind: 'builtin'|'saved'|'file', builtinId?, savedId?, files? }

// ---------------------------------------------------------------------------
// Touch-Steuerung: 1 Finger drehen, 2 Finger zoomen + verschieben
// ---------------------------------------------------------------------------
const controls = new OrbitControls(camera, canvas);
controls.target.copy(HOME.target);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.rotateSpeed = 0.9;
controls.zoomSpeed = 1.0;
controls.panSpeed = 0.9;
controls.screenSpacePanning = true;
controls.minDistance = 0.6;
controls.maxDistance = 18;
controls.maxPolarAngle = Math.PI * 0.95;
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
controls.autoRotateSpeed = 2.0;
controls.update();

let needsRender = true;
const requestRender = () => { needsRender = true; };
controls.addEventListener('change', requestRender);

// Doppeltippen → Ansicht zurücksetzen
let lastTap = { t: 0, x: 0, y: 0 };
let tapStart = null;
const activePointers = new Set();
canvas.addEventListener('pointerdown', (e) => {
  // Ein neuer "primärer" Finger heißt: alle vorherigen Berührungen sind beendet
  if (e.isPrimary) activePointers.clear();
  activePointers.add(e.pointerId);
  tapStart = activePointers.size === 1 ? { t: performance.now(), x: e.clientX, y: e.clientY } : null;
});
const endPointer = (e) => {
  activePointers.delete(e.pointerId);
  if (!tapStart || e.type === 'pointercancel') { tapStart = null; return; }
  const now = performance.now();
  const moved = Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y);
  if (now - tapStart.t < 280 && moved < 12) {
    if (now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
      resetView();
      lastTap.t = 0;
    } else {
      lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
  }
  tapStart = null;
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

// Safari: Seiten-Zoom per Geste / Doppeltipp unterbinden (user-scalable=no wird ignoriert)
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => {
  // Scrollen nur innerhalb von Panels erlauben
  if (!e.target.closest('.sheet-body, .card')) e.preventDefault();
}, { passive: false });

// Kamera-Animation
let camAnim = null;
function animateCamera(toPos, toTarget, ms = 450) {
  // Restschwung (Dämpfung) der letzten Geste verwerfen, sonst driftet die Kamera weiter
  controls.enableDamping = false;
  controls.update();
  camAnim = {
    t0: performance.now(), ms,
    fromPos: camera.position.clone(), fromTarget: controls.target.clone(),
    toPos: toPos.clone(), toTarget: toTarget.clone(),
  };
  requestRender();
}
function resetView() {
  const portrait = window.innerHeight > window.innerWidth;
  const pos = HOME.pos.clone().sub(HOME.target).multiplyScalar(portrait ? 1.15 : 0.95).add(HOME.target);
  animateCamera(pos, HOME.target);
}

// ---------------------------------------------------------------------------
// Größe / Auflösung (Hoch- & Querformat, Retina 3×)
// ---------------------------------------------------------------------------
let pixelRatio = 1;
function targetPixelRatio() {
  if (prefs.quality === 'high') return DPR;
  if (prefs.quality === 'eco') return Math.min(DPR, 2);
  return autoPixelRatio;
}
let autoPixelRatio = DPR;

function resize() {
  const w = viewportEl.clientWidth;
  const h = viewportEl.clientHeight;
  if (!w || !h) return;
  pixelRatio = targetPixelRatio();
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // Im Hochformat etwas weiteres Sichtfeld, damit das Modell ganz zu sehen ist
  camera.fov = w < h ? 45 : 35;
  camera.updateProjectionMatrix();
  requestRender();
}
new ResizeObserver(resize).observe(viewportEl);
window.addEventListener('orientationchange', () => setTimeout(resize, 250));
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------
// Render-Schleife (rendert nur bei Bedarf → schont Akku, flüssig mit 60/120 Hz)
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
let frameTimes = [];
let lastFrame = 0;
let fps = 0;

function loop(now) {
  requestAnimationFrame(loop);
  const dt = clock.getDelta();

  if (camAnim) {
    const k = Math.min(1, (now - camAnim.t0) / camAnim.ms);
    const e = 1 - Math.pow(1 - k, 3);
    camera.position.lerpVectors(camAnim.fromPos, camAnim.toPos, e);
    controls.target.lerpVectors(camAnim.fromTarget, camAnim.toTarget, e);
    if (k >= 1) { camAnim = null; controls.enableDamping = true; }
    needsRender = true;
  }

  if (anim.mixer && anim.mode !== 'off') {
    anim.mixer.update(Math.min(dt, 0.1));
    needsRender = true;
  }

  const changed = controls.update(dt);
  if (!changed && !needsRender) { lastFrame = 0; return; }
  needsRender = false;
  renderer.render(scene, camera);

  // Adaptive Qualität: bei Rucklern Auflösung leicht senken
  if (lastFrame) {
    frameTimes.push(now - lastFrame);
    if (frameTimes.length >= 40) {
      const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
      fps = Math.round(1000 / avg);
      frameTimes = [];
      if (prefs.quality === 'auto' && avg > 24 && autoPixelRatio > 1.5) {
        autoPixelRatio = Math.max(1.5, autoPixelRatio - 0.5);
        resize();
      }
      updateStats();
    }
  }
  lastFrame = now;
}
requestAnimationFrame(loop);

canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  showLoading('Grafik wird wiederhergestellt…');
});
canvas.addEventListener('webglcontextrestored', () => {
  hideLoading();
  requestRender();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) requestRender(); });

// ---------------------------------------------------------------------------
// Modell anzeigen
// ---------------------------------------------------------------------------
const TARGET_SIZE = 2;
// Originalmaterialien getrennt merken (nicht in userData – das würde beim GLB-Export mitgeschrieben)
const origMaterials = new WeakMap();

function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = [o.material, origMaterials.get(o)].flat().filter(Boolean);
    for (const m of mats) {
      for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
      m.dispose();
    }
  });
}

function showModel(object, meta) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty() || !isFinite(box.min.x)) throw new Error('Das Modell enthält keine sichtbare Geometrie.');

  resetAnimation();
  if (currentModel) {
    displayGroup.remove(currentModel);
    disposeObject(currentModel);
  }
  object.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });

  currentModel = object;
  currentMeta = meta;
  displayGroup.add(object);

  // Für die Anzeige auf einheitliche Größe bringen und auf den Boden stellen
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const s = TARGET_SIZE / Math.max(size.x, size.y, size.z);
  displayGroup.scale.setScalar(s);
  displayGroup.position.set(-center.x * s, -box.min.y * s, -center.z * s);
  displayGroup.updateMatrixWorld(true);

  HOME.target.set(0, (size.y * s) / 2, 0);
  applyColor();
  applyWireframe();
  autoPixelRatio = DPR;
  resize();
  resetView();

  $('#model-name').textContent = meta.name;
  $('#fmt-original').hidden = !meta.files;
  $('#save-ready').hidden = true;
  $$('.model-card').forEach((c) => c.classList.toggle('active', c.dataset.id === meta.builtinId));
  updateStats();
  requestRender();
}

function applyColor() {
  if (!currentModel) return;
  currentModel.traverse((o) => {
    if (!o.isMesh) return;
    if (!origMaterials.has(o)) origMaterials.set(o, o.material);
    const orig = origMaterials.get(o);
    if (o.material !== orig) {
      [o.material].flat().forEach((m) => m.dispose());
    }
    if (!prefs.color) {
      o.material = orig;
    } else {
      const src = [orig].flat();
      const mats = src.map((m) => {
        const n = new THREE.MeshStandardMaterial({
          color: prefs.color,
          roughness: m.roughness ?? 0.45,
          metalness: m.metalness ?? 0.1,
          side: m.side,
          flatShading: m.flatShading,
          vertexColors: false,
        });
        n.name = m.name;
        return n;
      });
      o.material = Array.isArray(orig) ? mats : mats[0];
    }
  });
  applyWireframe();
  requestRender();
}

function applyWireframe() {
  if (!currentModel) return;
  currentModel.traverse((o) => {
    if (o.isMesh) [o.material].flat().forEach((m) => { m.wireframe = prefs.wireframe; });
  });
  requestRender();
}

function updateStats() {
  if (!currentModel) return;
  let tris = 0, meshes = 0;
  currentModel.traverse((o) => {
    if (o.isMesh && o.geometry) {
      meshes++;
      const g = o.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    }
  });
  const w = renderer.domElement.width, h = renderer.domElement.height;
  $('#stats').textContent =
    `${Math.round(tris).toLocaleString('de-DE')} Dreiecke · ${meshes} Teile · ${w}×${h} px (${pixelRatio}×)` +
    (fps ? ` · ${fps} fps` : '');
}

function loadBuiltin(id) {
  const def = BUILTIN_MODELS.find((m) => m.id === id) || BUILTIN_MODELS[0];
  const obj = def.create();
  obj.name = def.name;
  showModel(obj, { name: def.name, kind: 'builtin', builtinId: def.id });
}

// ---------------------------------------------------------------------------
// Dateien laden (GLB, GLTF, OBJ, STL)
// ---------------------------------------------------------------------------
const MAIN_EXT = ['glb', 'gltf', 'obj', 'stl'];
const extOf = (name) => (name.split('.').pop() || '').toLowerCase();
const baseName = (p) => decodeURIComponent(p.split(/[\\/]/).pop().split('?')[0]);

/** files: Array<{name, type, data: ArrayBuffer}> */
async function parseFiles(files) {
  const main = files.find((f) => MAIN_EXT.includes(extOf(f.name)));
  if (!main) throw new Error('Kein unterstütztes 3D-Format gefunden (GLB, GLTF, OBJ, STL).');
  const ext = extOf(main.name);

  if (ext === 'glb' || ext === 'gltf') {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const blobUrls = new Map();
    for (const f of files) if (f !== main) blobUrls.set(f.name, URL.createObjectURL(new Blob([f.data], { type: f.type })));
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => blobUrls.get(baseName(url)) || url);
    const loader = new GLTFLoader(manager);
    try {
      const gltf = await loader.parseAsync(main.data, '');
      const root = gltf.scene || gltf.scenes[0];
      root.animations = gltf.animations || []; // vorhandene Animationen behalten
      return root;
    } finally {
      // Texturen sind nach dem Parsen geladen
      setTimeout(() => blobUrls.forEach((u) => URL.revokeObjectURL(u)), 5000);
    }
  }

  if (ext === 'obj') {
    const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
    const text = new TextDecoder().decode(main.data);
    const obj = new OBJLoader().parse(text);
    obj.traverse((o) => {
      if (o.isMesh) {
        const hadNormals = !!o.geometry.attributes.normal;
        if (!hadNormals) o.geometry.computeVertexNormals();
        o.material = new THREE.MeshStandardMaterial({ color: '#c9ccd3', roughness: 0.5, metalness: 0.1, side: THREE.DoubleSide });
      }
    });
    return obj;
  }

  // STL
  const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
  const geo = new STLLoader().parse(main.data);
  geo.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color: geo.hasColors ? 0xffffff : '#c9ccd3',
    vertexColors: !!geo.hasColors,
    roughness: 0.5,
    metalness: 0.1,
  });
  const m = new THREE.Mesh(geo, material);
  m.name = main.name.replace(/\.stl$/i, '');
  m.rotation.x = -Math.PI / 2; // STL ist meist Z-oben (3D-Druck) → für die Anzeige Y-oben
  const g = new THREE.Group();
  g.add(m);
  return g;
}

async function openFiles(files, { save = true, savedId = null } = {}) {
  const main = files.find((f) => MAIN_EXT.includes(extOf(f.name)));
  const name = main ? main.name.replace(/\.[^.]+$/, '') : 'Modell';
  showLoading(`„${name}“ wird geladen…`);
  try {
    const obj = await parseFiles(files);
    obj.name = obj.name || name;
    showModel(obj, { name, kind: savedId ? 'saved' : 'file', savedId, files });
    closeSheets();
    if (save && !savedId) {
      try {
        await store.saveModel(name, files);
        await store.requestPersistence();
        renderSavedList();
        toast(`„${name}“ geöffnet und unter „Meine Modelle“ gespeichert`);
      } catch {
        toast(`„${name}“ geöffnet (Speichern nicht möglich)`);
      }
    }
  } catch (err) {
    console.error(err);
    toast(`Fehler: ${err.message || err}`, 4500);
  } finally {
    hideLoading();
  }
}

$('#file-input').addEventListener('change', async (e) => {
  const list = Array.from(e.target.files || []);
  e.target.value = '';
  if (!list.length) return;
  showLoading('Datei wird gelesen…');
  try {
    const files = await Promise.all(list.map(async (f) => ({ name: f.name, type: f.type, data: await f.arrayBuffer() })));
    await openFiles(files);
  } catch (err) {
    hideLoading();
    toast(`Fehler beim Lesen: ${err.message || err}`, 4500);
  }
});

async function openUrl(url) {
  showLoading('Wird heruntergeladen…');
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.arrayBuffer();
    let name = baseName(new URL(url, location.href).pathname) || 'modell.glb';
    if (!MAIN_EXT.includes(extOf(name))) name += '.glb';
    await openFiles([{ name, type: res.headers.get('content-type') || '', data }]);
  } catch (err) {
    hideLoading();
    toast(`Laden fehlgeschlagen: ${err.message || err}`, 4500);
  }
}
$('#url-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#url-input').value.trim();
  if (v) { $('#url-input').blur(); openUrl(v); }
});

// ---------------------------------------------------------------------------
// Animation: automatische Bein-Erkennung, Laufen & Idle
// ---------------------------------------------------------------------------
const anim = { result: null, mixer: null, action: null, mode: 'off', base: 'off', speed: 1, busy: false };

function resetAnimation() {
  if (anim.mixer) { anim.mixer.stopAllAction(); anim.mixer.uncacheRoot(anim.mixer.getRoot()); }
  if (anim.result?.restore) anim.result.restore();
  Object.assign(anim, { result: null, mixer: null, action: null, mode: 'off', base: 'off', busy: false });
  renderAnimPanel();
}

async function ensureAnalysis() {
  if (anim.result || anim.busy || !currentModel) return anim.result;
  anim.busy = true;
  renderAnimPanel();
  await new Promise((r) => setTimeout(r, 40)); // Anzeige „Analysiere…“ zuerst zeichnen
  const model = currentModel;
  let res;
  try {
    res = analyzeModel(model, {
      onReplaceMesh: (oldMesh, newMesh) => { if (origMaterials.has(oldMesh)) origMaterials.set(newMesh, origMaterials.get(oldMesh)); },
    });
  } catch (err) {
    console.error(err);
    res = { ok: false, reason: `Analyse fehlgeschlagen: ${err.message || err}` };
  }
  if (model !== currentModel) return null; // inzwischen anderes Modell geladen
  anim.result = res;
  anim.busy = false;
  applyWireframe();
  renderAnimPanel();
  requestRender();
  return res;
}

function playAnimation(id) {
  const res = anim.result;
  if (id === 'off' || !res?.ok) {
    anim.base = 'off';
    const mixer = anim.mixer;
    if (anim.action) anim.action.fadeOut(0.25);
    anim.action = null;
    anim.mode = mixer ? 'fading' : 'off'; // kurz weiterrechnen, damit das Ausblenden sichtbar ist
    if (mixer) {
      setTimeout(() => {
        if (anim.mode !== 'fading' || anim.mixer !== mixer) return;
        mixer.stopAllAction();
        if (anim.result?.restore) anim.result.restore();
        anim.mode = 'off';
        renderAnimPanel();
        requestRender();
      }, 280);
    }
    renderAnimPanel();
    return;
  }
  const entry = res.clips.find((c) => c.id === id);
  if (!entry) return;
  if (!anim.mixer) {
    anim.mixer = new THREE.AnimationMixer(currentModel);
    // Einmalige Aktion fertig → zurück zur vorherigen Dauer-Animation (oder Idle)
    anim.mixer.addEventListener('finished', (e) => {
      if (e.action !== anim.action) return;
      playAnimation(anim.base === 'off' ? 'idle' : anim.base);
    });
  }
  const action = anim.mixer.clipAction(entry.clip);
  if (entry.once) {
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    if (anim.action === action) action.reset();
  } else {
    action.setLoop(THREE.LoopRepeat, Infinity);
    anim.base = id;
  }
  if (anim.action && anim.action !== action) {
    action.reset().play();
    anim.action.crossFadeTo(action, 0.35, false);
  } else if (anim.action !== action) {
    action.reset().fadeIn(0.25).play();
  }
  anim.action = action;
  anim.mode = id;
  anim.mixer.timeScale = anim.speed;
  renderAnimPanel();
  requestRender();
}

function renderAnimPanel() {
  const status = $('#anim-status');
  if (!status) return;
  const res = anim.result;
  const modes = $('#anim-mode');
  const fileBox = $('#anim-file');
  const actBox = $('#anim-actions');
  fileBox.innerHTML = '';
  actBox.innerHTML = '';
  let canPlay = false;
  if (anim.busy) {
    status.className = 'anim-status busy';
    status.innerHTML = '<div class="spinner"></div><div><b>Analysiere Modell…</b><br><small>Suche nach Beinen und Gelenken</small></div>';
  } else if (!res) {
    status.className = 'anim-status';
    status.innerHTML = '<div class="ico">🔍</div><div><b>Noch nicht analysiert</b><br><small>Wähle „Idle“ oder „Laufen“ – die Beine werden automatisch erkannt.</small></div>';
    canPlay = true;
  } else if (res.ok) {
    status.className = 'anim-status ok';
    const legs = res.legs ? `${res.legs} Beine erkannt` : 'Animationen gefunden';
    const info = [res.method, res.gait].filter(Boolean).join(' · ');
    status.innerHTML = `<div class="ico">✓</div><div><b></b><br><small></small></div>`;
    status.querySelector('b').textContent = legs;
    status.querySelector('small').textContent = info;
    canPlay = true;
    const chip = (c, box, icon) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.setAttribute('aria-pressed', String(anim.mode === c.id));
      b.textContent = `${icon} ${c.name}`;
      b.addEventListener('click', () => playAnimation(anim.mode === c.id && !c.once ? 'off' : c.id));
      box.appendChild(b);
    };
    const ICONS = { attack: '⚔️', web: '🕸️', threat: '😠', jump: '⤴️', look: '👀', dance: '💃', wave: '👋', scare: '😱', glitch: '⚡', appear: '👻', tendrils: '🦑', stare: '👁️', scream: '🗣️', twist: '🌀' };
    for (const c of res.clips.filter((x) => x.once)) chip(c, actBox, ICONS[c.id] || '▶');
    for (const c of res.clips.filter((x) => x.fromFile)) chip(c, fileBox, '▶');
  } else {
    status.className = 'anim-status fail';
    status.innerHTML = '<div class="ico">✕</div><div><b>Keine Beine erkannt</b><br><small></small></div>';
    status.querySelector('small').textContent = res.reason && res.reason !== 'Keine Beine erkannt.' ? res.reason : 'Dieses Modell hat keine erkennbaren Beine, die den Boden berühren.';
  }
  fileBox.hidden = $('#anim-file-h').hidden = !fileBox.children.length;
  actBox.hidden = $('#anim-actions-h').hidden = !actBox.children.length;
  const hasGen = !res || (res.ok && res.clips.some((c) => c.id === 'walk'));
  modes.querySelectorAll('button').forEach((b) => {
    const v = b.dataset.value;
    b.disabled = anim.busy || (!canPlay && v !== 'off') || (v !== 'off' && !hasGen);
    const isOnce = res?.clips?.find((c) => c.id === anim.mode)?.once;
    const cur = anim.mode === 'fading' ? 'off' : isOnce ? anim.base : anim.mode;
    b.setAttribute('aria-checked', String(v === cur || (v === 'off' && cur.startsWith('file:'))));
  });
}

$('#anim-mode').querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
  const v = b.dataset.value;
  if (v === 'off') { playAnimation('off'); return; }
  const res = await ensureAnalysis();
  if (res?.ok) playAnimation(v);
}));
$('#anim-speed').addEventListener('input', (e) => {
  anim.speed = parseFloat(e.target.value);
  $('#anim-speed-out').textContent = `${anim.speed.toFixed(2).replace('.', ',')}×`;
  if (anim.mixer) anim.mixer.timeScale = anim.speed;
});

// ---------------------------------------------------------------------------
// Bibliothek: Beispielmodelle (mit Vorschaubildern) & gespeicherte Modelle
// ---------------------------------------------------------------------------
function renderBuiltinList() {
  const list = $('#builtin-list');
  list.innerHTML = '';
  for (const def of BUILTIN_MODELS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'model-card';
    b.dataset.id = def.id;
    b.innerHTML = `<img alt="" width="96" height="96"><span></span>`;
    b.querySelector('span').textContent = def.name;
    b.addEventListener('click', () => { loadBuiltin(def.id); closeSheets(); });
    list.appendChild(b);
  }
  if (currentMeta) $$('.model-card').forEach((c) => c.classList.toggle('active', c.dataset.id === currentMeta.builtinId));
}

let thumbsDone = false;
function renderThumbnails() {
  if (thumbsDone) return;
  thumbsDone = true;
  // Einmalig mit kleinem Offscreen-Renderer, danach wieder freigeben
  const size = 192;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  let r;
  try {
    r = new THREE.WebGLRenderer({ canvas: c, antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch { return; }
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.toneMapping = THREE.NeutralToneMapping;
  r.setPixelRatio(1);
  r.setSize(size, size, false);
  const pm = new THREE.PMREMGenerator(r);
  const s = new THREE.Scene();
  s.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  const cam = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  const cards = $$('#builtin-list .model-card');
  BUILTIN_MODELS.forEach((def, i) => {
    const obj = def.create();
    const box = new THREE.Box3().setFromObject(obj);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    s.add(obj);
    const dir = new THREE.Vector3(1, 0.7, 1.4).normalize();
    cam.position.copy(sphere.center).addScaledVector(dir, sphere.radius / Math.sin(THREE.MathUtils.degToRad(17.5)));
    cam.lookAt(sphere.center);
    r.render(s, cam);
    const img = cards[i] && cards[i].querySelector('img');
    if (img) img.src = c.toDataURL('image/png');
    s.remove(obj);
    disposeObject(obj);
  });
  s.environment.dispose();
  pm.dispose();
  r.dispose();
  r.forceContextLoss();
}

const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

async function renderSavedList() {
  const ul = $('#saved-list');
  let items = [];
  try { items = await store.listModels(); } catch { /* kein IndexedDB */ }
  ul.innerHTML = '';
  $('#saved-empty').hidden = items.length > 0;
  for (const it of items) {
    const li = document.createElement('li');
    li.innerHTML = `<button type="button" class="open"><b></b><small></small></button>
      <button type="button" class="del" aria-label="Löschen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg></button>`;
    li.querySelector('b').textContent = it.name;
    li.querySelector('small').textContent = `${fmtSize(it.size)} · ${new Date(it.date).toLocaleDateString('de-DE')}`;
    li.querySelector('.open').addEventListener('click', async () => {
      const rec = await store.getModel(it.id);
      if (rec) openFiles(rec.files, { savedId: it.id, save: false });
    });
    li.querySelector('.del').addEventListener('click', async () => {
      if (!confirm(`„${it.name}“ von diesem iPhone löschen?`)) return;
      await store.deleteModel(it.id);
      renderSavedList();
      toast('Gelöscht');
    });
    ul.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Export / Download (GLB, USDZ, STL, OBJ, PNG, Original)
// ---------------------------------------------------------------------------
// Für STL/OBJ/USDZ: Originalgröße, auf den Boden gestellt und zentriert.
function withExportTransform({ zUp = false } = {}, fn) {
  const saved = { p: displayGroup.position.clone(), s: displayGroup.scale.clone(), r: displayGroup.rotation.clone() };
  displayGroup.scale.setScalar(1);
  displayGroup.position.set(0, 0, 0);
  displayGroup.rotation.set(zUp ? Math.PI / 2 : 0, 0, 0);
  displayGroup.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(currentModel);
  const c = box.getCenter(new THREE.Vector3());
  if (zUp) displayGroup.position.set(-c.x, -c.y, -box.min.z);
  else displayGroup.position.set(-c.x, -box.min.y, -c.z);
  displayGroup.updateMatrixWorld(true);
  const restore = () => {
    displayGroup.position.copy(saved.p);
    displayGroup.scale.copy(saved.s);
    displayGroup.rotation.copy(saved.r);
    displayGroup.updateMatrixWorld(true);
    requestRender();
  };
  try {
    const out = fn(displayGroup);
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
  } catch (e) { restore(); throw e; }
}

const safeName = () => (currentMeta?.name || 'modell').replace(/[^\p{L}\p{N}_\- ]+/gu, '').trim().replace(/\s+/g, '_') || 'modell';

async function exportAs(format) {
  if (!currentModel) throw new Error('Kein Modell geladen');
  const base = safeName();
  switch (format) {
    case 'glb': {
      const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
      const buf = await withExportTransform({}, (root) => new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: true, animations: anim.result?.ok ? anim.result.clips.map((c) => c.clip) : [] }));
      return [{ blob: new Blob([buf], { type: 'model/gltf-binary' }), name: `${base}.glb` }];
    }
    case 'usdz': {
      const { USDZExporter } = await import('three/addons/exporters/USDZExporter.js');
      const data = await withExportTransform({}, (root) => new USDZExporter().parseAsync(root, { quickLookCompatible: true }));
      return [{ blob: new Blob([data], { type: 'model/vnd.usdz+zip' }), name: `${base}.usdz` }];
    }
    case 'stl': {
      const { STLExporter } = await import('three/addons/exporters/STLExporter.js');
      const data = withExportTransform({ zUp: true }, (root) => new STLExporter().parse(root, { binary: true }));
      return [{ blob: new Blob([data], { type: 'model/stl' }), name: `${base}.stl` }];
    }
    case 'obj': {
      const { OBJExporter } = await import('three/addons/exporters/OBJExporter.js');
      const text = withExportTransform({}, (root) => new OBJExporter().parse(root));
      return [{ blob: new Blob([text], { type: 'model/obj' }), name: `${base}.obj` }];
    }
    case 'png': {
      renderer.render(scene, camera);
      const blob = await new Promise((res) => renderer.domElement.toBlob(res, 'image/png'));
      if (!blob) throw new Error('Bild konnte nicht erstellt werden');
      return [{ blob, name: `${base}.png` }];
    }
    case 'original': {
      return (currentMeta.files || []).map((f) => ({ blob: new Blob([f.data], { type: f.type || 'application/octet-stream' }), name: f.name }));
    }
    default: throw new Error('Unbekanntes Format');
  }
}

let prepared = null;
let preparedUrl = null;

$$('.fmt').forEach((btn) => btn.addEventListener('click', async () => {
  if (btn.classList.contains('busy')) return;
  btn.classList.add('busy');
  showLoading('Datei wird erstellt…');
  try {
    prepared = await exportAs(btn.dataset.format);
    if (preparedUrl) URL.revokeObjectURL(preparedUrl);
    const first = prepared[0];
    preparedUrl = URL.createObjectURL(first.blob);
    const dl = $('#btn-download');
    dl.href = preparedUrl;
    dl.download = first.name;
    const total = prepared.reduce((s, p) => s + p.blob.size, 0);
    $('#save-info').textContent = `✓ ${prepared.map((p) => p.name).join(', ')} (${fmtSize(total)}) ist bereit.`;
    const shareFiles = toFiles(prepared);
    $('#btn-share').hidden = !(navigator.canShare && navigator.canShare({ files: shareFiles }));
    $('#save-ready').hidden = false;
    $('#save-ready').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (err) {
    console.error(err);
    toast(`Export fehlgeschlagen: ${err.message || err}`, 4500);
  } finally {
    btn.classList.remove('busy');
    hideLoading();
  }
}));

function toFiles(items) {
  return items.map((p) => new File([p.blob], p.name, { type: p.blob.type || 'application/octet-stream' }));
}

// Teilen-Menü von iOS → „In Dateien sichern“, AirDrop, Nachrichten …
$('#btn-share').addEventListener('click', async () => {
  if (!prepared) return;
  try {
    await navigator.share({ files: toFiles(prepared), title: prepared[0].name });
  } catch (err) {
    if (err && err.name !== 'AbortError') toast('Teilen nicht möglich – bitte „Laden“ verwenden', 3500);
  }
});

// AR Quick Look (iPhone): Modell als USDZ direkt im Raum ansehen
const arLink = document.createElement('a');
arLink.rel = 'ar';
arLink.appendChild(document.createElement('img'));
if (arLink.relList && arLink.relList.supports && arLink.relList.supports('ar')) {
  $('#btn-ar').hidden = false;
}
$('#btn-ar').addEventListener('click', async () => {
  closeSheets();
  showLoading('AR wird vorbereitet…');
  try {
    const [{ blob }] = await exportAs('usdz');
    if (arLink.href) URL.revokeObjectURL(arLink.href);
    arLink.href = URL.createObjectURL(blob);
    arLink.click();
  } catch (err) {
    toast(`AR nicht möglich: ${err.message || err}`, 4000);
  } finally {
    hideLoading();
  }
});

// ---------------------------------------------------------------------------
// Panels (Bottom Sheets) – per Tippen, Wischen nach unten oder Hintergrund schließen
// ---------------------------------------------------------------------------
const scrim = $('#scrim');
let openSheetEl = null;

function openSheet(id) {
  if (openSheetEl && openSheetEl.id === id) { closeSheets(); return; }
  closeSheets(false);
  openSheetEl = document.getElementById(id);
  openSheetEl.hidden = false;
  scrim.hidden = false;
  $$('.tool[data-panel]').forEach((t) => t.setAttribute('aria-expanded', String(t.dataset.panel === id)));
  if (id === 'panel-models') {
    renderSavedList();
    requestAnimationFrame(() => setTimeout(renderThumbnails, 30));
  }
  if (id === 'panel-view') updateStats();
  if (id === 'panel-anim') { renderAnimPanel(); ensureAnalysis(); }
}
function closeSheets() {
  $$('.sheet').forEach((s) => { s.hidden = true; });
  scrim.hidden = true;
  openSheetEl = null;
  $$('.tool[data-panel]').forEach((t) => t.setAttribute('aria-expanded', 'false'));
}
$$('.tool[data-panel]').forEach((t) => {
  t.setAttribute('aria-expanded', 'false');
  t.addEventListener('click', () => openSheet(t.dataset.panel));
});
$$('.sheet .close').forEach((b) => b.addEventListener('click', closeSheets));
scrim.addEventListener('click', closeSheets);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSheets(); hideHelp(); } });

// Wischen nach unten auf dem Panel-Kopf schließt das Panel
$$('.sheet').forEach((sheet) => {
  let y0 = null;
  const head = [sheet.querySelector('.grabber'), sheet.querySelector('.sheet-head')];
  head.forEach((h) => {
    h.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; }, { passive: true });
    h.addEventListener('touchmove', (e) => {
      if (y0 == null) return;
      const dy = e.touches[0].clientY - y0;
      if (dy > 0) sheet.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    h.addEventListener('touchend', (e) => {
      if (y0 == null) return;
      const dy = e.changedTouches[0].clientY - y0;
      sheet.style.transform = '';
      y0 = null;
      if (dy > 70) closeSheets();
    });
  });
});

// ---------------------------------------------------------------------------
// Ansicht-Optionen
// ---------------------------------------------------------------------------
function bindToggle(id, key, apply) {
  const el = document.getElementById(id);
  el.checked = !!prefs[key];
  el.addEventListener('change', () => { prefs[key] = el.checked; savePrefs(); apply(); });
}
function bindRadio(id, key, apply) {
  const group = document.getElementById(id);
  const btns = Array.from(group.querySelectorAll('[role="radio"]'));
  const sync = () => btns.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === prefs[key])));
  btns.forEach((b) => b.addEventListener('click', () => { prefs[key] = b.dataset.value; savePrefs(); sync(); apply(); }));
  sync();
}

const applyAutoRotate = () => { controls.autoRotate = prefs.autoRotate; requestRender(); };
const applyShadow = () => { ground.visible = prefs.shadow; sun.castShadow = prefs.shadow; requestRender(); };
const applyGrid = () => { grid.visible = prefs.grid; requestRender(); };
const applyBg = () => {
  viewportEl.classList.toggle('bg-studio', prefs.bg === 'studio');
  viewportEl.classList.toggle('bg-light', prefs.bg === 'light');
  ground.material.opacity = prefs.bg === 'light' ? 0.18 : 0.28;
  const theme = { dark: '#0b0d12', studio: '#23262e', light: '#d9dce3' }[prefs.bg] || '#0b0d12';
  document.querySelector('meta[name="theme-color"]').setAttribute('content', theme);
  requestRender();
};

bindToggle('opt-autorotate', 'autoRotate', applyAutoRotate);
bindToggle('opt-wireframe', 'wireframe', applyWireframe);
bindToggle('opt-shadow', 'shadow', applyShadow);
bindToggle('opt-grid', 'grid', applyGrid);
bindRadio('opt-bg', 'bg', applyBg);
bindRadio('opt-color', 'color', applyColor);
bindRadio('opt-quality', 'quality', () => { autoPixelRatio = DPR; resize(); updateStats(); });
applyAutoRotate(); applyShadow(); applyGrid(); applyBg();

$('#btn-reset').addEventListener('click', resetView);

// ---------------------------------------------------------------------------
// Hilfe, Hinweise, Laden
// ---------------------------------------------------------------------------
function showHelp() {
  $('#install-hint').hidden = !(isIOS && !isStandalone);
  $('#help').hidden = false;
}
function hideHelp() {
  $('#help').hidden = true;
  if (!prefs.helpSeen) { prefs.helpSeen = true; savePrefs(); }
}
$('#btn-help').addEventListener('click', showHelp);
$('#help-close').addEventListener('click', hideHelp);
$('#help').addEventListener('click', (e) => { if (e.target.id === 'help') hideHelp(); });

let toastTimer;
function toast(msg, ms = 2500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  t.onclick = null;
  return t;
}
function showLoading(text) { $('#loading-text').textContent = text; $('#loading').hidden = false; }
function hideLoading() { $('#loading').hidden = true; }

// ---------------------------------------------------------------------------
// Offline-Fähigkeit (Service Worker) & Updates
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw && nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            const t = toast('Neue Version verfügbar – hier tippen zum Aktualisieren', 10000);
            t.onclick = () => location.reload();
          }
        });
      });
    } catch (err) { console.warn('Service Worker:', err); }
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
renderBuiltinList();
renderSavedList();

const params = new URLSearchParams(location.search);
const src = params.get('src') || params.get('model');
loadBuiltin(params.get('demo') || 'spider');
if (src) openUrl(src);
if (!prefs.helpSeen) showHelp();

// Für automatisierte Tests
window.__studio = { renderer, scene, camera, controls, get model() { return currentModel; }, exportAs, loadBuiltin, openFiles, anim, ensureAnalysis, playAnimation };
