#!/usr/bin/env bash
set -euo pipefail

IMAGE="${REPO_SENTRY_IMAGE:-repo-sentry:local}"
_no_cache_arg=()
for _arg in "$@"; do
  [[ "$_arg" == "--no-cache" ]] && _no_cache_arg=(--no-cache)
done

docker build \
  ${_no_cache_arg[@]+"${_no_cache_arg[@]}"} \
  --build-arg DENO_VERSION="${DENO_VERSION:-2.5.6}" \
  --build-arg GITLEAKS_VERSION="${GITLEAKS_VERSION:-8.30.1}" \
  --build-arg TRIVY_VERSION="${TRIVY_VERSION:-0.70.0}" \
  -t "$IMAGE" \
  .
