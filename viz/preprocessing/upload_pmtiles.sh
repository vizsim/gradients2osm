#!/usr/bin/env bash
# Upload viz/data/*.mlt.pmtiles to the configured Backblaze B2 bucket.
#
# Uses `b2 sync` with regex filters so only .mlt.pmtiles files are pushed
# (the *.pmtiles MVT-baseline files stay local). b2 sync skips files whose
# name + mtime match between local and remote → re-runs are cheap.
#
# Setup (einmalig):
#   1) b2 CLI installieren:
#        uv tool install b2          # passend zum uv-setup des Projekts
#        # alternativ: pipx install b2  /  pip install --user 'b2[full]'
#   2) .env aus .env.example anlegen und die drei Werte eintragen:
#        cp .env.example .env
#   3) ./viz/preprocessing/upload_pmtiles.sh [--dry-run]
#
# Flags:
#   --dry-run   zeigt nur, was gesynct würde, lädt aber nichts hoch.

set -euo pipefail

DRY_RUN=()
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=(--dry-run)
  echo ">> DRY RUN — nothing will be uploaded"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DATA_DIR="$REPO_ROOT/viz/data"

# Load .env from repo root if present (set -a auto-exports each assignment)
if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
else
  echo "missing $REPO_ROOT/.env — copy .env.example and fill in your B2 credentials" >&2
  exit 1
fi

for v in B2_APPLICATION_KEY_ID B2_APPLICATION_KEY B2_BUCKET_NAME; do
  if [[ -z "${!v:-}" ]]; then
    echo "missing env var: $v (set in $REPO_ROOT/.env)" >&2
    exit 1
  fi
done

if ! command -v b2 >/dev/null 2>&1; then
  cat >&2 <<'EOF'
b2 CLI not found. Install with one of:
  uv tool install b2
  pipx install b2
  pip install --user 'b2[full]'
EOF
  exit 1
fi

# Sanity check: data dir contains at least one .mlt.pmtiles
shopt -s nullglob
files=("$DATA_DIR"/*.mlt.pmtiles)
shopt -u nullglob
if [[ ${#files[@]} -eq 0 ]]; then
  echo "no *.mlt.pmtiles files in $DATA_DIR — run build_pmtiles_mlt.sh first" >&2
  exit 1
fi

echo ">> files to consider for upload:"
for f in "${files[@]}"; do
  printf "   %s  (%s)\n" "$(basename "$f")" "$(ls -lh "$f" | awk '{print $5}')"
done

# Authorize once. Idempotent — b2 caches credentials in ~/.config/b2/.
echo ">> b2 account authorize"
b2 account authorize "$B2_APPLICATION_KEY_ID" "$B2_APPLICATION_KEY" >/dev/null

# Sync only the MLT files. --exclude-regex '.*' kills everything, then
# --include-regex re-adds the MLT pmtiles. b2 sync's default change
# detection is name + mtime, so unchanged files are skipped on re-runs.
echo ">> b2 sync $DATA_DIR -> b2://$B2_BUCKET_NAME/"
b2 sync \
  --no-progress \
  --exclude-regex '.*' \
  --include-regex '.*\.mlt\.pmtiles$' \
  "${DRY_RUN[@]}" \
  "$DATA_DIR" \
  "b2://$B2_BUCKET_NAME"

echo ">> done"
