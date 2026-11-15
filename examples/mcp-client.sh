#!/usr/bin/env bash
# Set DSH_BRIDGE_SECRET or DSH_BRIDGE_SECRET_FILE securely before use.
# No SSH, real hostname, or credential value is embedded here.
set +x
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PARAMS='{}'
if [[ $# -ge 2 ]]; then PARAMS="$2"; fi
exec "$ROOT/scripts/dshmcp.sh" "${1:-tools/list}" "$PARAMS"
