"""
Berechnet pro OSM-Way drei Steigungs-Metriken sowie Elevation Gain/Loss
aus einem GeoTIFF-Höhenmodell.

Drei Gradient-Spalten:
- gradient_abs_avg_pct: längengewichtetes Mittel über |dh|/dl pro Segment.
  Empfindlich auf DEM-Noise (Rauschboden typ. 1-5% bei 20m-DEM).
- gradient_smooth_pct: gleiche Methode, aber auf Savitzky-Golay-geglättetem
  Höhenprofil (window=5, polyorder=2). Reduziert DEM-Wackler, bewahrt
  echte Welligkeit. Empfohlene Default-Metrik für Auswertungen.
- gradient_endpoint_pct: |h_letzter_valid - h_erster_valid| / länge.
  Maximal rausch-robust, ignoriert aber Welligkeit auf der Strecke.

Steigungs-Klassen-Anteile (signed, längengewichteter Anteil pro disjunkte
Klasse, in %, getrennt nach fwd/bwd-Richtung):
- slope_1_{fwd,bwd}_pct: 2-4% Steigung
- slope_2_{fwd,bwd}_pct: 4-6% Steigung
- slope_3_{fwd,bwd}_pct: 6-10% Steigung
- slope_4_{fwd,bwd}_pct: 10%+ Steigung
Die Bins sind disjunkt, jedes Segment landet in genau einem (oder keinem,
wenn unter 2%). Werden auf dem geglätteten Profil berechnet, damit DEM-Noise
nicht in die unteren Bins läuft.

Methodik:
- Stützpunkte werden bei langen Segmenten auf eine konfigurierbare Distanz
  resampelt (Default 25 m).
- Höhen werden aus dem GeoTIFF (z.B. Sonny LiDAR DTM) abgefragt.
- Elevation Gain = Summe positiver dh, Loss = Summe negativer dh (als positiv,
  immer auf dem Roh-Profil).
- Gates: Ways unter --min-length-m bekommen alle Gradient-Spalten als leer.
  Ways mit gradient_smooth_pct > --steep-flag-threshold werden in
  is_implausible_grad markiert (Werte bleiben erhalten, kein Capping).
- Brücken und Tunnel werden geflaggt und mit Steigung/Gain/Loss = 0 belegt.
- Streaming-Verarbeitung in die CSV — kein Sammeln im RAM.
- Optionaler FlatGeobuf-Output mit Geometrie + OSM-Tags + Höhenmetriken.
  Direkt von Tippecanoe lesbar (Tile-Pipeline) und in QGIS verwendbar
  (Index wird beim ersten Öffnen aufgebaut).
  Achtung: FGB wird am Ende in einem Rutsch geschrieben, dafür müssen
  die Way-Datensätze im Speicher gehalten werden. Für Saarland-Größenordnung
  unproblematisch.

Empfohlener Vorverarbeitungsschritt für große PBFs (Deutschland o.ä.):
    osmium tags-filter germany-latest.osm.pbf w/highway \\
        -o germany-highways.osm.pbf

Voraussetzungen:
    uv init --bare
    uv add numpy osmium rasterio pyproj tqdm
    # Nur für --out-fgb zusätzlich:
    uv add geopandas shapely pyogrio

Aufruf:
    uv run python way_gradients.py \
        --pbf input/saarland-260122-highways.osm.pbf \
        --dem "input/DTM Germany 50m v3b by Sonny.tif" \
        --out output/saarland_gradients.csv \
        --out-fgb output/saarland_gradients.fgb \
        --resample-m 25 \
        --target-crs EPSG:25832
"""

from __future__ import annotations

import argparse
import csv
import logging
import math
from pathlib import Path

import numpy as np
import osmium
import rasterio
from rasterio.windows import Window
from pyproj import Transformer
from tqdm import tqdm

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent
INPUT_DIR = PROJECT_ROOT / "input"
OUTPUT_DIR = PROJECT_ROOT / "output"

# highway-Tags, die als "Straße" betrachtet werden.
HIGHWAY_WHITELIST = {
    "motorway", "motorway_link",
    "trunk", "trunk_link",
    "primary", "primary_link",
    "secondary", "secondary_link",
    "tertiary", "tertiary_link",
    "unclassified", "residential",
    "service", "living_street",
}

# Defaults für die Gates und die Glättung.
DEFAULT_MIN_LENGTH_M = 15.0
DEFAULT_SMOOTH_WINDOW = 5
DEFAULT_SMOOTH_POLYORDER = 2
DEFAULT_STEEP_FLAG_PCT = 30.0
DEFAULT_SAMPLE_METHOD = "bilinear"  # "bilinear" oder "nearest"

# Längengewichteter Anteil des Ways pro Steigungs-Klasse, getrennt nach
# Vorwärts- (bergauf) und Rückwärtsrichtung (= bergab vorwärts). Bin-Grenzen
# orientieren sich am LADOT/RSG-Schema, sind hier aber als **disjunkte** Bins
# definiert: jedes Segment landet in genau einem Bin (oder gar keinem wenn
# unter 2%). Damit summieren sich die Bin-Anteile + flacher Anteil zu 100%
# je Richtung, und es gibt keine Doppelzählung. Berechnet auf dem geglätteten
# Profil, damit DEM-Rauschen nicht systematisch in die unteren Bins läuft.
LADOT_SLOPE_BINS = (
    ("slope_1", 0.02, 0.04),  # 2-4%
    ("slope_2", 0.04, 0.06),  # 4-6%
    ("slope_3", 0.06, 0.10),  # 6-10%
    ("slope_4", 0.10, math.inf),  # 10%+
)

