#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"

"$SCRIPT_DIR/docker-build-scan.sh"
"$SCRIPT_DIR/docker-build-enrich.sh"
"$SCRIPT_DIR/docker-build-report.sh"
