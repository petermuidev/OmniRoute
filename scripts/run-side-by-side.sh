#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-dev}"
ENV_FILE="$ROOT/side-by-side.env"

if [[ "$MODE" != "dev" && "$MODE" != "start" ]]; then
  echo "Usage: $0 [dev|start]" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing side-by-side config: $ENV_FILE" >&2
  exit 1
fi

set -a
. "$ENV_FILE"
set +a

exec node "$ROOT/scripts/run-next.mjs" "$MODE"