_LADOT_FIELDS = tuple(
    f"{name}_{direction}_pct"
    for name, _lo, _hi in LADOT_SLOPE_BINS
    for direction in ("fwd", "bwd")
)

CSV_HEADER = [
    "osm_id",
    "length_m",
    "gradient_abs_avg_pct",
    "gradient_smooth_pct",
    "gradient_endpoint_pct",
    "elevation_gain_m",
    "elevation_loss_m",
    *_LADOT_FIELDS,
    "n_samples",
    "is_bridge_or_tunnel",
    "is_bridge_adjacent",
    "is_implausible_grad",
]

# OSM-Tags, die als eigene Spalten im Geo-Output auftauchen.
# Alles weitere landet in der "tags"-Dict-Spalte.
PROMOTED_TAGS = (
    "highway",
    "name",
    "ref",
    "surface",
    "smoothness",
    "maxspeed",
    "oneway",
    "lanes",
    "bridge",
    "tunnel",
    "access",
    "bicycle",
    "foot",
)


def print_welcome_banner() -> None:
    banner = r"""
                       _ _            _        ___                          
                      | (_)          | |      |__ \                         
    __ _ _ __ __ _  __| |_  ___ _ __ | |_ ___    ) | ___  ___ _ __ ___      
   / _` | '__/ _` |/ _` | |/ _ \ '_ \| __/ __|  / / / _ \/ __| '_ ` _ \     
  | (_| | | | (_| | (_| | |  __/ | | | |_\__ \ / /_| (_) \__ \ | | | | |    
   \__, |_|  \__,_|\__,_|_|\___|_| |_|\__|___/|____|\___/|___/_| |_| |_|    
   __/ |                                                                    
  |___/                                                                     

              /\       /\        /\
             /  \     /  \  /\  /  \
            /    \___/    \/  \/    \
           /                          \
      ____/____________________________\____
      =======================================
      - - - - - - - - - - - - - - - - - - -
      =======================================

                    gradients2osm
    """
    print(banner, flush=True)


def resolve_input_path(path: Path) -> Path:
    if path.is_absolute():
        return path
    if path.parts and path.parts[0] in {INPUT_DIR.name, ".", ".."}:
        return PROJECT_ROOT / path
    return INPUT_DIR / path


def resolve_output_path(path: Path) -> Path:
    if path.is_absolute():
        return path
    if path.parts and path.parts[0] in {OUTPUT_DIR.name, ".", ".."}:
        return PROJECT_ROOT / path
    return OUTPUT_DIR / path


def is_dem_decoupled(tags) -> bool:
    """
    Way ist vom DEM "entkoppelt" — das DEM bildet das Gelände ab, nicht das
    Straßenniveau. Trifft zu bei Brücken, Tunneln und überdeckten Strecken
    (covered=yes, z.B. Straße unter einer Eisenbahnbrücke). Diese Ways selbst
    bekommen Höhenmetriken=0; ihre Endknoten kontaminieren zusätzlich angrenzende
    Ways, weil dort das DEM nicht auf der Straßenhöhe sitzt.
    """
    return (
        tags.get("bridge") not in (None, "no")
        or tags.get("tunnel") not in (None, "no")
        or tags.get("covered") not in (None, "no")
    )


def sample_heights(
    dem: rasterio.io.DatasetReader,
    xs: np.ndarray,
    ys: np.ndarray,
    method: str = DEFAULT_SAMPLE_METHOD,
) -> np.ndarray:
    """
    Samplet Höhen aus einem DEM an den Punkten (xs, ys) im DEM-CRS.

    method="nearest": entspricht rasterio.sample() — jeder Sample-Punkt
        snappt zum nächsten Pixel-Mittelpunkt. Zwei benachbarte Punkte können
        auf denselben Pixel fallen (Δh=0) oder auf benachbarte Pixel (volle
        Pixel-Differenz). Dadurch entsteht ein systematischer Punkt-Rausch-
        Anteil, der den Gradient-Rauschboden auf typisch 4-5% bei 20m-DEM
        treibt.

    method="bilinear": liest ein DEM-Fenster um die Punkte und interpoliert
        bilinear aus den 4 umliegenden Pixeln. Da benachbarte Sample-Punkte
        überlappende Pixel-Nachbarschaften haben, sind ihre Höhen-Werte
        räumlich korreliert — der Δh-Rauschanteil zwischen aufeinander-
        folgenden Samples sinkt entsprechend, typisch um Faktor 2-3.

    NoData-Pixel werden mit Gewicht 0 in die bilineare Mittelung einbezogen
    (also weighted-average über gültige Ecken). Wenn alle 4 Ecken NoData
    sind, kommt NaN raus. Punkte ausserhalb des DEM ergeben NaN.
    """
    if method == "nearest":
        # Original-Verhalten: rasterio.sample mit nearest-neighbor.
        return np.array(
            [v[0] for v in dem.sample(list(zip(xs, ys)))], dtype=float
        )

    if method != "bilinear":
        raise ValueError(f"Unbekannte Sample-Methode: {method!r}")

    # Pixel-Koordinaten (sub-pixel) via inverse Affine-Transform.
    inv = ~dem.transform
    cols, rows = inv * (np.asarray(xs, dtype=float), np.asarray(ys, dtype=float))
    cols = np.asarray(cols, dtype=float)
    rows = np.asarray(rows, dtype=float)

    n = len(cols)
    if n == 0:
        return np.array([], dtype=float)

    # Bounding-Window mit 1-Pixel-Puffer in jede Richtung, damit floor/ceil
    # an den Rändern noch existierende Pixel treffen.
    col_min = int(np.floor(np.nanmin(cols))) - 1
    col_max = int(np.ceil(np.nanmax(cols))) + 1
    row_min = int(np.floor(np.nanmin(rows))) - 1
    row_max = int(np.ceil(np.nanmax(rows))) + 1

    col_min = max(0, col_min)
    row_min = max(0, row_min)
    col_max = min(dem.width, col_max)
    row_max = min(dem.height, row_max)

    if col_max <= col_min or row_max <= row_min:
        return np.full(n, np.nan)

    window = Window(col_min, row_min, col_max - col_min, row_max - row_min)
    arr = dem.read(1, window=window).astype(float)

    nodata = dem.nodata
    if nodata is not None:
        arr[arr == nodata] = np.nan

    # Pixel-Indices relativ zum Window.
    cols_w = cols - col_min
    rows_w = rows - row_min

    col0 = np.floor(cols_w).astype(int)
    row0 = np.floor(rows_w).astype(int)
    col1 = col0 + 1
    row1 = row0 + 1

    h, w = arr.shape
    # In-Window-Maske: wenn col0/row0 außerhalb, sind alle 4 Ecken nicht da.
    in_window = (col0 >= 0) & (row0 >= 0) & (col1 < w) & (row1 < h)

    col0c = np.clip(col0, 0, max(w - 1, 0))
    col1c = np.clip(col1, 0, max(w - 1, 0))
    row0c = np.clip(row0, 0, max(h - 1, 0))
    row1c = np.clip(row1, 0, max(h - 1, 0))

    fx = cols_w - col0
    fy = rows_w - row0

    v00 = arr[row0c, col0c]
    v10 = arr[row0c, col1c]
    v01 = arr[row1c, col0c]
    v11 = arr[row1c, col1c]

    weights = np.stack([
        (1 - fx) * (1 - fy),
        fx * (1 - fy),
        (1 - fx) * fy,
        fx * fy,
    ])
    values = np.stack([v00, v10, v01, v11])

    # Bei NoData-Ecken: Gewicht auf 0, Wert auf 0 — dann normalisieren.
    valid = np.isfinite(values)
    valid_weights = np.where(valid, weights, 0.0)
    weight_sum = valid_weights.sum(axis=0)
    values_filled = np.where(valid, values, 0.0)
    weighted = (values_filled * valid_weights).sum(axis=0)

    with np.errstate(invalid="ignore", divide="ignore"):
        out = np.where(weight_sum > 0, weighted / weight_sum, np.nan)
    out[~in_window] = np.nan
    return out


