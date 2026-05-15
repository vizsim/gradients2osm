#!/usr/bin/env bash
# Convert an existing MVT-based PMTiles archive (built via build_pmtiles.sh)
# into the experimental MapLibre Tiles (MLT) format, repackaged as PMTiles.
# Lets us compare MVT vs MLT side-by-side on identical tile content.
#
# Usage:
#   ./build_pmtiles_mlt.sh ../data/saarland_v02.pmtiles
#   ./build_pmtiles_mlt.sh ../data/saarland_v02.pmtiles saarland
#
# Output:
#   ../data/<basename>.mlt.pmtiles
#
# Requires:
#   - java (>= 17)  -- on Debian/Ubuntu: `sudo apt install default-jre`
#   - pmtiles CLI   -- https://github.com/protomaps/go-pmtiles
#   - python3       -- for metadata sanitization
#
# The mlt-encode.jar is auto-downloaded on first run to ./vendor/.
#
# Known interop quirks with tippecanoe-produced PMTiles (java-v0.0.10):
#
#   1) tippecanoe writes `tippecanoe_decisions` (object) and `tilestats` (object)
#      into the JSON metadata. planetiler's PMTiles JsonMetadata model stuffs
#      unknown fields into Map<String,String> and Jackson rejects non-string
#      values. We strip those fields before encoding.
#
#   2) tippecanoe emits `"Mixed"` as a vector_layers field type for ambiguous
#      columns (osm_id, n_samples, ...). planetiler's FieldType enum only knows
#      Number|String|Boolean -- we coerce "Mixed" to "String".
#
#   3) MLT requires homogeneous column types per layer, but tippecanoe writes
#      `length_m=42` as int and `length_m=42.5` as float in the same column.
#      The encoder partially handles this with --coerce-mismatch, but its
#      Float-to-Double cast path has a bug that silently drops affected tiles
#      when --continue is set (a small percentage; verify with `pmtiles show`).
#      Proper fix is upstream in build_pmtiles.sh via tippecanoe `-T <attr>:float`
#      to make numeric columns uniformly float before MVT encoding.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <input.pmtiles> [name]" >&2
  exit 1
fi

INPUT="$1"
if [[ ! -f "$INPUT" ]]; then
  echo "input not found: $INPUT" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/data"
VENDOR_DIR="$SCRIPT_DIR/vendor"
JAR="$VENDOR_DIR/mlt-encode.jar"
JAR_URL="https://github.com/maplibre/maplibre-tile-spec/releases/download/java-v0.0.10/mlt-encode.jar"

mkdir -p "$DATA_DIR" "$VENDOR_DIR"

for cmd in java pmtiles python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "missing required tool: $cmd" >&2
    exit 1
  fi
done

if [[ ! -f "$JAR" ]]; then
  echo ">> downloading mlt-encode.jar -> $JAR"
  curl -fSL --progress-bar -o "$JAR" "$JAR_URL"
fi

BASENAME="${2:-$(basename "$INPUT" .pmtiles)}"
OUT="$DATA_DIR/$BASENAME.mlt.pmtiles"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
SANITIZED="$TMPDIR/input.pmtiles"
META_JSON="$TMPDIR/metadata.json"

echo ">> sanitize metadata (strip object-valued fields, coerce Mixed -> String)"
cp "$INPUT" "$SANITIZED"
pmtiles show --metadata "$SANITIZED" | python3 -c "
import json, sys
m = json.load(sys.stdin)
KNOWN_TYPED = {'name','description','attribution','version','type','format','vector_layers'}
out = {k: v for k, v in m.items() if k in KNOWN_TYPED or isinstance(v, str)}
ALLOWED = {'Number', 'String', 'Boolean'}
for vl in out.get('vector_layers', []):
    fields = vl.get('fields', {})
    for k, v in list(fields.items()):
        if v not in ALLOWED:
            fields[k] = 'String'
json.dump(out, sys.stdout)
" > "$META_JSON"
pmtiles edit --quiet --metadata="$META_JSON" "$SANITIZED"

echo ">> mlt-encode: $INPUT -> $OUT"
# --compress gzip      : PMTiles inner compression
# --enable-fsst        : FSST string-column compression (good fit for OSM tags)
# --coerce-mismatch    : auto-coerce int/float mixed numeric columns
# --elide-mismatch     : drop values whose type can't be coerced
# --continue           : keep going on per-tile errors (see quirk #3 above)
# --parallel           : use all CPU cores
java -jar "$JAR" \
  --pmtiles "$SANITIZED" \
  --mlt "$OUT" \
  --compress gzip \
  --enable-fsst \
  --coerce-mismatch \
  --elide-mismatch \
  --continue \
  --parallel \
  --verbose info

IN_TILES=$(pmtiles show "$INPUT" 2>&1 | awk '/addressed tiles count:/ {print $4}')
OUT_TILES=$(pmtiles show "$OUT"   2>&1 | awk '/addressed tiles count:/ {print $4}')
echo ">> done"
echo "MVT input : $(ls -lh "$INPUT" | awk '{print $5}')  tiles=$IN_TILES"
echo "MLT output: $(ls -lh "$OUT"   | awk '{print $5}')  tiles=$OUT_TILES"
if [[ "$IN_TILES" != "$OUT_TILES" ]]; then
  LOST=$((IN_TILES - OUT_TILES))
  echo "WARNING: $LOST tile(s) lost during MLT encoding (encoder Float/Double bug)." >&2
  echo "         Fix: rebuild MVT with tippecanoe '-T <attr>:float' for numeric cols." >&2
fi
