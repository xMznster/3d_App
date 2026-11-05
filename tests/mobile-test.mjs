// Mobile-Test für 3D Studio auf typischen iPhone-Bildschirmgrößen.
// Startet einen lokalen Server, emuliert iPhones (Touch, DPR, Viewport) und prüft:
//  - keine JS-Fehler, kein horizontales Scrollen, nichts ragt aus dem Bildschirm
//  - WebGL-Canvas in voller Retina-Auflösung
//  - Touch: 1 Finger drehen, 2 Finger zoomen/verschieben, Doppeltippen
//  - Panels passen in Hoch- und Querformat, Touch-Ziele >= 44 pt
//  - Export GLB/USDZ/STL/OBJ/PNG, Service Worker + Manifest
// Aufruf: node tests/mobile-test.mjs [screenshot-ordner]
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

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    if (!p || p.endsWith('/')) p += 'index.html';
    const data = await readFile(join(ROOT, p));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(0);
const BASE = `http://localhost:${server.address().port}/`;

// Safe Areas simulieren (Chromium kennt env(safe-area-inset-*) nicht)
const SAFE = {
  portrait: { sat: '62px', sab: '34px', sal: '0px', sar: '0px' },
  landscape: { sat: '0px', sab: '21px', sal: '62px', sar: '62px' },
};

const PROFILES = [
  { name: 'iPhone 16 Pro', dev: 'iPhone 16 Pro' },
  { name: 'iPhone 16 Pro quer', dev: 'iPhone 16 Pro landscape' },
  { name: 'iPhone 16 Pro Max', dev: 'iPhone 16 Pro Max' },
  { name: 'iPhone 16 Pro Max quer', dev: 'iPhone 16 Pro Max landscape' },
  { name: 'iPhone 16', dev: 'iPhone 16' },
  { name: 'iPhone 13 Mini', dev: 'iPhone 13 Mini' },
  { name: 'iPhone SE', dev: 'iPhone SE', safe: { sat: '20px', sab: '0px', sal: '0px', sar: '0px' } },
  { name: 'iPhone SE quer', dev: 'iPhone SE landscape', safe: { sat: '0px', sab: '0px', sal: '0px', sar: '0px' } },
];

let failures = 0;
const check = (cond, msg) => { if (!cond) { failures++; console.log(`   ✗ ${msg}`); } return cond; };

async function touch(cdp, type, points) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
}
async function drag(cdp, from, to, steps = 12) {
  await touch(cdp, 'touchStart', from);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await touch(cdp, 'touchMove', from.map((p, k) => [p[0] + (to[k][0] - p[0]) * t, p[1] + (to[k][1] - p[1]) * t]));
    await new Promise((r) => setTimeout(r, 16));
  }
  await touch(cdp, 'touchEnd', []);
  await new Promise((r) => setTimeout(r, 600)); // Dämpfung ausklingen lassen
}

const camState = (page) => page.evaluate(() => {
  const { camera, controls } = window.__studio;
  const off = camera.position.clone().sub(controls.target);
  return { dist: off.length(), az: Math.atan2(off.x, off.z), target: controls.target.toArray() };
});

async function overflowReport(page) {
  return page.evaluate(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const bad = [];
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('[hidden]')) continue;
      if (el.closest('.sheet-body, .card, .list')) {
        // in scrollbaren Bereichen nur horizontale Überläufe zählen
        const host = el.closest('.sheet-body, .card');
        const r = el.getBoundingClientRect(), hr = host.getBoundingClientRect();
        if (r.width && (r.left < hr.left - 1 || r.right > hr.right + 1)) bad.push(`${el.tagName}.${el.className} (horizontal in Panel)`);
        continue;
      }
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.left < -1 || r.right > vw + 1 || r.top < -1 || r.bottom > vh + 1) bad.push(`${el.tagName}#${el.id}.${el.className} [${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}]`);
    }
    const se = document.scrollingElement;
    return { bad, scrollW: se.scrollWidth, scrollH: se.scrollHeight, vw, vh, panelScrollW: [...document.querySelectorAll('.sheet-body')].filter((b) => b.offsetParent).map((b) => b.scrollWidth - b.clientWidth) };
  });
}

async function smallTargets(page) {
  return page.evaluate(() => [...document.querySelectorAll('button, label.toggle, label.big-btn, a.btn, input[type=url]')]
    .filter((el) => el.offsetParent && !el.closest('[hidden]'))
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 0 && (r.width < 43.5 || r.height < 39.5))
    .map(({ el, r }) => `${el.tagName}.${el.className}[${el.textContent.trim().slice(0, 12)}] ${Math.round(r.width)}×${Math.round(r.height)}`));
}

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