def savgol_smooth(
    values: np.ndarray,
    window: int = DEFAULT_SMOOTH_WINDOW,
    polyorder: int = DEFAULT_SMOOTH_POLYORDER,
) -> np.ndarray | None:
    """
    Savitzky-Golay-Smoothing für ein 1D-Höhenprofil. Gibt None zurück, wenn
    das Profil zu kurz für die gewählte Fenstergröße ist.

    NaN-Werte (DEM-Lücken) werden vorher linear interpoliert, sonst würde
    jedes Fenster, das einen NaN enthält, kollabieren. An den Rändern wird
    mit Replikation des Randwerts ('edge') gepaddet — für offene Profile
    (Straßen) neutraler als Reflexion, die fälschlicherweise eine Symmetrie
    an den Endpunkten unterstellt.

    Window=5/polyorder=2 ergibt die klassischen Koeffizienten [-3,12,17,12,-3]/35;
    werden hier aber generisch über Pseudoinverse einer Vandermonde-Matrix
    berechnet, damit auch window=7 oder 9 funktionieren.
    """
    if window <= polyorder or window % 2 == 0 or window < 3:
        raise ValueError(
            f"Ungültige Savgol-Parameter: window={window}, polyorder={polyorder}. "
            f"window muss ungerade, >= 3 und > polyorder sein."
        )
    n = len(values)
    if n < window:
        return None

    finite = np.isfinite(values)
    if not finite.any():
        return None
    if not finite.all():
        x = np.arange(n)
        values = np.interp(x, x[finite], values[finite])

    half = window // 2
    xx = np.arange(-half, half + 1, dtype=float)
    # Smoothing-Koeffizienten = erste Zeile der Pseudoinversen der
    # Vandermonde-Matrix (entspricht dem konstanten Glied im lokal
    # gefitteten Polynom an x=0).
    A = np.vander(xx, polyorder + 1, increasing=True)
    coeffs = np.linalg.pinv(A)[0]
    padded = np.pad(values, half, mode="edge")
    return np.convolve(padded, coeffs[::-1], mode="valid")


def resample_line(
    xs: np.ndarray, ys: np.ndarray, max_spacing: float
) -> tuple[np.ndarray, np.ndarray, float]:
    """
    Fügt zusätzliche Stützpunkte ein, wenn ein Segment länger als max_spacing ist.
    xs/ys sind in einem metrischen CRS. Gibt resampelte Punkte und Gesamtlänge zurück.
    """
    if max_spacing <= 0:
        seg_len = np.hypot(np.diff(xs), np.diff(ys))
        return xs, ys, float(seg_len.sum())

    new_xs: list[float] = [float(xs[0])]
    new_ys: list[float] = [float(ys[0])]
    total_len = 0.0

    for i in range(len(xs) - 1):
        dx = xs[i + 1] - xs[i]
        dy = ys[i + 1] - ys[i]
        seg_len = math.hypot(dx, dy)
        total_len += seg_len
        if seg_len <= max_spacing or seg_len == 0:
            new_xs.append(float(xs[i + 1]))
            new_ys.append(float(ys[i + 1]))
            continue
        n_sub = int(math.ceil(seg_len / max_spacing))
        for k in range(1, n_sub + 1):
            t = k / n_sub
            new_xs.append(float(xs[i] + t * dx))
            new_ys.append(float(ys[i] + t * dy))

    return np.asarray(new_xs), np.asarray(new_ys), total_len


