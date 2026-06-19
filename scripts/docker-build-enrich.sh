#!/usr/bin/env bash
set -euo pipefail

IMAGE="${REPO_SENTRY_ENRICH_IMAGE:-repo-sentry-enrich:local}"

docker build \
  --build-arg DENO_VERSION="${DENO_VERSION:-2.5.6}" \
  -f Dockerfile.enrich \
  -t "$IMAGE" \
  .
