#!/usr/bin/env bash
set -euo pipefail

IMAGE="${REPO_SENTRY_ENRICH_IMAGE:-repo-sentry-enrich:local}"
_no_cache_arg=()
for _arg in "$@"; do
  [[ "$_arg" == "--no-cache" ]] && _no_cache_arg=(--no-cache)
done

docker build \
  ${_no_cache_arg[@]+"${_no_cache_arg[@]}"} \
  --build-arg DENO_VERSION="${DENO_VERSION:-2.5.6}" \
  -f Dockerfile.enrich \
  -t "$IMAGE" \
  .
