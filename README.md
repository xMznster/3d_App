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

## Modelle herunterladen

**Sichern** → Format wählen → **„In Dateien sichern / Teilen“** (Speichern in iCloud Drive / Auf meinem iPhone,
AirDrop, Nachrichten …) oder **„Laden“** (landet im Ordner „Downloads“ der Dateien-App).

## Technik

- Reines HTML/CSS/JavaScript (ES-Module), kein Build-Schritt
- Three.js r180 lokal unter `vendor/` (MIT-Lizenz) → kein CDN, voll offline-fähig
- `index.html` · `css/app.css` · `js/app.js` (Viewer, Touch, Export) · `js/models.js` (Beispielmodelle) · `js/storage.js` (IndexedDB)
- `sw.js` Service Worker, `manifest.webmanifest` PWA-Manifest, `icons/` App-Icons
- Nach Änderungen an App-Dateien `VERSION` in `sw.js` erhöhen, damit installierte Apps das Update erhalten.

## Tests

`npm test` emuliert iPhone 16 Pro / Pro Max / 16 / 13 mini / SE in Hoch- und Querformat (Playwright) und prüft
u. a. horizontales Scrollen, Elemente außerhalb des Bildschirms, Touch-Zielgrößen, 1- und 2-Finger-Gesten,
Doppeltippen, alle Panels, Export, Download, Import, Service Worker und Offline-Start.
