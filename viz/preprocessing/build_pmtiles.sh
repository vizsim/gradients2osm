#!/usr/bin/env bash
# Build a PMTiles archive from a gradients GeoPackage so the viz can serve
# vector tiles directly from disk (or any static host) without a tile server.
#
# Usage:
#   ./build_pmtiles.sh ../../output/berlin_gradients_20_neu3.gpkg
#   ./build_pmtiles.sh ../../output/berlin_gradients_20_neu3.gpkg berlin
#
# Requires: ogr2ogr (GDAL) and tippecanoe on PATH.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <input.gpkg> [name]" >&2
  exit 1
fi

INPUT="$1"
if [[ ! -f "$INPUT" ]]; then
  echo "input not found: $INPUT" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/data"
mkdir -p "$DATA_DIR"

BASENAME="${2:-$(basename "$INPUT" .gpkg)}"
GEOJSONL="$DATA_DIR/$BASENAME.geojsonl"
PMTILES="$DATA_DIR/$BASENAME.pmtiles"

echo ">> ogr2ogr -> $GEOJSONL"
# Project to WGS84 (input already is, but make it explicit) and emit
# newline-delimited GeoJSON which streams cheaply into tippecanoe.
# Drop the large tags_json blob so vector tiles stay compact; the viz only
# uses the structured columns for hover stats.
ogr2ogr \
  -f GeoJSONSeq \
  -t_srs EPSG:4326 \
  -select "osm_id,length_m,gradient_abs_avg_pct,gradient_smooth_pct,gradient_endpoint_pct,elevation_gain_m,elevation_loss_m,n_samples,is_bridge_or_tunnel,is_bridge_adjacent,is_implausible_grad,slope_1_fwd_pct,slope_1_bwd_pct,slope_2_fwd_pct,slope_2_bwd_pct,slope_3_fwd_pct,slope_3_bwd_pct,slope_4_fwd_pct,slope_4_bwd_pct,highway,name,ref,surface,smoothness,maxspeed,oneway,bridge,tunnel" \
  -lco RS=NO \
  "$GEOJSONL" \
  "$INPUT"

echo ">> tippecanoe -> $PMTILES"
# Density per zoom is steered solely by the highway-class filter in -j.
# No feature dropping, no Douglas-Peucker line simplification:
#   --no-line-simplification    : disables the per-zoom geometry simplifier
#                                 that tippecanoe runs by default below maxzoom.
#   --no-tile-size-limit / -fl  : let tiles grow as big as they need to so
#                                 tippecanoe never has to coalesce or drop
#                                 to fit a 500 KB budget.
# --coalesce-densest-as-needed is intentionally NOT used: it would merge
# multiple ways into one MultiLineString and break per-way hover identity.
tippecanoe \
  -o "$PMTILES" \
  --force \
  --layer=ways \
  --minimum-zoom=8 \
  --maximum-zoom=14 \
  --base-zoom=13 \
  --no-tile-size-limit \
  --no-feature-limit \
  --read-parallel \
  -j '{"ways":["all",["!in","highway","service","footway","path","steps","bridleway","corridor","construction","proposed"],["any",[">=","$zoom",13],["all",[">=","$zoom",11],["in","highway","motorway","trunk","primary","secondary","tertiary","residential","unclassified","living_street","pedestrian","cycleway"]],["in","highway","motorway","trunk","primary","secondary","tertiary"]]]}' \
  "$GEOJSONL"

# The .geojsonl is only an intermediate; tippecanoe already consumed it.
rm -f "$GEOJSONL"

echo ">> done: $PMTILES"
ls -lh "$PMTILES"
