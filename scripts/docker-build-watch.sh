#!/usr/bin/env bash
set -euo pipefail
docker build -f Dockerfile.watch -t repo-sentry-watch:local .
