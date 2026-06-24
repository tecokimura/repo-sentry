#!/usr/bin/env bash
set -euo pipefail
docker build -f Dockerfile.export -t repo-sentry-export:local .