def compute_way_stats(
    coords: list[tuple[float, float]],
    dem: rasterio.io.DatasetReader,
    to_dem: Transformer,
    to_metric: Transformer,
    resample_m: float,
    min_length_m: float = DEFAULT_MIN_LENGTH_M,
    smooth_window: int = DEFAULT_SMOOTH_WINDOW,
    smooth_polyorder: int = DEFAULT_SMOOTH_POLYORDER,
    steep_flag_pct: float = DEFAULT_STEEP_FLAG_PCT,
    sample_method: str = DEFAULT_SAMPLE_METHOD,
    drop_first_height: bool = False,
    drop_last_height: bool = False,
) -> dict:
    """
    Liefert {length_m, gradient_abs_avg, gradient_smooth, gradient_endpoint,
    elevation_gain_m, elevation_loss_m, n_samples, is_implausible}.

    Gradient-Werte (alle drei) sind None, wenn:
      - der Way kürzer als min_length_m ist (Gate gegen Mikro-Ways),
      - oder das Höhenprofil komplett NoData ist,
      - oder die jeweilige Methodik degeneriert (z.B. zu wenige Samples für
        die Smooth-Window-Größe → gradient_smooth bleibt None).

    Gain/Loss werden immer auf dem Roh-Profil gerechnet, unabhängig vom Gate.
    """
    lons = np.array([c[0] for c in coords])
    lats = np.array([c[1] for c in coords])

    mx, my = to_metric.transform(lons, lats)
    mx_r, my_r, total_len = resample_line(np.asarray(mx), np.asarray(my), resample_m)

    result = {
        "length_m": total_len,
        "gradient_abs_avg": None,
        "gradient_smooth": None,
        "gradient_endpoint": None,
        "elevation_gain_m": None,
        "elevation_loss_m": None,
        "n_samples": 0,
        "is_implausible": 0,
        # LADOT-Bins (signed) — alle None bis nachgewiesen sinnvoll berechenbar.
        "ladot_bins": {f: None for f in _LADOT_FIELDS},
    }

    if total_len == 0:
        return result

    sx, sy = to_dem.transform(mx_r, my_r)
    heights = sample_heights(dem, np.asarray(sx), np.asarray(sy), method=sample_method)
    result["n_samples"] = len(heights)

    # Brücken-Anschluss-Kontamination: erste/letzte Höhe wegwerfen, wenn der
    # Endpunkt an einer Brücke/Tunnel/überdeckten Strecke hängt. savgol_smooth
    # interpoliert den fehlenden Wert anschließend linear aus den Nachbarn —
    # so verschwindet der künstliche Sprung Straßenhöhe ↔ Gelände drunter,
    # ohne dass ein Sample komplett verloren geht.
    if drop_first_height and heights.size >= 1:
        heights[0] = np.nan
    if drop_last_height and heights.size >= 1:
        heights[-1] = np.nan

    if np.all(np.isnan(heights)):
        return result

    seg_dx = np.diff(mx_r)
    seg_dy = np.diff(my_r)
    seg_len = np.hypot(seg_dx, seg_dy)
    seg_dh = np.diff(heights)

    # Gain/Loss immer auf dem Roh-Profil — bleibt vergleichbar zu früheren Runs.
    valid_dh = seg_dh[np.isfinite(seg_dh)]
    if valid_dh.size > 0:
        result["elevation_gain_m"] = float(np.sum(valid_dh[valid_dh > 0]))
        result["elevation_loss_m"] = float(-np.sum(valid_dh[valid_dh < 0]))

    # Length-Gate: bei Mikro-Ways wird jeder Sample-Wackler zu Megasteigung.
    # Alle drei Gradient-Spalten bleiben None.
    if total_len < min_length_m:
        return result

    # 1) Klassisches längengewichtetes |dh|/dl
    with np.errstate(invalid="ignore", divide="ignore"):
        seg_grad_abs = np.abs(seg_dh) / np.where(seg_len > 0, seg_len, np.nan)
    valid = np.isfinite(seg_grad_abs) & (seg_len > 0)
    if np.any(valid):
        result["gradient_abs_avg"] = float(
            np.average(seg_grad_abs[valid], weights=seg_len[valid])
        )

    # 2) Geglättet — gleiche Mittelungsmethode, aber auf savgol-Profil.
    # Auf demselben Profil rechnen wir auch die LADOT-Bins, damit der DEM-
    # Rauschboden nicht systematisch in die 2-4%-/4-6%-Bins läuft.
    smoothed = savgol_smooth(heights, window=smooth_window, polyorder=smooth_polyorder)
    if smoothed is not None:
        seg_dh_s = np.diff(smoothed)
        with np.errstate(invalid="ignore", divide="ignore"):
            seg_grad_abs_s = np.abs(seg_dh_s) / np.where(seg_len > 0, seg_len, np.nan)
            seg_signed_s = seg_dh_s / np.where(seg_len > 0, seg_len, np.nan)
        valid_s = np.isfinite(seg_grad_abs_s) & (seg_len > 0)
        if np.any(valid_s):
            result["gradient_smooth"] = float(
                np.average(seg_grad_abs_s[valid_s], weights=seg_len[valid_s])
            )

        # LADOT-Bins: längengewichteter Anteil des Ways pro Bin, signed.
        # fwd = positive Steigung (bergauf in Way-Richtung), bwd = negative.
        valid_signed = np.isfinite(seg_signed_s) & (seg_len > 0)
        valid_total_len = float(np.sum(seg_len[valid_signed]))
        if valid_total_len > 0:
            for name, lo, hi in LADOT_SLOPE_BINS:
                fwd_mask = valid_signed & (seg_signed_s >= lo) & (seg_signed_s < hi)
                bwd_mask = valid_signed & (-seg_signed_s >= lo) & (-seg_signed_s < hi)
                result["ladot_bins"][f"{name}_fwd_pct"] = float(
                    np.sum(seg_len[fwd_mask]) / valid_total_len * 100.0
                )
                result["ladot_bins"][f"{name}_bwd_pct"] = float(
                    np.sum(seg_len[bwd_mask]) / valid_total_len * 100.0
                )

    # 3) Endpunkt — nur erster und letzter gültiger Sample.
    finite_idx = np.where(np.isfinite(heights))[0]
    if finite_idx.size >= 2:
        h_first = heights[finite_idx[0]]
        h_last = heights[finite_idx[-1]]
        # Distanz zwischen erstem und letztem gültigen Sample entlang der
        # Wegstrecke (nicht Luftlinie, damit fairer Vergleich mit den anderen).
        cumlen = np.concatenate(([0.0], np.cumsum(seg_len)))
        endpoint_len = float(cumlen[finite_idx[-1]] - cumlen[finite_idx[0]])
        if endpoint_len > 0:
            result["gradient_endpoint"] = float(abs(h_last - h_first) / endpoint_len)

    # Implausibilitäts-Flag — auf der empfohlenen smooth-Metrik. Wert bleibt
    # erhalten, nur das Flag wird gesetzt; downstream kann dann selbst entscheiden,
    # ob diese Ways gefiltert oder gekappt werden sollen.
    if (
        result["gradient_smooth"] is not None
        and result["gradient_smooth"] * 100 > steep_flag_pct
    ):
        result["is_implausible"] = 1

    return result


