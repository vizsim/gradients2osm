# way_gradients

Berechnet pro OSM-Way **drei verschiedene Steigungs-Metriken** sowie Elevation Gain und Loss aus einem GeoTIFF-Höhenmodell (z.B. Sonny LiDAR DTM, ASTER GDEM, EU-DEM, Copernicus GLO-30).

Streaming-Verarbeitung über `pyosmium` und `rasterio`. Optionaler GeoPackage-Output für QGIS-Workflows. Mitgeliefert: ein Analyse-Skript zur Plausibilitäts-Prüfung der CSV-Outputs.

## Was rauskommt

Das Tool schreibt immer eine CSV mit den Höhenmetriken und kann zusätzlich ein GeoPackage mit Geometrie und OSM-Tags ausgeben.

### CSV-Spalten

| Spalte | Beschreibung |
| --- | --- |
| `osm_id` | OSM-Way-ID, zum Joinen mit anderen OSM-Daten. |
| `length_m` | Länge des Ways in Metern, berechnet im metrischen Ziel-CRS (Default UTM32N). |
| `gradient_abs_avg_pct` | **Rohe** durchschnittliche absolute Steigung in Prozent. Pro Segment des Ways wird der Betrag der lokalen Steigung berechnet (`\|Höhendifferenz\| / Segmentlänge × 100`), dann längengewichtet über alle Segmente gemittelt. Mathematisch äquivalent zu `(elevation_gain_m + elevation_loss_m) / length_m × 100`. **Empfindlich auf DEM-Rauschen** — bei 20-m-DEM und flachem Gelände ergibt sich systematisch ein Rauschboden von typisch 1-5 %, selbst auf tatsächlich ebenen Wegen. Diese Spalte bleibt aus Kompatibilitätsgründen erhalten, sollte aber für Auswertungen eher gegen die beiden folgenden ersetzt werden. |
| `gradient_smooth_pct` | **Geglättete** Steigung in Prozent. Das Höhenprofil wird zuerst mit einem Savitzky-Golay-Filter (Default `window=5`, `polyorder=2`) tiefpass-gefiltert, danach wird wieder das längengewichtete `\|dh\|/dl` berechnet. Reduziert DEM-Wackler deutlich (typisch um Faktor 1.5-2 gegen `abs_avg`), bewahrt aber echte Welligkeit auf der Strecke. **Empfohlene Default-Metrik** für Auswertungen, Routing, Symbology in QGIS. |
| `gradient_endpoint_pct` | **Endpunkt-Steigung** in Prozent: `\|h_letzter_valid - h_erster_valid\| / Wegstrecke × 100`. Komplett blind für alles dazwischen — keine Welligkeit, kein Mittenrauschen. Maximal rausch-robust (Rauschboden typ. <0.5 % bei 20-m-DEM), aber zeigt 0 für Wege die hochgehen und wieder runter (Hügel über die Strecke, Bachsenke). Reagiert empfindlich, wenn ein Endpunkt zufällig in einer DEM-Lücke oder einem Artefakt landet. |
| `elevation_gain_m` | Aufsummierte positive Höhendifferenz entlang des Ways in Metern (Roh-Profil, ungefiltert). Klassische Ascent-Definition wie in GPX-Tools. |
| `elevation_loss_m` | Aufsummierte negative Höhendifferenz entlang des Ways in Metern (Roh-Profil, als positive Zahl). Klassische Descent-Definition. |
| `n_samples` | Anzahl der Höhen-Samples nach dem Resampling. Diagnostik. |
| `is_bridge_or_tunnel` | `1` falls der Way als `bridge`, `tunnel` oder `covered` getaggt ist (jeweils Wert ≠ `no`), sonst `0`. Für solche Ways werden alle Steigungs-Spalten und Gain/Loss auf 0 gesetzt (siehe Methodik). |
| `is_bridge_adjacent` | `1` falls der erste **oder** letzte Node des Ways ein Endknoten eines anderen Bridge/Tunnel/Covered-Ways ist. Diese Anschluss-Ways hängen mit einem Endpunkt an einer Brückenkante, wo das DEM das Gelände unter der Brücke zeigt statt der Straßenhöhe — der entsprechende erste/letzte Höhen-Sample wird in der Pipeline auf NaN gesetzt und durch lineare Interpolation aus den Nachbarn ersetzt. Das beseitigt die künstliche Höhenstufe. Der Flag bleibt sichtbar, damit man im QGIS die Korrektur überprüfen kann. |
| `is_implausible_grad` | `1` falls `gradient_smooth_pct > --steep-flag-threshold` (Default 30 %). Der Gradient-Wert wird **nicht** gekappt — downstream kann selbst entscheiden, ob diese Ways gefiltert, gekappt oder hervorgehoben werden sollen. |
| `slope_1_fwd_pct` / `slope_1_bwd_pct` | Längengewichteter Anteil des Ways in der Steigungs-Klasse **2-4 %**. `fwd_pct` = Anteil der bei Vorwärts-Traversierung 2-4 % bergauf hat; `bwd_pct` analog für die Rückwärts-Traversierung (also 2-4 % Gefälle vorwärts). Berechnet auf dem **geglätteten** Profil. |
| `slope_2_fwd_pct` / `slope_2_bwd_pct` | Anteil in **4-6 %** Steigung. |
| `slope_3_fwd_pct` / `slope_3_bwd_pct` | Anteil in **6-10 %** Steigung. |
| `slope_4_fwd_pct` / `slope_4_bwd_pct` | Anteil in **10 %+** Steigung. |

