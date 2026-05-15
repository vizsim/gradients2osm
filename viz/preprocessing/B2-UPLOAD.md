# B2-Upload der PMTiles

`viz/preprocessing/upload_pmtiles.sh` schickt die fertigen
`*.mlt.pmtiles` aus `viz/data/` in den Backblaze-B2-Bucket, aus dem der
produktive Viewer (`viz/js/map/initMap.js`) sie via Fallback streamt.

## Einmaliges Setup

1. **B2 CLI installieren** (passend zum uv-Setup des Projekts):

   ```bash
   uv tool install b2
   # alternativ:
   #   pipx install b2
   #   pip install --user 'b2[full]'
   ```

   Stellt drei Executables bereit: `b2`, `b2v3`, `b2v4`. Wir nutzen
   `b2` (zeigt aktuell auf v4).

2. **Application Key in B2 anlegen** unter
   <https://secure.backblaze.com/app_keys.htm>:
   - „Add a New Application Key"
   - **auf den Ziel-Bucket beschränken** (Read + Write), **nicht** den
     Master-Key benutzen
   - `applicationKey` wird **nur einmal** angezeigt — direkt in `.env`
     übernehmen, sonst Key neu anlegen

3. **`.env` im Repo-Root anlegen** (ist via `.gitignore` ausgeschlossen):

   ```bash
   cp .env.example .env
   # dann die drei Werte eintragen:
   #   B2_APPLICATION_KEY_ID   <- keyID aus dem B2-UI
   #   B2_APPLICATION_KEY      <- applicationKey aus dem B2-UI
   #   B2_BUCKET_NAME          <- Bucket-Name
   ```

## Upload

```bash
# Vorab anschauen, was hochginge (kein Upload):
./viz/preprocessing/upload_pmtiles.sh --dry-run

# Echter Upload:
./viz/preprocessing/upload_pmtiles.sh
```

Der Output zeigt pro Datei `upload` (wird hochgeladen) oder
nichts/`skip` (wird übersprungen, weil schon mit gleichem Stand im
Bucket).

## Was das Skript intern macht

1. Lädt `.env` aus dem Repo-Root, prüft Variablen + b2-Verfügbarkeit.
2. `b2 account authorize "$B2_APPLICATION_KEY_ID" "$B2_APPLICATION_KEY"`
   einmal — Credentials werden danach unter `~/.config/b2/` gecached,
   sodass spätere Calls ohne erneutes Auth funktionieren.
3. `b2 sync` mit `--exclude-regex '.*' --include-regex
   '.*\.mlt\.pmtiles$'`:
   - schließt alles aus
   - lässt nur `*.mlt.pmtiles` durch (die `*.pmtiles` MVT-Baseline
     bleibt lokal)
   - überspringt Dateien, deren Name + mtime zwischen lokal und
     Bucket identisch sind → Re-Runs sind günstig

## Public-Hosting (für `pmtiles://`-Streaming)

Der Viewer nutzt das pmtiles.js-Protocol mit Range-Requests gegen

```
https://f003.backblazeb2.com/file/<bucket>/<file>.mlt.pmtiles
```

Damit das aus dem Browser ohne Auth funktioniert, muss der **Bucket auf
„Public" stehen** (im B2-Web-UI bei Bucket Settings → „Files in Bucket
are: Public"). Allowed Origins / CORS muss zusätzlich gesetzt sein,
falls das Hosting des Viewers auf einer anderen Domain läuft:

- Bucket Settings → CORS Rules → Custom CORS rules:
  Operations: alle Read-Ops, Allowed Origins: `*` (oder deine Domain),
  Headers: `range,content-type`

## Zusammenspiel mit dem Viewer

`viz/js/map/initMap.js` macht beim Start einen HEAD-Probe auf
`./data/<file>` und fällt nur dann auf B2 zurück, wenn der lokale
Probe 404 / Fehler liefert. D.h.:

- **Lokaler Dev-Server mit `viz/data/<file>` vorhanden** → kein
  B2-Traffic, alles via `pmtiles://` aus dem lokalen Ordner.
- **Deploy ohne große `.pmtiles`** (z.B. GitHub Pages, wo wir die Files
  nicht ins Repo committen) → 404 lokal, dann Range-Requests gegen
  B2 als Fallback.

Konsequenz: nach jedem `build_pmtiles_mlt.sh` einfach
`./viz/preprocessing/upload_pmtiles.sh` hinterherwerfen — der lokale
Dev läuft sofort weiter, und der Deploy zieht sich beim nächsten
Page-Load die neuen Bytes via B2.

## Häufige Stolpersteine

- **`b2: command not found`** nach `uv tool install b2` → `~/.local/bin`
  ist nicht im PATH. Einmaliges `uv tool update-shell` (oder die
  Zeile in `.bashrc` händisch ergänzen).
- **`unauthorized` bei `b2 account authorize`** → Key abgelaufen oder
  versehentlich auf den falschen Bucket beschränkt. Im B2-UI prüfen,
  neu erstellen, Werte in `.env` aktualisieren.
- **Re-Upload obwohl Datei unverändert** → `b2 sync` vergleicht
  über mtime. Wenn du `touch` auf die Datei machst oder ein Rebuild
  sie neu schreibt, wird sie hochgeladen, auch wenn der Inhalt
  identisch ist. (Spielt für uns keine Rolle: B2 dedupliziert
  serverseitig nach SHA1.)