def fmt(value: float | None, digits: int) -> str:
    if value is None:
        return ""
    return f"{value:.{digits}f}"


class StreamingHandler(osmium.SimpleHandler):
    """
    Verarbeitet jeden relevanten Way direkt und schreibt eine CSV-Zeile.
    Sammelt optional Datensätze für FlatGeobuf-Output, wenn collect_geo=True.
    """

    def __init__(
        self,
        dem: rasterio.io.DatasetReader,
        to_dem: Transformer,
        to_metric: Transformer,
        resample_m: float,
        writer,
        progress: tqdm,
        collect_geo: bool = False,
        min_length_m: float = DEFAULT_MIN_LENGTH_M,
        smooth_window: int = DEFAULT_SMOOTH_WINDOW,
        smooth_polyorder: int = DEFAULT_SMOOTH_POLYORDER,
        steep_flag_pct: float = DEFAULT_STEEP_FLAG_PCT,
        sample_method: str = DEFAULT_SAMPLE_METHOD,
        decoupled_endnodes: set[int] | None = None,
    ) -> None:
        super().__init__()
        self.dem = dem
        self.to_dem = to_dem
        self.to_metric = to_metric
        self.resample_m = resample_m
        self.writer = writer
        self.progress = progress
        self.count = 0
        self.skipped = 0
        self.collect_geo = collect_geo
        self.min_length_m = min_length_m
        self.smooth_window = smooth_window
        self.smooth_polyorder = smooth_polyorder
        self.steep_flag_pct = steep_flag_pct
        self.sample_method = sample_method
        self.decoupled_endnodes: set[int] = decoupled_endnodes or set()
        # Liste von Dicts; jeweils alle Felder inkl. coords (lon,lat-Tuples).
        self.records: list[dict] = []

    def way(self, w) -> None:
        highway = w.tags.get("highway")
        if highway not in HIGHWAY_WHITELIST:
            return

        try:
            valid_nodes = [
                (n.lon, n.lat, n.ref) for n in w.nodes if n.location.valid()
            ]
        except osmium.InvalidLocationError:
            self.skipped += 1
            return
        if len(valid_nodes) < 2:
            self.skipped += 1
            return

        coords = [(lon, lat) for lon, lat, _ in valid_nodes]
        first_node_id = valid_nodes[0][2]
        last_node_id = valid_nodes[-1][2]

        is_bridge_or_tunnel = is_dem_decoupled(w.tags)

        # Brücken-Anschluss-Erkennung: wenn der erste oder letzte Node des
        # Ways ein Endknoten eines anderen bridge/tunnel/covered Ways ist,
        # liegt dort die Straßenhöhe (Brückenkante), aber das DEM zeigt das
        # Gelände drunter — der entsprechende Sample-Wert würde eine
        # künstliche Höhenstufe ins Profil reißen. Wir invalidieren ihn,
        # savgol_smooth interpoliert ihn dann linear aus den Nachbarn.
        drop_first = (
            not is_bridge_or_tunnel and first_node_id in self.decoupled_endnodes
        )
        drop_last = (
            not is_bridge_or_tunnel and last_node_id in self.decoupled_endnodes
        )
        is_bridge_adjacent = drop_first or drop_last

        if is_bridge_or_tunnel:
            # Länge in Meter trotzdem berechnen, Höhenmetriken auf 0.
            lons = np.array([c[0] for c in coords])
            lats = np.array([c[1] for c in coords])
            mx, my = self.to_metric.transform(lons, lats)
            length_m = float(np.hypot(np.diff(mx), np.diff(my)).sum())
            grad_abs_avg = 0.0
            grad_smooth = 0.0
            grad_endpoint = 0.0
            elev_gain = 0.0
            elev_loss = 0.0
            n_samples = 0
            is_implausible = 0
            ladot_bins = {f: 0.0 for f in _LADOT_FIELDS}
        else:
            stats = compute_way_stats(
                coords,
                self.dem,
                self.to_dem,
                self.to_metric,
                self.resample_m,
                min_length_m=self.min_length_m,
                smooth_window=self.smooth_window,
                smooth_polyorder=self.smooth_polyorder,
                steep_flag_pct=self.steep_flag_pct,
                sample_method=self.sample_method,
                drop_first_height=drop_first,
                drop_last_height=drop_last,
            )
            length_m = stats["length_m"]
            grad_abs_avg = stats["gradient_abs_avg"]
            grad_smooth = stats["gradient_smooth"]
            grad_endpoint = stats["gradient_endpoint"]
            elev_gain = stats["elevation_gain_m"]
            elev_loss = stats["elevation_loss_m"]
            n_samples = stats["n_samples"]
            is_implausible = stats["is_implausible"]
            ladot_bins = stats["ladot_bins"]

        grad_abs_pct = grad_abs_avg * 100 if grad_abs_avg is not None else None
        grad_smooth_pct = grad_smooth * 100 if grad_smooth is not None else None
        grad_endpoint_pct = grad_endpoint * 100 if grad_endpoint is not None else None
        ladot_cells = [fmt(ladot_bins[f], 1) for f in _LADOT_FIELDS]

        # CSV-Zeile.
        if is_bridge_or_tunnel:
            self.writer.writerow(
                [
                    w.id,
                    f"{length_m:.2f}",
                    "0.0",
                    "0.0",
                    "0.0",
                    "0.0",
                    "0.0",
                    *(["0.0"] * len(_LADOT_FIELDS)),
                    0,
                    1,
                    0,
                    0,
                ]
            )
        else:
            self.writer.writerow(
                [
                    w.id,
                    fmt(length_m, 0),
                    fmt(grad_abs_pct, 1),
                    fmt(grad_smooth_pct, 1),
                    fmt(grad_endpoint_pct, 1),
                    fmt(elev_gain, 1),
                    fmt(elev_loss, 1),
                    *ladot_cells,
                    n_samples,
                    0,
                    int(is_bridge_adjacent),
                    is_implausible,
                ]
            )

        if self.collect_geo:
            # Alle Tags als Dict einsammeln; promoted Tags zusätzlich als
            # Top-Level-Felder beim Aufbau des GeoDataFrames extrahieren.
            tags = {k: v for k, v in w.tags}
            self.records.append(
                {
                    "osm_id": w.id,
                    "coords": coords,
                    "length_m": length_m,
                    "gradient_abs_avg_pct": grad_abs_pct,
                    "gradient_smooth_pct": grad_smooth_pct,
                    "gradient_endpoint_pct": grad_endpoint_pct,
                    "elevation_gain_m": elev_gain,
                    "elevation_loss_m": elev_loss,
                    "n_samples": n_samples,
                    "is_bridge_or_tunnel": is_bridge_or_tunnel,
                    "is_bridge_adjacent": is_bridge_adjacent,
                    "is_implausible_grad": is_implausible,
                    "ladot_bins": ladot_bins,
                    "tags": tags,
                }
            )

        self.count += 1
        self.progress.update(1)