### Welche Gradient-Spalte für was?

| Anwendung | Empfehlung |
| --- | --- |
| QGIS-Symbology, normale Auswertung | `gradient_smooth_pct` |
| Endpunkt-zu-Endpunkt-Anstieg (z.B. "wie viel höher ist B als A?") | `gradient_endpoint_pct` (mit Vorzeichen aus `gain - loss` falls signed gebraucht) |
| Vergleich mit alten Auswertungen aus dieser Pipeline | `gradient_abs_avg_pct` |
| Welligkeit erkennen (echte Auf-Ab-Bewegung) | `gradient_smooth_pct - gradient_endpoint_pct` |
| DEM-Rauschen identifizieren | `gradient_abs_avg_pct - gradient_smooth_pct` |
| Verteilung der Steigung über die Wegstrecke | `slope_1..4_fwd/bwd_pct` |

### Gates und Sonderfälle

- **Mindestlänge** (`--min-length-m`, Default 15 m): Ways unter dieser Länge bekommen alle drei Gradient-Spalten leer (CSV-leerstring → NaN beim Lesen). Grund: bei Mikro-Ways unter ~15 m wird jeder einzelne DEM-Sample-Wackler zu absurden Steigungen (siehe Abschnitt "Methodik" weiter unten). Gain/Loss bleiben trotzdem berechnet, weil das Roh-Information ist.
- **Brücken/Tunnel**: Alle drei Gradient-Spalten und Gain/Loss = 0. Grund: das DEM bildet das Gelände unter dem Bauwerk ab, nicht das Bauwerk selbst — eine Brücke über einem Tal würde sonst gigantische Scheinsteigungen produzieren.
- **Implausibel steile Ways**: Werte `gradient_smooth_pct > 30 %` werden nicht gekappt, sondern in `is_implausible_grad` markiert. Ist meistens entweder ein DEM-Artefakt (Kante zu einem Gebäude, Felswand) oder eine echte sehr steile Forst-/Almstraße.
- **DEM-Lücken** (NoData): NaN-Höhen werden in `savgol_smooth` und `gradient_endpoint_pct` linear interpoliert, damit nicht der ganze Way ausfällt. Wenn alle Samples NoData sind, bleiben alle drei Gradient-Spalten leer.

### GeoPackage-Spalten (optional)

Enthält alle CSV-Spalten plus:

- **Geometrie** als `LineString` in EPSG:4326.
- **Promoted OSM-Tags** als eigene Spalten: `highway`, `name`, `ref`, `surface`, `smoothness`, `maxspeed`, `oneway`, `lanes`, `bridge`, `tunnel`, `access`, `bicycle`, `foot`.
- **`tags_json`** mit allen restlichen OSM-Tags als JSON-String, falls man später noch was rausziehen will.

