#!/usr/bin/env bash
# Build a PMTiles archive from a gradients FlatGeobuf so the viz can serve
# vector tiles directly from disk (or any static host) without a tile server.
#
# Usage:
#   ./build_pmtiles.sh ../../output/berlin_gradients_20_neu3.fgb
#   ./build_pmtiles.sh ../../output/berlin_gradients_20_neu3.fgb berlin
#
# Requires: tippecanoe on PATH (>= 2.x with FlatGeobuf input support).

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <input.fgb> [name]" >&2
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

BASENAME="${2:-$(basename "$INPUT" .fgb)}"
PMTILES="$DATA_DIR/$BASENAME.pmtiles"

echo ">> tippecanoe -> $PMTILES"
# Density per zoom is steered solely by the highway-class filter in -j.
# -x tags_json drops the large free-form-tag blob; the viz only uses the
# structured columns for hover stats. (-X with capital X would exclude
# ALL attributes — easy to confuse, hence the comment.)
# --coalesce-densest-as-needed is intentionally NOT used: it would merge
# multiple ways into one MultiLineString and break per-way hover identity.
#
# Zoom plan:
#   z6-7   : motorway, trunk, primary  (Autobahnen, Schnellstraßen, Hauptstraßen)
#   z8-10  : + secondary, tertiary
#   z11-12 : + residential, unclassified, living_street, pedestrian, cycleway
#   z13    : alles außer den ausgeschlossenen highway-Klassen (max-zoom,
#            wird im Viewer überzoomt; ersetzt das frühere max=14 +
#            base=13 für deutlich kompaktere Tiles bei minimal weniger
#            Detail in der höchsten Zoomstufe).
tippecanoe \
  -o "$PMTILES" \
  --force \
  --layer=ways \
  --minimum-zoom=6 \
  --maximum-zoom=13 \
  --base-zoom=12 \
  --no-tile-size-limit \
  --no-feature-limit \
  --read-parallel \
  -x tags_json \
  -j '{"ways":["all",["!in","highway","service","footway","path","steps","bridleway","corridor","construction","proposed"],["any",[">=","$zoom",13],["all",[">=","$zoom",11],["in","highway","motorway","trunk","primary","secondary","tertiary","residential","unclassified","living_street","pedestrian","cycleway"]],["all",[">=","$zoom",8],["in","highway","motorway","trunk","primary","secondary","tertiary"]],["in","highway","motorway","trunk","primary"]]]}' \
  "$INPUT"

echo ">> done: $PMTILES"
ls -lh "$PMTILES"