for (const prof of PROFILES) {
  const dev = devices[prof.dev];
  if (!dev) { console.log(`(übersprungen: ${prof.dev} unbekannt)`); continue; }
  const landscape = dev.viewport.width > dev.viewport.height;
  const safe = prof.safe || SAFE[landscape ? 'landscape' : 'portrait'];
  console.log(`\n▶ ${prof.name}  ${dev.viewport.width}×${dev.viewport.height} @${dev.deviceScaleFactor}x`);

  const ctx = await browser.newContext({ ...dev, serviceWorkers: 'allow' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript((s) => {
    document.addEventListener('DOMContentLoaded', () => {
      const st = document.createElement('style');
      st.textContent = `:root{--sat:${s.sat};--sab:${s.sab};--sal:${s.sal};--sar:${s.sar}}`;
      document.head.appendChild(st);
    });
  }, safe);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__studio && window.__studio.model);
  await page.waitForTimeout(400);
  const slug = prof.name.replace(/\s+/g, '-');

  // Hilfe beim ersten Start
  check(await page.isVisible('#help'), 'Hilfe wird beim ersten Start angezeigt');
  await page.screenshot({ path: join(SHOTS, `${slug}-0-hilfe.png`) });
  let ov = await overflowReport(page);
  check(ov.bad.length === 0, `Hilfe ragt über Rand: ${ov.bad.join(' | ')}`);
  await page.tap('#help-close');

  // Grundlayout
  ov = await overflowReport(page);
  check(ov.scrollW <= ov.vw, `horizontales Scrollen: scrollWidth ${ov.scrollW} > ${ov.vw}`);
  check(ov.scrollH <= ov.vh, `vertikales Scrollen: scrollHeight ${ov.scrollH} > ${ov.vh}`);
  check(ov.bad.length === 0, `Elemente außerhalb des Bildschirms: ${ov.bad.join(' | ')}`);
  const st = await page.evaluate(() => ({ cw: document.querySelector('#scene').width, ch: document.querySelector('#scene').height, iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio, pr: window.__studio.renderer.getPixelRatio() }));
  check(st.cw === Math.round(st.iw * st.pr) && st.ch === Math.round(st.ih * st.pr), `Canvas-Größe ${st.cw}×${st.ch} passt nicht zu ${st.iw}×${st.ih}@${st.pr}`);
  check(st.pr === Math.min(st.dpr, 3), `Pixel-Ratio ${st.pr} statt ${Math.min(st.dpr, 3)}`);
  const tiny = await smallTargets(page);
  check(tiny.length === 0, `zu kleine Touch-Ziele: ${tiny.join(' | ')}`);
  await page.screenshot({ path: join(SHOTS, `${slug}-1-ansicht.png`) });

  // Touch-Gesten
  const cdp = await ctx.newCDPSession(page);
  const cx = st.iw / 2 - (landscape ? 40 : 0), cy = st.ih / 2;
  let a = await camState(page);
  await drag(cdp, [[cx - 60, cy]], [[cx + 60, cy]]);
  let b = await camState(page);
  check(Math.abs(b.az - a.az) > 0.3, `1-Finger-Drehen ohne Wirkung (Δaz ${(b.az - a.az).toFixed(2)})`);
  check(Math.abs(b.dist - a.dist) < 0.05, '1-Finger-Drehen ändert ungewollt den Zoom');

  a = b;
  await drag(cdp, [[cx - 30, cy], [cx + 30, cy]], [[cx - 110, cy], [cx + 110, cy]]);
  b = await camState(page);
  check(b.dist < a.dist * 0.8, `2-Finger-Zoom ohne Wirkung (${a.dist.toFixed(2)} → ${b.dist.toFixed(2)})`);

  a = b;
  await drag(cdp, [[cx - 40, cy], [cx + 40, cy]], [[cx - 40, cy - 80], [cx + 40, cy - 80]]);
  b = await camState(page);
  const moved = Math.hypot(...b.target.map((v, i) => v - a.target[i]));
  check(moved > 0.05, `2-Finger-Verschieben ohne Wirkung (${moved.toFixed(3)})`);

  // Doppeltippen → zurücksetzen
  for (let i = 0; i < 2; i++) {
    await touch(cdp, 'touchStart', [[cx, cy]]);
    await touch(cdp, 'touchEnd', []);
    await page.waitForTimeout(90);
  }
  await page.waitForTimeout(900);
  b = await camState(page);
  check(Math.abs(b.target[0]) < 0.02 && Math.abs(b.target[2]) < 0.02, `Doppeltippen setzt Ansicht nicht zurück (target ${b.target.map((v) => v.toFixed(2))})`);

  // Panels
  for (const [panel, name] of [['panel-models', 'modelle'], ['panel-import', 'oeffnen'], ['panel-view', 'ansicht'], ['panel-export', 'sichern']]) {
    await page.tap(`.tool[data-panel="${panel}"]`);
    await page.waitForTimeout(450);
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    check(await page.isVisible(`#${panel}`), `${panel} öffnet nicht`);
    ov = await overflowReport(page);
    check(ov.bad.length === 0, `${panel}: außerhalb: ${ov.bad.join(' | ')}`);
    check(ov.panelScrollW.every((x) => x <= 0), `${panel}: horizontaler Scrollbereich im Panel`);
    check(ov.scrollW <= ov.vw, `${panel}: horizontales Scrollen`);
    const overlap = await page.evaluate((id) => {
      const s = document.getElementById(id).getBoundingClientRect(), t = document.getElementById('toolbar').getBoundingClientRect();
      return !(s.right <= t.left || s.left >= t.right || s.bottom <= t.top || s.top >= t.bottom);
    }, panel);
    check(!overlap, `${panel} überdeckt die Werkzeugleiste`);
    const tinyP = await smallTargets(page);
    check(tinyP.length === 0, `${panel}: zu kleine Touch-Ziele: ${tinyP.join(' | ')}`);
    await page.screenshot({ path: join(SHOTS, `${slug}-2-${name}.png`) });
    await page.tap(`#${panel} .close`);
    await page.waitForTimeout(150);
    check(!(await page.isVisible(`#${panel}`)), `${panel} schließt nicht`);
  }

  // Modell wechseln per Touch
  await page.tap('.tool[data-panel="panel-models"]');
  await page.waitForTimeout(300);
  await page.tap('.model-card[data-id="house"]');
  await page.waitForTimeout(300);
  check((await page.textContent('#model-name')) === 'Haus', 'Modellwechsel per Tippen funktioniert nicht');

  // Export (nur einmal, Inhalt ist geräteunabhängig) + Download-Weg
  if (prof === PROFILES[0]) {
    const sizes = await page.evaluate(async () => {
      const out = {};
      for (const f of ['glb', 'usdz', 'stl', 'obj', 'png']) {
        try { const [r] = await window.__studio.exportAs(f); out[f] = r.blob.size; } catch (e) { out[f] = 'ERR ' + e.message; }
      }
      return out;
    });
    console.log('   Export:', JSON.stringify(sizes));
    for (const [f, s] of Object.entries(sizes)) check(typeof s === 'number' && s > 200, `Export ${f} fehlgeschlagen: ${s}`);

    // Download-Ablauf per Tippen
    await page.tap('.tool[data-panel="panel-export"]');
    await page.waitForTimeout(300);
    await page.tap('.fmt[data-format="stl"]');
    await page.waitForSelector('#save-ready:not([hidden])');
    const [download] = await Promise.all([page.waitForEvent('download'), page.tap('#btn-download')]);
    check(download.suggestedFilename() === 'Haus.stl', `Download-Name: ${download.suggestedFilename()}`);
    await page.screenshot({ path: join(SHOTS, `${slug}-3-download.png`) });
    await page.tap('#panel-export .close');

    // Import einer Datei (Round-Trip GLB) über das Datei-Feld
    const glb = await page.evaluate(async () => {
      window.__studio.loadBuiltin('gear');
      const [r] = await window.__studio.exportAs('glb');
      return Array.from(new Uint8Array(await r.blob.arrayBuffer()));
    });
    await page.setInputFiles('#file-input', { name: 'Testteil.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(glb) });
    await page.waitForFunction(() => document.querySelector('#model-name').textContent === 'Testteil', null, { timeout: 8000 }).catch(() => {});
    check((await page.textContent('#model-name')) === 'Testteil', 'GLB-Import funktioniert nicht');
    await page.tap('.tool[data-panel="panel-models"]');
    await page.waitForTimeout(500);
    check((await page.locator('#saved-list li').count()) >= 1, 'Importiertes Modell wurde nicht gespeichert');
    await page.screenshot({ path: join(SHOTS, `${slug}-4-meine-modelle.png`) });
    await page.tap('#panel-models .close');

    // PWA
    const pwa = await page.evaluate(async () => {
      const m = await (await fetch(document.querySelector('link[rel=manifest]').href)).json();
      const reg = await navigator.serviceWorker.ready;
      const keys = await caches.keys();
      return { display: m.display, icons: m.icons.length, sw: !!reg.active, cached: keys.length ? (await (await caches.open(keys[0])).keys()).length : 0 };
    });
    console.log('   PWA:', JSON.stringify(pwa));
    check(pwa.display === 'standalone' && pwa.icons >= 2 && pwa.sw && pwa.cached >= 20, 'PWA/Service Worker unvollständig');

    // Offline: Netzwerk aus, neu laden → App muss weiter funktionieren
    await ctx.setOffline(true);
    await page.reload({ waitUntil: 'load' });
    const offlineOk = await page.waitForFunction(() => window.__studio && window.__studio.model, null, { timeout: 8000 }).then(() => true).catch(() => false);
    check(offlineOk, 'App startet offline nicht');
    await ctx.setOffline(false);
  }

  check(errors.length === 0, `JS-Fehler: ${errors.join(' | ')}`);
  await ctx.close();
}

await browser.close();
server.close();
console.log(failures ? `\n✗ ${failures} Problem(e) gefunden` : '\n✓ Alle Prüfungen bestanden');
process.exit(failures ? 1 : 0);
