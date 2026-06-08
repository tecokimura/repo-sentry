#!/usr/bin/env bash
set -euo pipefail

IMAGE="${REPO_SENTRY_IMAGE:-repo-sentry:local}"
TARGET_PATH="${TARGET_PATH:-$PWD}"
REPORTS_DIR="${REPORTS_DIR:-$PWD/reports}"
CACHE_DIR="${CACHE_DIR:-$PWD/.repo-sentry}"
TOOLS="${TOOLS:-gitleaks,trivy}"
FORMAT="${FORMAT:-markdown}"
REPORT_DATE="${REPORT_DATE:-$(date +%F)}"
REPORT_NAME="${REPORT_NAME:-repo-sentry-docker-scan}"
DOCKER_USER="${DOCKER_USER:-$(id -u):$(id -g)}"

case "$FORMAT" in
  json) extension="json" ;;
  markdown) extension="md" ;;
  *) echo "Unsupported FORMAT: $FORMAT" >&2; exit 2 ;;
esac

repo_args=()
if [[ -n "${REPO:-}" ]]; then
  repo_args=(--repo "$REPO")
fi

mkdir -p "$REPORTS_DIR" "$CACHE_DIR"

docker run --rm \
  --user "$DOCKER_USER" \
  -e DENO_DIR=/workspace/.repo-sentry/deno-cache \
  -e GITHUB_TOKEN \
  -e SLACK_WEBHOOK_URL \
  -e OPENAI_API_KEY \
  -v "$TARGET_PATH:/workspace/target:ro" \
  -v "$REPORTS_DIR:/workspace/reports" \
  -v "$CACHE_DIR:/workspace/.repo-sentry" \
  "$IMAGE" \
  run \
  --path /workspace/target \
  "${repo_args[@]}" \
  --tools "$TOOLS" \
  --format "$FORMAT" \
  --output "/workspace/reports/${REPORT_DATE}_${REPORT_NAME}.${extension}" \
  "$@"