class WayCounter(osmium.SimpleHandler):
    """
    Erster PBF-Pass: zählt relevante Highway-Ways und sammelt nebenher die
    End-Node-IDs aller bridge/tunnel/covered Ways. Diese Endknoten dienen
    im zweiten Pass dazu, Anschluss-Ways an Brücken/Tunnel/überdeckten
    Strecken zu erkennen, deren erstes bzw. letztes DEM-Sample sonst eine
    künstliche Höhenstufe (Straßenhöhe ↔ Gelände drunter) zeigen würde.
    """

    def __init__(self) -> None:
        super().__init__()
        self.count = 0
        self.decoupled_endnodes: set[int] = set()

    def way(self, w) -> None:
        if w.tags.get("highway") not in HIGHWAY_WHITELIST:
            return
        self.count += 1
        if is_dem_decoupled(w.tags):
            nodes = list(w.nodes)
            if nodes:
                self.decoupled_endnodes.add(nodes[0].ref)
                self.decoupled_endnodes.add(nodes[-1].ref)


def count_relevant_ways(pbf_path: Path) -> tuple[int, set[int]]:
    log.info("Zähle Highway-Ways in %s ...", pbf_path)
    counter = WayCounter()
    counter.apply_file(str(pbf_path), locations=False)
    log.info(
        "Gefundene Highway-Ways: %d (davon %d bridge/tunnel/covered-Endknoten)",
        counter.count, len(counter.decoupled_endnodes),
    )
    return counter.count, counter.decoupled_endnodes


def check_fgb_deps() -> None:
    """
    Prüft Abhängigkeiten für FlatGeobuf-Output.
    FGB braucht geopandas + shapely + (pyogrio oder fiona) für den Write-Driver.
    """
    missing = []
    try:
        import geopandas  # noqa: F401
    except ImportError:
        missing.append("geopandas")
    try:
        import shapely  # noqa: F401
    except ImportError:
        missing.append("shapely")
    # Mindestens einer von pyogrio/fiona muss da sein.
    has_io = False
    try:
        import pyogrio  # noqa: F401
        has_io = True
    except ImportError:
        pass
    if not has_io:
        try:
            import fiona  # noqa: F401
            has_io = True
        except ImportError:
            pass
    if not has_io:
        missing.append("pyogrio (oder fiona)")

    if missing:
        raise SystemExit(
            "Für --out-fgb fehlen Abhängigkeiten: "
            + ", ".join(missing)
            + "\nInstalliere mit: pip install "
            + " ".join(m for m in missing if "oder" not in m)
            + (" pyogrio" if any("pyogrio" in m for m in missing) else "")
        )


