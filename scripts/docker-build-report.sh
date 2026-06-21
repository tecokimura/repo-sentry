#!/usr/bin/env bash
set -euo pipefail

IMAGE="${REPO_SENTRY_REPORT_IMAGE:-repo-sentry-report:local}"
_no_cache_arg=()
[[ "${NO_CACHE:-}" == "true" ]] && _no_cache_arg=(--no-cache)

docker build \
  "${_no_cache_arg[@]}" \
  --build-arg DENO_VERSION="${DENO_VERSION:-2.5.6}" \
  -f Dockerfile.report \
  -t "$IMAGE" \
  .
