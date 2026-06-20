#!/usr/bin/env bash
set -euo pipefail

IMAGE="${REPO_SENTRY_REPORT_IMAGE:-repo-sentry-report:local}"

docker build \
  --build-arg DENO_VERSION="${DENO_VERSION:-2.5.6}" \
  -f Dockerfile.report \
  -t "$IMAGE" \
  .