def build_geodataframe(records: list[dict], simplify_m: float = 0.0):
    """
    Baut aus den gesammelten Records ein GeoDataFrame in EPSG:4326.
    Sortiert die Zeilen räumlich (Hilbert-Curve), was beim Spatial-Index-Aufbau
    in QGIS/GDAL hilft. Die tags-Dict-Spalte wird zu einem JSON-String
    serialisiert, damit GDAL nicht über Map/Struct-Spalten stolpert.

    Wenn simplify_m > 0, werden LineStrings mit Douglas-Peucker vereinfacht
    (Toleranz in Metern). Das macht die Geometrien kompakter und das Rendering
    in QGIS spürbar schneller.
    """
    import json

    import geopandas as gpd
    from shapely.geometry import LineString

    log.info("Baue GeoDataFrame aus %d Records ...", len(records))

    rows = []
    geoms = []
    for rec in records:
        tags = rec["tags"]
        row = {
            "osm_id": rec["osm_id"],
            "length_m": rec["length_m"],
            "gradient_abs_avg_pct": rec["gradient_abs_avg_pct"],
            "gradient_smooth_pct": rec["gradient_smooth_pct"],
            "gradient_endpoint_pct": rec["gradient_endpoint_pct"],
            "elevation_gain_m": rec["elevation_gain_m"],
            "elevation_loss_m": rec["elevation_loss_m"],
            "n_samples": rec["n_samples"],
            "is_bridge_or_tunnel": rec["is_bridge_or_tunnel"],
            "is_bridge_adjacent": rec["is_bridge_adjacent"],
            "is_implausible_grad": rec["is_implausible_grad"],
        }
        for f in _LADOT_FIELDS:
            row[f] = rec["ladot_bins"][f]
        # Promoted Tags als eigene Spalten; Rest als JSON-String, damit
        # das Schema flach bleibt und QGIS/GDAL es problemlos lesen.
        remaining_tags = dict(tags)
        for key in PROMOTED_TAGS:
            row[key] = remaining_tags.pop(key, None)
        row["tags_json"] = json.dumps(remaining_tags, ensure_ascii=False) if remaining_tags else None
        rows.append(row)
        geoms.append(LineString(rec["coords"]))

    gdf = gpd.GeoDataFrame(rows, geometry=geoms, crs="EPSG:4326")

    # Numerische Spalten auf 1 Nachkommastelle runden — die im DEM enthaltene
    # Genauigkeit ist ohnehin auf Dezimeter-Niveau, mehr Stellen täuschen nur
    # Präzision vor. NaN bleibt NaN. osm_id, n_samples und Flags sind
    # Integers und werden nicht angefasst.
    round_cols = [
        "length_m",
        "gradient_abs_avg_pct",
        "gradient_smooth_pct",
        "gradient_endpoint_pct",
        "elevation_gain_m",
        "elevation_loss_m",
        *_LADOT_FIELDS,
    ]
    for col in round_cols:
        if col in gdf.columns:
            gdf[col] = gdf[col].round(1)

    if simplify_m > 0:
        # Simplify in metrischem CRS für sinnvolle Toleranz-Interpretation,
        # dann zurück nach WGS84.
        log.info("Vereinfache Geometrien (Douglas-Peucker, %g m) ...", simplify_m)
        n_before = sum(len(g.coords) for g in gdf.geometry)
        gdf_m = gdf.to_crs("EPSG:3857")
        gdf_m["geometry"] = gdf_m.geometry.simplify(simplify_m, preserve_topology=False)
        gdf = gdf_m.to_crs("EPSG:4326")
        n_after = sum(len(g.coords) for g in gdf.geometry)
        log.info(
            "Stützpunkte: %d → %d (%.1f%% reduziert).",
            n_before, n_after, 100 * (1 - n_after / max(n_before, 1)),
        )

    # Räumliche Sortierung via Hilbert-Distance — sorgt dafür, dass
    # benachbarte Zeilen auch räumlich nahe sind. Macht den Spatial-Index-
    # Aufbau in QGIS schneller und Pan/Zoom-Rendering effizienter.
    try:
        log.info("Sortiere Geometrien räumlich (Hilbert) ...")
        hilbert = gdf.geometry.hilbert_distance()
        gdf = gdf.iloc[hilbert.argsort()].reset_index(drop=True)
    except AttributeError:
        log.info("hilbert_distance nicht verfügbar, sortiere nach Centroid-Y.")
        gdf = gdf.iloc[gdf.geometry.centroid.y.argsort()].reset_index(drop=True)

    return gdf


