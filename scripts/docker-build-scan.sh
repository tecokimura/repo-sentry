#!/usr/bin/env bash
set -euo pipefail

IMAGE="${REPO_SENTRY_IMAGE:-repo-sentry:local}"
_no_cache_arg=()
[[ "${NO_CACHE:-}" == "true" ]] && _no_cache_arg=(--no-cache)

docker build \
  "${_no_cache_arg[@]}" \
  --build-arg DENO_VERSION="${DENO_VERSION:-2.5.6}" \
  --build-arg GITLEAKS_VERSION="${GITLEAKS_VERSION:-8.30.1}" \
  --build-arg TRIVY_VERSION="${TRIVY_VERSION:-0.70.0}" \
  -t "$IMAGE" \
  .
