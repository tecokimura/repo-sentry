#!/usr/bin/env bash
set -euo pipefail

IMAGE="${REPO_SENTRY_EXPORT_IMAGE:-repo-sentry-export:local}"
_no_cache_arg=()
for _arg in "$@"; do
  [[ "$_arg" == "--no-cache" ]] && _no_cache_arg=(--no-cache)
done

docker build \
  ${_no_cache_arg[@]+"${_no_cache_arg[@]}"} \
  -f Dockerfile.export \
  -t "$IMAGE" \
  .