def write_flatgeobuf(records: list[dict], out_path: Path, simplify_m: float = 0.0) -> None:
    """
    Schreibt ein FlatGeobuf. Tippecanoe kann FGB direkt einlesen — der
    geojsonl-Zwischenschritt entfällt damit komplett in der Tile-Pipeline.
    QGIS liest FGB ebenfalls; ein Spatial-Index wird beim ersten Öffnen
    automatisch aufgebaut.
    """
    gdf = build_geodataframe(records, simplify_m=simplify_m)
    log.info("Schreibe FlatGeobuf nach %s ...", out_path)
    gdf.to_file(out_path, driver="FlatGeobuf")
    log.info("FlatGeobuf geschrieben: %s (%d Zeilen)", out_path, len(gdf))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pbf", required=True, type=Path, help="OSM-PBF-Datei")
    parser.add_argument("--dem", required=True, type=Path, help="GeoTIFF mit Höhen")
    parser.add_argument("--out", required=True, type=Path, help="Ziel-CSV")
    parser.add_argument(
        "--out-fgb",
        type=Path,
        default=None,
        help=(
            "Optional: Ziel-Pfad für FlatGeobuf mit Geometrie, OSM-Tags und "
            "Höhenmetriken (EPSG:4326). Direkt von Tippecanoe lesbar; "
            "auch in QGIS verwendbar."
        ),
    )
    parser.add_argument(
        "--resample-m",
        type=float,
        default=25.0,
        help="Maximaler Abstand zwischen Stützpunkten in Metern (Default: 25)",
    )
    parser.add_argument(
        "--simplify-m",
        type=float,
        default=0.0,
        help=(
            "Optional: Douglas-Peucker-Toleranz in Metern für die Geometrien "
            "im Geo-Output. Reduziert Stützpunkte und macht WKB kompakter, was "
            "spaltenweises Lesen in QGIS spürbar beschleunigt. Sinnvolle Werte: "
            "2-10 m für Straßennetz-Visualisierung. Default 0 = keine Vereinfachung."
        ),
    )
    parser.add_argument(
        "--target-crs",
        default="EPSG:25832",
        help="Metrisches CRS für Längenberechnung (Default: EPSG:25832 / UTM32N)",
    )
    parser.add_argument(
        "--min-length-m",
        type=float,
        default=DEFAULT_MIN_LENGTH_M,
        help=(
            "Mindestlänge in m für Gradient-Berechnung. Bei kürzeren Ways werden "
            "alle drei Gradient-Spalten leer ausgegeben (Default: 15)."
        ),
    )
    parser.add_argument(
        "--smooth-window",
        type=int,
        default=DEFAULT_SMOOTH_WINDOW,
        help=(
            "Fenstergröße in Samples für Savitzky-Golay-Glättung in "
            "gradient_smooth_pct. Muss ungerade und ≥3 sein (Default: 5). "
            "Bei resample-m=25 deckt window=5 ~125m ab."
        ),
    )
    parser.add_argument(
        "--smooth-polyorder",
        type=int,
        default=DEFAULT_SMOOTH_POLYORDER,
        help="Polynom-Grad für Savitzky-Golay (< smooth-window, Default: 2).",
    )
    parser.add_argument(
        "--steep-flag-threshold",
        type=float,
        default=DEFAULT_STEEP_FLAG_PCT,
        help=(
            "Über diesem gradient_smooth_pct wird is_implausible_grad=1 gesetzt. "
            "Der Wert wird NICHT gekappt, nur markiert (Default: 30)."
        ),
    )
    parser.add_argument(
        "--sample-method",
        choices=("bilinear", "nearest"),
        default=DEFAULT_SAMPLE_METHOD,
        help=(
            "Höhen-Sampling: 'bilinear' (Default) interpoliert aus 4 Nachbar-"
            "pixeln und reduziert den DEM-Rausch-Anteil pro Sample-Paar "
            "typisch um Faktor 2-3. 'nearest' entspricht dem ursprünglichen "
            "rasterio.sample()-Verhalten (nearest-neighbor)."
        ),
    )
    args = parser.parse_args()

    if args.smooth_window < 3 or args.smooth_window % 2 == 0:
        raise SystemExit("--smooth-window muss eine ungerade Zahl >= 3 sein.")
    if args.smooth_polyorder >= args.smooth_window:
        raise SystemExit("--smooth-polyorder muss kleiner als --smooth-window sein.")

    args.pbf = resolve_input_path(args.pbf)
    args.dem = resolve_input_path(args.dem)
    args.out = resolve_output_path(args.out)
    if args.out_fgb is not None:
        args.out_fgb = resolve_output_path(args.out_fgb)

    if not args.pbf.exists():
        raise SystemExit(f"PBF nicht gefunden: {args.pbf}")
    if not args.dem.exists():
        raise SystemExit(f"DEM nicht gefunden: {args.dem}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    if args.out_fgb is not None:
        args.out_fgb.parent.mkdir(parents=True, exist_ok=True)

    if args.out_fgb is not None:
        check_fgb_deps()

    print_welcome_banner()
    log.info("Öffne DEM %s ...", args.dem)
    with rasterio.open(args.dem) as dem:
        dem_crs = dem.crs.to_string() if dem.crs else "EPSG:4326"
        log.info("DEM-CRS: %s, NoData: %s", dem_crs, dem.nodata)

        to_metric = Transformer.from_crs("EPSG:4326", args.target_crs, always_xy=True)
        to_dem = Transformer.from_crs(args.target_crs, dem_crs, always_xy=True)

        collect_records = args.out_fgb is not None
        if collect_records:
            log.info(
                "FlatGeobuf-Output aktiviert (%s). Datensätze werden im "
                "Speicher gehalten.",
                args.out_fgb,
            )

        total_ways, decoupled_endnodes = count_relevant_ways(args.pbf)

        log.info("Streame Ways aus %s ...", args.pbf)
        with args.out.open("w", newline="", encoding="utf-8") as fh:
            writer = csv.writer(fh)
            writer.writerow(CSV_HEADER)

            with tqdm(total=total_ways, desc="Ways", unit=" ways") as progress:
                handler = StreamingHandler(
                    dem=dem,
                    to_dem=to_dem,
                    to_metric=to_metric,
                    resample_m=args.resample_m,
                    writer=writer,
                    progress=progress,
                    collect_geo=collect_records,
                    min_length_m=args.min_length_m,
                    smooth_window=args.smooth_window,
                    smooth_polyorder=args.smooth_polyorder,
                    steep_flag_pct=args.steep_flag_threshold,
                    sample_method=args.sample_method,
                    decoupled_endnodes=decoupled_endnodes,
                )
                handler.apply_file(str(args.pbf), locations=True)

        log.info(
            "Fertig. %d Ways verarbeitet, %d übersprungen. Ergebnis: %s",
            handler.count,
            handler.skipped,
            args.out,
        )

        if args.out_fgb is not None:
            write_flatgeobuf(handler.records, args.out_fgb, simplify_m=args.simplify_m)


if __name__ == "__main__":
    main()
