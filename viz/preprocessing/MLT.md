# MVT → MLT: Konvertierung & Vergleich

Notizen aus dem Test: tippecanoe-PMTiles (MVT) → MapLibre Tiles (MLT) via
[`maplibre-tile-spec/mlt-encode.jar`](https://github.com/maplibre/maplibre-tile-spec)
(Release `java-v0.0.10`, März 2026).

Geprüft auf `output/saarland_v02.fgb` (~80k Highway-Features, 35 MB FGB).

## Pipeline

```
output/<region>.fgb
  └─► build_pmtiles.sh      (tippecanoe)    ─► viz/data/<region>.pmtiles      (MVT)
        └─► build_pmtiles_mlt.sh             ─► viz/data/<region>.mlt.pmtiles  (MLT)
```

`build_pmtiles_mlt.sh` macht:

1. Holt `mlt-encode.jar` beim ersten Lauf nach `vendor/` (164 MB).
2. Kopiert das MVT-PMTiles in tmp und säubert die JSON-Metadaten
   (siehe Quirks 1 + 2 unten) via `pmtiles edit --metadata`.
3. Ruft `java -jar mlt-encode.jar --pmtiles … --mlt … --parallel` auf.
4. Vergleicht Tile-Anzahl von Input vs Output und warnt, falls Tiles
   verloren gegangen sind.

## Interop-Stolpersteine zwischen tippecanoe und java-v0.0.10

### Quirk 1 — JSON-Metadaten mit Object-Werten

tippecanoe schreibt in die PMTiles-Metadaten u.a.:

```json
"tippecanoe_decisions": {"basezoom":12,"droprate":2.5,…},
"tilestats":           {"layerCount":1, …}
```

Die planetiler-PMTiles-Library (in mlt-encode) deserialisiert unbekannte
Felder als `Map<String, String>` → Jackson kippt bei Objekten mit
`MismatchedInputException`.

**Fix:** vor dem Encode aus den Metadaten alles entfernen, das weder
ein bekanntes typisiertes Feld (`name`, `description`, `attribution`,
`version`, `type`, `format`, `vector_layers`) noch ein einfacher String
ist. → erledigt in [`build_pmtiles_mlt.sh`](build_pmtiles_mlt.sh).

### Quirk 2 — Field-Type `"Mixed"`

tippecanoe schreibt in `vector_layers[].fields` für Spalten mit
uneindeutigem Inhalt den Wert `"Mixed"` (bei uns `osm_id`, `n_samples`,
`is_implausible_grad`). planetilers `VectorLayer.FieldType`-Enum kennt
nur `Number | String | Boolean` → `EnumDeserializer` wirft.

**Fix Variante A (im Encoder-Skript):** In den Metadaten alle Feldwerte
außer `{Number, String, Boolean}` auf `"String"` umbiegen — ist als
Backup im Skript drin.

**Fix Variante B (sauberer, an der Quelle):** in `build_pmtiles.sh`
für die betroffenen Spalten tippecanoes `-T <attr>:<type>` setzen,
damit gar kein Mixed mehr entsteht. So aktuell gemacht:

```bash
-T osm_id:string
-T n_samples:int
-T is_implausible_grad:bool
```

### Quirk 3 — Pro-Wert Int/Float-Mismatch (der eigentliche Showstopper)

Innerhalb **eines** Tiles schreibt tippecanoe die selbe numerische
Spalte teils als `int_value` (z.B. `length_m=42`), teils als
`float_value` (`length_m=42.5`), teils als `double_value`. MLT verlangt
aber homogene Spaltentypen pro Tile → Encoder wirft:

```
Layer 'ways' Feature index 1 Property 'length_m' has different type: FLOAT / INT_32
```

Ohne Workaround verloren bei Saarland **41 von 478 Tiles** (~9 %), die
restlichen wurden mit Property-Lücken encoded.

**Fix:** im `build_pmtiles.sh` zwei Dinge ergänzen:

1. `--single-precision` — sorgt für einheitliche Float-Repräsentation
   bei Geometrien und Attributen.
2. `-T <numeric-col>:float` für jede numerische Spalte, die wir behalten
   (length_m, elevation_*_m, gradient_*_pct, slope_*_*_pct).

Damit: **478 → 478 Tiles, kein Daten-Drop.**

> ⚠️ Der Encoder wirft trotzdem noch ~449 interne
> `ClassCastException Float → Double` während des Schreibens
> (`PropertyEncoder.getDoublePropertyValue` macht `(Double) value`
> statt `((Number) value).doubleValue()`). Mit
> `--coerce-mismatch --elide-mismatch --continue` werden die abgefangen
> und die Tiles bekommen trotzdem die volle Anzahl Features.
> Konkret saubere Lösung: Encoder selbst bauen und den 1-Zeiler patchen
> — bis dahin ist die aktuelle Pipeline produktiv funktionsfähig.

## Vergleich MVT vs MLT

Drei Regionen, jeweils mit identischer tippecanoe-Konfiguration
(`--single-precision` + `-T :float`) und MLT-Encode mit `--compress gzip
--enable-fsst --parallel`.

### Dateigröße PMTiles

| Region                  | MVT      | MLT      | MLT/MVT  | Tiles MVT → MLT |
|-------------------------|---------:|---------:|---------:|----------------:|
| saarland_v02            |   9.9 MB |   6.6 MB | **0.69** |     478 → 478   |
| brandenburg_v02         |  47.4 MB |  31.9 MB | **0.67** |   5 231 → 5 231 |
| baden-württemberg_v02   | 119.2 MB |  80.5 MB | **0.68** |   5 036 → 5 036 |

Alle drei Regionen landen sehr konsistent bei einer **~32 % Reduktion**.
Kein Tile-Verlust (Anzahl identisch).

### Build-Zeiten (Brandenburg + Baden-Württemberg, WSL2 Linux)

| Region                  | tippecanoe (MVT) | mlt-encode | total |
|-------------------------|-----------------:|-----------:|------:|
| brandenburg_v02         |              31s |        41s |   72s |
| baden-württemberg_v02   |              60s |        52s |  112s |

MLT-Encoder ist nicht der Flaschenhals — bewegt sich auf Augenhöhe
mit tippecanoe oder leicht darunter.

### Stichprobe einzelner Tiles (Bytes)

Saarland (`saarland_v02`):

| z/x/y         |     MVT |     MLT | MLT/MVT |
|---------------|--------:|--------:|--------:|
| 11/1062/700   | 182 656 | 117 989 |    0.65 |
| 12/2126/1402  |  71 100 |  49 468 |    0.70 |
| 13/4253/2806  |   2 160 |   1 835 |    0.85 |

Brandenburg (`brandenburg_v02`):

| z/x/y         |     MVT |     MLT | MLT/MVT |
|---------------|--------:|--------:|--------:|
| 11/1101/672   | 242 123 | 145 589 |    0.60 |
| 12/2202/1344  | 109 385 |  67 908 |    0.62 |
| 13/4404/2688  |  26 327 |  17 012 |    0.65 |

Baden-Württemberg (`baden-wuerttemberg_v02`):

| z/x/y         |     MVT |     MLT | MLT/MVT |
|---------------|--------:|--------:|--------:|
| 11/1078/710   |  74 942 |  50 651 |    0.68 |
| 12/2156/1420  |  21 124 |  14 816 |    0.70 |
| 13/4312/2840  |   7 319 |   5 635 |    0.77 |

Tiles auf z6–z10 sind in unserer Pipeline leer/27 Byte, weil das
Zoom-Highway-Filter erst ab z11 dichte Geometrien zulässt.

**Beobachtungen:**

- Spürbare Einsparung auf den dichten Mid-Zoom-Tiles (z11/z12: −30…−40 %).
- Brandenburg komprimiert anteilig am besten (−35 % gesamt, einzelne
  Tiles bis −40 %) — vermutlich weil das dichte Land-Straßennetz viele
  Features mit sehr ähnlichen Attribut-Strings hat, was FSST und das
  columnar Integer-Packing maximal nutzen können.
- Auf sehr kleinen Tiles (z13 mit wenigen Features) flacht der Gewinn
  ab (−15…−25 %), weil der pro-Tile MLT-Header-Overhead anteilig wächst.
- Die in der Spec versprochenen „bis zu 6×" sieht man bei reinen
  Linien-Layern mit moderaten Attributen nicht — der MLT-Vorteil kommt
  vor allem aus FSST-String-Encoding und columnar Integer-Packing,
  was bei unseren OSM-Tags + numerischen Gradienten begrenzt greift.

## Browser-Support

- MapLibre GL JS: MLT-Support ist im Main gemerged (Tracking-Issue
  [#6258](https://github.com/maplibre/maplibre-gl-js/issues/6258),
  closed). Seit ~v5.x lädt MapLibre `mlt`-Tile-Typ direkt.
- pmtiles-Container mit `tile_type=mlt` wird von go-pmtiles korrekt
  ausgewiesen — `pmtiles show` zeigt `tile type: mlt`.

## Offene Punkte / nächste Schritte

- [ ] Encoder aus `maplibre-tile-spec/java` selbst bauen mit Patch
  in `PropertyEncoder.getDoublePropertyValue`, um die internen
  `ClassCastException Float → Double` loszuwerden. Dann kann
  `--continue` raus aus dem Skript.
- [ ] Cold-Start / Frame-Time im Viewer messen (MLT verspricht
  schnelleres Decoding) — bisher nur Größe verglichen.
- [ ] Sobald ein Java-Release > `v0.0.10` rauskommt, neue Jar ziehen
  und prüfen, ob die Float/Double-Casts und die Metadaten-Strenge
  upstream gefixt sind. URL der JAR liegt im Skript-Header.

## Referenzen

- Encoder-Help-Output: `java -jar vendor/mlt-encode.jar --help`
- Spec: <https://github.com/maplibre/maplibre-tile-spec>
- go-pmtiles: <https://github.com/protomaps/go-pmtiles>
