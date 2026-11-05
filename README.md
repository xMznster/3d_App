# 3D Studio – 3D-Modelle auf dem iPhone 16 Pro

Mobile-First-Web-App (PWA), mit der du 3D-Modelle **ausschließlich auf dem iPhone** ansehen,
drehen, zoomen und herunterladen kannst – ohne PC, ohne App Store, auch offline.

## Funktionen

| | |
|---|---|
| **Touch-Steuerung** | 1 Finger: drehen · 2 Finger spreizen: zoomen · 2 Finger ziehen: verschieben · Doppeltippen: Ansicht zurücksetzen |
| **WebGL-Darstellung** | Three.js, physikalisch basiertes Licht, Bodenschatten, volle 3×-Retina-Auflösung (1206 × 2622 px auf dem 16 Pro) |
| **Performance (A18 Pro)** | Rendern nur bei Bewegung (spart Akku), automatische Qualitätsanpassung, Modus „Max (3×)“ und „Akku“ |
| **Hoch- & Querformat** | Werkzeugleiste unten (Hochformat) bzw. rechts (Querformat), Safe Areas für Dynamic Island & Home-Indikator |
| **Modelle öffnen** | GLB, GLTF (inkl. .bin/Texturen), OBJ, STL aus der „Dateien“-App / iCloud oder per Web-Adresse |
| **Meine Modelle** | Geöffnete Dateien werden auf dem iPhone gespeichert (offline verfügbar) |
| **Sichern / Herunterladen** | GLB, USDZ, STL (3D-Druck), OBJ, PNG-Bild, Originaldatei – über „In Dateien sichern“/Teilen oder direkten Download |
| **Animation** | Automatische Bein-Erkennung direkt auf dem iPhone, danach „Idle“ und „Laufen“ mit Tempo-Regler – auch für eigene Modelle |
| **AR** | USDZ-Export direkt in AR Quick Look – Modell im eigenen Raum ansehen |
| **Home-Bildschirm** | Installierbar als App (Vollbild, eigenes Icon, Offline-Modus per Service Worker) |

Beispielmodelle (Rakete, Haus, Planet, Zahnrad, …) werden direkt im Browser erzeugt und funktionieren sofort.

## Nur mit dem iPhone einrichten (kein PC nötig)

Die App braucht eine HTTPS-Adresse. Das erledigt GitHub Pages automatisch:

1. Auf dem iPhone in Safari **github.com/xMznster/3d_App** öffnen (oder die GitHub-App nutzen).
2. Den Pull Request mit diesem Branch nach `main` mergen.
3. **Settings → Pages → Build and deployment → Source: „GitHub Actions“** wählen
   (in Safari ggf. über „aA“ → „Desktop-Website anfordern“).
4. Unter **Actions** läuft „Deploy to GitHub Pages“ (1–2 Minuten). Danach ist die App erreichbar unter
   **https://xmznster.github.io/3d_App/**
5. Seite in Safari öffnen → **Teilen-Symbol** → **„Zum Home-Bildschirm“**.
   3D Studio startet nun wie eine normale App im Vollbild und funktioniert auch offline.

## Animation (automatische Bein-Erkennung)

Im Bereich **Animation** analysiert 3D Studio das aktuelle Modell und erzeugt eine Lauf- und eine Idle-Animation.
Alles läuft auf dem Gerät, ohne Internet:

| Modelltyp | Vorgehen |
|---|---|
| Wolfsspinne | eigenes Skelett, artgerechter Wechselgang (L1-R2-L3-R4 / R1-L2-R3-L4), Atmen, tastende Vorderbeine |
| Die Bleiche (Geisterfrau) | humanoides Skelett mit Kiefer-, Finger-, Haar- und Kleidknochen (95 Knochen): Idle, schleppendes Laufen, **Angriff** (Ausholen + Krallen-Doppelhieb), Schrei, Kopf verdrehen |
| GLB/GLTF mit Skelett (z. B. Mixamo, Blender) | Beinketten werden am Knochenbaum erkannt, Arme schwingen mit |
| Modell aus Einzelteilen | beinartige Teile (lang, rundlich, berühren den Boden) bekommen ein Hüftgelenk |
| Einteiliges Mesh (STL/OBJ) | Füße, Hüfthöhe und Beine werden per Voxel-Analyse bestimmt, ein Skelett mit Hüfte und Knie wird eingebaut |

Zwei-, Vier-, Sechs- und Achtbeiner bekommen jeweils eine passende Gangart. Abgespreizte (spinnenartige) Beine
schwingen um die Hochachse, aufrechte Beine vor und zurück. Beim Sichern als **GLB** werden Skelett und Animationen
mitgespeichert, z. B. für Blender oder Game-Engines. Animationen, die schon in einer GLB-Datei stecken, lassen sich
ebenfalls abspielen.

Grenzen: Die Laufrichtung wird als +Z angenommen (glTF-Standard), Beine müssen den Boden berühren, und bei
einteiligen Modellen werden nur Hüfte und Knie bewegt.

## Modelle herunterladen

**Sichern** → Format wählen → **„In Dateien sichern / Teilen“** (Speichern in iCloud Drive / Auf meinem iPhone,
AirDrop, Nachrichten …) oder **„Laden“** (landet im Ordner „Downloads“ der Dateien-App).

## Technik

- Reines HTML/CSS/JavaScript (ES-Module), kein Build-Schritt
- Three.js r180 lokal unter `vendor/` (MIT-Lizenz) → kein CDN, voll offline-fähig
- `index.html` · `css/app.css` · `js/app.js` (Viewer, Touch, Export) · `js/models.js` (Beispielmodelle) · `js/spider.js` (Wolfsspinne) · `js/animator.js` (Bein-Erkennung & Animation) · `js/storage.js` (IndexedDB)
- `sw.js` Service Worker, `manifest.webmanifest` PWA-Manifest, `icons/` App-Icons
- Nach Änderungen an App-Dateien `VERSION` in `sw.js` erhöhen, damit installierte Apps das Update erhalten.

## Tests

`npm test` emuliert iPhone 16 Pro / Pro Max / 16 / 13 mini / SE in Hoch- und Querformat (Playwright) und prüft
u. a. horizontales Scrollen, Elemente außerhalb des Bildschirms, Touch-Zielgrößen, 1- und 2-Finger-Gesten,
Doppeltippen, alle Panels, Export, Download, Import, Service Worker und Offline-Start.

`node tests/animation-test.mjs` prüft die Bein-Erkennung (Spinne, Vierbeiner aus Teilen, einteiliger STL-Vierbeiner,
Zweibeiner mit Skelett, Modelle ohne Beine) und den GLB-Export mit Animationen.