## Installation

Empfohlen mit [uv](https://github.com/astral-sh/uv):

```bash
uv init --bare
uv add numpy osmium rasterio pyproj tqdm
# Nur falls --out-gpkg genutzt wird:
uv add geopandas shapely pyogrio
```

Zusätzlich wird [osmium-tool](https://osmcode.org/osmium-tool/) als Kommandozeilen-Tool empfohlen, um große PBFs vorzufiltern (siehe unten).

## Nutzung

### Basis: nur CSV

```bash
uv run python way_gradients.py \
    --pbf input/saarland-260122-highways.osm.pbf \
    --dem "input/DTM Germany 20m v3b by Sonny.tif" \
    --out output/saarland_gradients.csv
```

### Mit GeoPackage für QGIS

```bash
uv run python way_gradients.py \
    --pbf input/saarland-260122-highways.osm.pbf \
    --dem "input/DTM Germany 20m v3b by Sonny.tif" \
    --out output/saarland_gradients.csv \
    --out-gpkg output/saarland_gradients.gpkg
```

Das GeoPackage ist räumlich sortiert (Hilbert-Curve) und enthält einen R-Tree-Index — Pan/Zoom und Symbology-Operationen sind in QGIS deutlich flotter als bei nicht-indizierten Formaten.

### Mit Geometrie-Vereinfachung (für schnelleres QGIS-Rendering)

```bash
uv run python way_gradients.py \
    --pbf input/saarland-260122-highways.osm.pbf \
    --dem "input/DTM Germany 20m v3b by Sonny.tif" \
    --out output/saarland_gradients.csv \
    --out-gpkg output/saarland_gradients.gpkg \
    --simplify-m 5
```

Douglas-Peucker mit 5 m Toleranz reduziert die Stützpunkte oft um 30-50 %, optisch in der Karte kaum erkennbar. Die Höhenmetriken werden auf der **Original-Geometrie** berechnet, nur die gespeicherte Visualisierungs-Geometrie wird vereinfacht.

### Default-Gates anpassen

```bash
# Strengere Mindestlänge und niedrigeres Implausibilitäts-Flag:
uv run python way_gradients.py \
    --pbf input/baden-wuerttemberg-highways.osm.pbf \
    --dem "input/DTM Germany 20m v3b by Sonny.tif" \
    --out output/bw_gradients.csv \
    --min-length-m 25 \
    --steep-flag-threshold 25
```

```bash
# Breitere Glättung für 50-m-DEMs:
uv run python way_gradients.py \
    --pbf input/germany-highways.osm.pbf \
    --dem "input/DTM Germany 50m v3b by Sonny.tif" \
    --out output/de_gradients.csv \
    --resample-m 50 \
    --smooth-window 7
```

## CLI-Optionen

| Flag | Default | Beschreibung |
| --- | --- | --- |
| `--pbf` | *required* | Eingabe-OSM-PBF-Datei. |
| `--dem` | *required* | GeoTIFF mit Höhendaten. CRS wird automatisch erkannt. |
| `--out` | *required* | Ziel-Pfad für die CSV. |
| `--out-gpkg` | — | Optional: Ziel-Pfad für das GeoPackage. Ohne Angabe wird kein GPKG geschrieben. |
| `--resample-m` | `25.0` | Maximaler Abstand zwischen Höhen-Stützpunkten in Metern. Sollte ungefähr der DEM-Zellgröße entsprechen — Sampling deutlich feiner als das DEM fügt nur Rauschen hinzu, kein Signal. Niedriger = genauer, langsamer. |
| `--simplify-m` | `0.0` | Douglas-Peucker-Toleranz in Metern für die Geometrie im GPKG. 0 = keine Vereinfachung. Sinnvolle Werte: 2-10. Beeinflusst **nicht** die Höhenberechnung. |
| `--target-crs` | `EPSG:25832` | Metrisches CRS für Längen- und Resampling-Berechnungen. Default ist UTM32N (passt für Deutschland). |
| `--sample-method` | `bilinear` | Höhen-Sampling-Methode: `bilinear` (Default) oder `nearest`. Bilinear interpoliert aus den 4 umliegenden Pixeln und reduziert den DEM-Sample-Rauschanteil deutlich (auf einem 20-m-DEM ist `gradient_abs_avg_pct` ca. 30 % niedriger auf flachem Gelände). `nearest` entspricht dem ursprünglichen `rasterio.sample()`-Verhalten und ist v.a. zum Reproduzieren alter Outputs sinnvoll. |
| `--min-length-m` | `15.0` | Mindestlänge in Metern, ab der überhaupt eine Steigung berechnet wird. Kürzere Ways bekommen alle drei Gradient-Spalten leer (Mikro-Ways sind extrem rauschanfällig). |
| `--smooth-window` | `5` | Fenstergröße in Samples für die Savitzky-Golay-Glättung bei `gradient_smooth_pct`. Muss ungerade und ≥3 sein. Bei `--resample-m=25` deckt ein Fenster von 5 etwa 125 m ab. Größeres Fenster = stärkere Glättung = mehr Rauschunterdrückung, aber echte kurze Steilstücke werden auch stärker gedämpft. |
| `--smooth-polyorder` | `2` | Polynom-Grad für Savitzky-Golay. Muss `< smooth-window` sein. 2 ist klassisch und passt fast immer. |
| `--steep-flag-threshold` | `30.0` | Über diesem `gradient_smooth_pct` wird `is_implausible_grad=1` gesetzt. Der Wert wird **nicht** gekappt, nur markiert. |

## Methodik

### Höhensampling

Pro Way werden die Original-Nodes verwendet und in das `--target-crs` projiziert. Wenn ein Segment länger als `--resample-m` ist, werden zusätzliche Stützpunkte eingefügt. Damit verhindert man, dass lange gerade Wegstücke mit nur zwei Endpunkten beprobt werden und Höhenänderungen dazwischen verloren gehen.

Die Stützpunkte werden ins DEM-CRS zurückprojiziert und dann gesampelt — per Default bilinear über die 4 umliegenden Pixel (s. `--sample-method`). NoData-Pixel kriegen Gewicht 0, fallen also aus der bilinearen Mittelung raus; wenn alle 4 Ecken NoData sind, wird der Sample-Wert NaN.

**Warum bilinear statt nearest-neighbor?** Mit nearest-neighbor (was `rasterio.sample()` macht) snappt jeder Sample-Punkt zum nächsten Pixel-Mittelpunkt. Zwei dicht aufeinanderfolgende Sample-Punkte können entweder auf denselben Pixel fallen (Δh = 0) oder auf benachbarte Pixel mit voller Pixel-zu-Pixel-Differenz inklusive Rauschen — abhängig allein von der zufälligen Lage des Way-Verlaufs relativ zum DEM-Raster. Das treibt den scheinbaren Δh zwischen Samples künstlich hoch. Bei bilinearer Interpolation sind die Werte räumlich korreliert (überlappende 2×2-Nachbarschaften), und der Rausch-Anteil pro Sample-Paar reduziert sich entsprechend. Auf einem 20-m-DEM in Saarland fällt der Rauschboden für `gradient_abs_avg_pct` damit von p95 ≈ 6.3 % auf ≈ 4.3 %.

### Die drei Gradient-Metriken im Detail

#### `gradient_abs_avg_pct` — roh, ungefiltert

Pro Segment wird `|Δh| / Δl` berechnet, dann längengewichtet über alle gültigen Segmente gemittelt. Mathematisch ist das identisch zu `(gain + loss) / length`.

Das **Problem mit DEM-Rauschen**: Bei einem 20-m-DEM hat jedes einzelne Höhen-Sample typisch ±1 m vertikale Unsicherheit. Wenn du an benachbarten Punkten (z.B. alle 25 m) samplst, hat die Differenz `Δh` einen Rausch-Anteil von ~1.4 m. Das ergibt eine apparente Steigung von ~1.4/25 = 5.6 % — und zwar selbst auf einer komplett ebenen Straße. Über viele Segmente eines langen Ways akkumuliert sich das nicht (das Mittel bleibt), aber für jeden einzelnen Way bleibt der Rauschboden vorhanden.

**Konkretes Beispiel:** Ein 481 m langer Way auf flachem Saarland-Gelände bekommt mit dieser Metrik typisch 4-5 % Steigung, allein durch DEM-Rauschen. Das ist nicht die echte Steigung der Straße, sondern eine Eigenschaft der Datenpipeline.

#### `gradient_smooth_pct` — Savitzky-Golay-geglättet

Das Höhenprofil wird vor der Differenz-Berechnung mit einem Savitzky-Golay-Filter geglättet (Window = `--smooth-window`, polyorder = `--smooth-polyorder`). Der Filter fittet lokal ein Polynom zweiten Grades durch ein Fenster von Samples und ersetzt jeden Wert durch den Polynom-Wert an dieser Stelle.

Was das physikalisch macht: hochfrequentes Rauschen (Sample-zu-Sample-Variation, die nicht ins lokale Polynom passt) wird unterdrückt. Niederfrequente Geländeformen (langsame Hügel, gleichmäßige Steigungen) bleiben praktisch unverändert. Danach wird wieder das normale `|dh|/dl`-Mittel berechnet — aber jetzt auf einem rauscharmen Profil.

**Trade-off:** Echte kurze Steilstufen (Brückenrampen, Felsabbrüche) werden ebenfalls leicht gedämpft. Bei zu großem Fenster verlierst du Detail; bei zu kleinem hilft die Glättung kaum. Default `window=5` bei `resample-m=25` deckt ~125 m ab — guter Kompromiss für die meisten Anwendungen.

NaN-Samples im Profil (DEM-Lücken) werden vor dem Filter linear interpoliert, damit nicht ganze Fenster invalidiert werden. An den Rändern wird der Randwert repliziert ('edge'-Padding), nicht reflektiert — das wäre eine künstliche Symmetrie-Annahme an Way-Enden.

**Auf dem 481-m-Beispiel** reduziert die Glättung den Wert von ~4.4 % auf ~1-2 % — näher an der Realität, ohne dabei echte Steigungen zu killen.

#### `gradient_endpoint_pct` — nur Anfang und Ende

`|h_letzter_valid - h_erster_valid| / Wegstrecke × 100`. Komplett blind für alles auf der Strecke dazwischen.

Vorteil: Das Rauschen mittelt sich nicht über viele Samples auf — du hast genau zwei Sample-Punkte, also genau einen Δh-Rausch-Anteil über die ganze Wegstrecke. Bei 481 m und σ=1 m DEM-Rauschen ist der Noise-Floor `~1.4 m / 481 m = 0.3 %` — Größenordnungen besser als `abs_avg`.

Nachteil: ein Weg, der 10 m hoch und gleich 10 m wieder runter geht, bekommt hier `endpoint_pct = 0`. Das ist mathematisch korrekt ("am Ende bist du auf gleicher Höhe wie am Anfang"), aber für Rad-/E-Bike-Anwendungen ist das irreführend — der Berg ist real. Ein einzelner kaputter Endpunkt (Hausdach, DEM-Lücke) wirkt sich auch deutlich stärker aus als bei den gemittelten Metriken.

Deshalb am besten in Kombination mit `gradient_smooth_pct` lesen: wenn die beiden weit auseinanderliegen, hat die Strecke Welligkeit.

### Elevation Gain / Loss

Aufsummierte positive bzw. negative Höhendifferenzen zwischen aufeinanderfolgenden Stützpunkten — immer auf dem **Roh-Profil**, ungefiltert. Klassische Ascent/Descent-Definition wie in GPX-Tools. Hat denselben DEM-Rauschen-Bias wie `gradient_abs_avg_pct` (die beiden sind mathematisch verwandt), bleibt aber als ehrliche Roh-Information erhalten.

### Steigungs-Klassen-Anteile (`slope_1..4_fwd/bwd_pct`)

Acht zusätzliche Spalten geben pro Way die längengewichteten Anteile in vier disjunkten Steigungs-Klassen aus, getrennt nach Vorwärts- und Rückwärts-Traversierung. Die Klassen-Grenzen sind an die Konvention aus [RSGInc/ladot_analysis_dataprep](https://github.com/RSGInc/ladot_analysis_dataprep) angelehnt, hier aber **disjunkt** definiert (jedes Segment landet in genau einer Klasse).

| Klasse | Steigungs-Bereich |
| --- | --- |
| `slope_1` | 2-4 % |
| `slope_2` | 4-6 % |
| `slope_3` | 6-10 % |
| `slope_4` | 10 %+ |

**Signed und richtungsabhängig**: `fwd` zählt den Anteil des Ways, der bei Vorwärts-Traversierung in der Steigungs-Klasse liegt (also bergauf in Way-Richtung). `bwd` ist der entsprechende Anteil bei Rückwärts-Traversierung (= bergab in Way-Richtung). Da die Bins disjunkt sind, summieren sich `slope_1..4_fwd_pct + slope_1..4_bwd_pct + (flacher Anteil unter 2 %)` zu 100 % je Way. Flache Segmente unter 2 % tauchen in keiner Klasse auf — der Restbetrag zu 100 % verteilt sich auf "flach".

**Berechnet auf dem geglätteten Profil**: Würde man die Klassen aus dem Roh-Profil bestimmen, lägen viele eigentlich-flache Segmente durch DEM-Rauschen falsch in der 2-4 %- oder 4-6 %-Klasse. Durch die Glättung wird dieser systematische Falsch-Positiv-Bias deutlich reduziert.

**Beispiel-Interpretation**: Way 581877035 (61 m lange private Einfahrt, `gradient_smooth_pct = 3.1 %`): `slope_1_fwd_pct = 8.4 %`, `slope_2_fwd_pct = 15.7 %`, `slope_3_fwd_pct = 20.6 %`, `slope_4_fwd_pct = 0 %`, alle `bwd` = 0. Heißt: ca. 5 m sind bei Vorwärts-Traversierung 2-4 % bergauf, 10 m sind 4-6 % bergauf, 13 m sind 6-10 % bergauf, kein Stück über 10 %. Die restlichen ~33 m sind flach (< 2 %). Es gibt also einen klar bergauf führenden Mittelteil mit flachen Anfangs- und End-Abschnitten.

### Brücken, Tunnel, überdeckte Strecken

Ways mit `bridge=*`, `tunnel=*` oder `covered=*` (jeweils ≠ `no`) werden geflaggt (`is_bridge_or_tunnel=1`) und mit allen drei Steigungs-Spalten und Gain/Loss = 0 belegt. Die Länge wird trotzdem korrekt berechnet. Das DEM bildet hier nicht die Straßenhöhe ab — bei einer Brücke das Gelände drunter (Bach, Tal), bei einem Tunnel die Topographie darüber, bei `covered=yes` (z.B. Straße unter Eisenbahnbrücke) oft die überdeckende Struktur. Eine Höhenmetrik wäre in allen drei Fällen sinnlos.

### Anschluss-Ways an Brücken/Tunneln (`is_bridge_adjacent`)

Wenn ein normaler Way mit seinem Endpunkt an einer Brückenkante anschließt, sitzt dieser Endpunkt geometrisch auf Straßenhöhe (Brückenkante), aber das DEM zeigt dort das Gelände drunter — ein Höhenunterschied von oft 5-15 m. Das erste oder letzte Segment des Anschluss-Ways hätte ohne Korrektur eine künstliche "Steigung" durch diesen Sprung; gerade bei kurzen Anschluss-Ways kann das die Steigung um zweistellige Prozentpunkte verfälschen.

Die Pipeline erkennt diese Fälle, indem sie im ersten PBF-Pass die End-Node-IDs aller bridge/tunnel/covered Ways einsammelt und im zweiten Pass für jeden normalen Way prüft, ob sein erster oder letzter Node in der Set steht. Trifft das zu, wird der entsprechende DEM-Sample auf NaN gesetzt. Der Savitzky-Golay-Filter interpoliert den fehlenden Wert anschließend linear aus den nächsten gültigen Samples — damit verschwindet der Sprung, ohne dass ein Sample-Punkt komplett verloren geht.

Der Flag `is_bridge_adjacent=1` bleibt im Output, damit man im QGIS die korrigierten Ways visuell separat einfärben kann. In Saarland trifft das auf etwa 6 % der Ways zu (~4.700 von 80.400). Bei Stichproben-Vergleichen sieht man typische Korrekturen von 5-9 Prozentpunkten im `gradient_smooth_pct` bei den am stärksten betroffenen Ways.

**Limitation**: erkannt werden nur Anschlüsse an den **Endknoten** anderer Brücken-Ways. Mid-Verbindungen (T-Einmündungen mitten auf einer Brücke) werden nicht erfasst. Das sind in OSM seltene Fälle, aber falls wichtig: einfach in `WayCounter.way()` alle Nodes statt nur Endknoten in die Set aufnehmen.

## Plausibilitäts-Analyse

Im Repo liegt `analyze_gradients.py`, das eine erzeugte CSV einliest und Verteilungen, Auffälligkeiten und Beispiel-Kandidaten ausgibt:

```bash
uv run python analyze_gradients.py output/saarland_gradients.csv
```

Was du da bekommst:

- Verteilungs-Quantile + ASCII-Histogramme für Länge und für jede der drei Gradient-Spalten
- Anteil "kurz & steil", "implausibel steil", "Bridge/Tunnel", "ohne DEM-Sample"
- **Noise-Inflation**: Ways, bei denen `abs_avg - smooth > 2 pp` — also Stellen, wo die Glättung erkennbar Rauschen rausgenommen hat
- **Welligkeit erkannt**: Ways, bei denen `smooth - endpoint > 2 pp` — also Stellen mit echter Auf-Ab-Bewegung, die der Endpunkt-Vergleich nicht sieht
- **Rausch-Boden-Schätzung**: für definitiv-flache Ways (kleiner Netto-Drift, ausreichend lang) werden die drei Gradient-Verteilungen verglichen — gut um den DEM-Rauschen-Charakter der konkreten Pipeline zu sehen

Auf einem 20-m-Sonny-DTM in Saarland sieht der Rauschboden bei nachweislich flachen Wegen mit der Default-Konfiguration (bilinear) so aus:

- `gradient_abs_avg_pct`: p50 = 1.1 %, p95 = 4.3 %
- `gradient_smooth_pct`: p50 = 0.8 %, p95 = 3.9 %
- `gradient_endpoint_pct`: p50 = 0.2 %, p95 = 0.5 %

Mit `--sample-method=nearest` (zum Vergleich) liegt der Rauschboden bei `abs_avg_pct` etwa 30 % höher (p95 ≈ 6.3 %), bei `smooth_pct` und `endpoint_pct` ist der Unterschied kleiner, weil diese ohnehin weniger sample-rauschanfällig sind.

Daran erkennt man auch, **welche Metrik für welche Anwendung** den geringsten systematischen Bias hat.

Das Skript unterstützt auch ältere CSV-Outputs (nur `gradient_abs_avg_pct`), zeigt dann entsprechend weniger Auswertungen an.

## Workflow-Beispiel: Saarland

PBF von Geofabrik laden:

```bash
wget https://download.geofabrik.de/europe/germany/saarland-latest.osm.pbf
```

DEM beziehen (z.B. [Sonny LiDAR DTMs](https://sonny.4lima.de/) für 20 m Auflösung Europa).

Vorfilterung der PBF auf Straßennetz (massiv schneller als ohne):

```bash
osmium tags-filter input/saarland-latest.osm.pbf w/highway \
    -o input/saarland-260122-highways.osm.pbf
```

Steigungen berechnen:

```bash
uv run python way_gradients.py \
    --pbf input/saarland-260122-highways.osm.pbf \
    --dem "input/DTM Germany 20m v3b by Sonny.tif" \
    --out output/saarland_gradients.csv \
    --out-gpkg output/saarland_gradients.gpkg \
    --simplify-m 5
```

In QGIS das GPKG öffnen und z.B. Graduated Symbology auf `gradient_smooth_pct` setzen. Ways mit `is_implausible_grad = 1` separat einfärben, um Verdachtsfälle direkt zu sehen. Für Routing-Anwendungen können die `slope_*_fwd/bwd_pct`-Spalten direkt als Cost-Inputs in OpenTripPlanner o.ä. eingebunden werden.

## Performance-Hinweise

- **Streaming-Verarbeitung**: Die CSV wird zeilenweise geschrieben, kein RAM-Sammeln. Funktioniert auch für große Extrakte (Deutschland o.ä.).
- **GeoPackage hält Records im Speicher**: Bei `--out-gpkg` werden alle Datensätze für den finalen Write gepuffert. Für Saarland (~80k Ways) unkritisch. Bei Deutschland-Größenordnung (mehrere Millionen Ways) wird das zum Thema — dann nur CSV nutzen oder das Tool tile-weise laufen lassen.
- **Vorfilterung mit `osmium tags-filter` ist quasi Pflicht** für alles ab Bundesland-Größe.
- **DEM-CRS und Target-CRS**: Wenn beide übereinstimmen, sparst du dir eine Hin-und-Rück-Reprojektion pro Sample. Sonny-DTMs liegen typischerweise in UTM32N (EPSG:32632) vor, was zur Default-Konfiguration passt.
- **Resampling vs. DEM-Auflösung**: Bei einem 20-m-DEM bringt `--resample-m` deutlich unter 20 kein zusätzliches Signal, nur mehr Rauschen und mehr Rechenzeit. Default 25 ist ein vernünftiger Kompromiss; bei einem 50-m-DEM lieber `--resample-m 50` und passend dazu z.B. `--smooth-window 7` setzen.

## Beispiel-Output

```text
osm_id,length_m,gradient_abs_avg_pct,gradient_smooth_pct,gradient_endpoint_pct,elevation_gain_m,elevation_loss_m,slope_1_fwd_pct,slope_1_bwd_pct,slope_2_fwd_pct,slope_2_bwd_pct,slope_3_fwd_pct,slope_3_bwd_pct,slope_4_fwd_pct,slope_4_bwd_pct,n_samples,is_bridge_or_tunnel,is_bridge_adjacent,is_implausible_grad
3998029,257,1.0,0.9,0.9,2.3,0.1,8.7,0.0,0.0,0.0,0.0,0.0,0.0,0.0,12,0,1,0
3998240,100,4.5,3.5,4.5,3.4,-0.0,25.0,0.0,50.0,0.0,0.0,0.0,0.0,0.0,5,0,1,0
4065354,336,2.6,2.2,2.1,0.9,7.8,0.0,4.4,0.0,14.5,0.0,4.0,0.0,0.0,18,0,0,0
4065392,954,1.0,0.4,0.1,5.3,4.2,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,47,0,0,0
4065457,862,3.0,1.8,0.2,11.4,13.0,6.2,17.9,0.0,0.6,2.7,2.1,1.2,0.0,52,0,0,0
```

Schnell-Interpretation:

- `4065392` (954 m): alle drei Skalare niedrig, alle Slope-Klassen null. Ehrlich flacher Weg.
- `3998240` (100 m, `is_bridge_adjacent=1`): nach Bridge-Adjacent-Korrektur landen 25 % der Strecke in 2-4 % fwd und 50 % in 4-6 % fwd. Slope_3/Slope_4 = 0, also keine extremen Steilstücke. Restliche 25 % sind flach. Konsistent mit `smooth=3.5 %`.
- `4065457` (862 m): Mischprofil mit Anteilen in beiden Richtungen über alle Klassen. `gradient_endpoint_pct = 0.2 %` zeigt, dass Anfangs- und Endpunkt fast auf gleicher Höhe sind — `gain ≈ loss`. Die `slope_*`-Anteile summieren sich zu 6.2 + 17.9 + 0 + 0.6 + 2.7 + 2.1 + 1.2 + 0 = 30.7 % im Steigungs-Bereich, restliche ~69 % flach.

## Lizenz / Hinweise

OSM-Daten unter ODbL. Höhendaten-Lizenz je nach Quelle prüfen (Sonny-DTMs sind unter CC-BY 4.0 mit Attribution-Pflicht).
