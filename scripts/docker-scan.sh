#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: docker-scan.sh [TARGET_DIR] [-- CLI passthrough options]

Runs repo-sentry in Docker against TARGET_DIR (default: TARGET_PATH or $PWD).
Other --* arguments are passed through to the repo-sentry CLI.
Behavior is configured via environment variables; see README.md
(REPO_SENTRY_IMAGE, TARGET_PATH, REPORTS_DIR, CACHE_DIR, TOOLS, FORMAT,
REPORT_DATE, REPORT_NAME, REPO, SBOM, DOCKER_USER).
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

IMAGE="${REPO_SENTRY_IMAGE:-repo-sentry:local}"
TARGET_PATH="${TARGET_PATH:-$PWD}"
REPORTS_DIR="${REPORTS_DIR:-$PWD/reports}"
CACHE_DIR="${CACHE_DIR:-$PWD/.repo-sentry}"
TOOLS="${TOOLS:-gitleaks,trivy}"
FORMAT="${FORMAT:-markdown}"
REPORT_DATE="${REPORT_DATE:-$(date +%F)}"
REPORT_NAME="${REPORT_NAME:-repo-sentry-docker-scan}"
DOCKER_USER="${DOCKER_USER:-$(id -u):$(id -g)}"

if [[ $# -gt 0 && "$1" != --* ]]; then
  TARGET_PATH="$1"
  shift
fi

if [[ ! -d "$TARGET_PATH" ]]; then
  echo "scan target must be an existing directory: $TARGET_PATH" >&2
  usage >&2
  exit 2
fi

case "$FORMAT" in
  json) extension="json" ;;
  markdown) extension="md" ;;
  *) echo "Unsupported FORMAT: $FORMAT" >&2; exit 2 ;;
esac

repo_args=()
if [[ -n "${REPO:-}" ]]; then
  repo_args=(--repo "$REPO")
fi

sbom_args=()
if [[ -n "${SBOM:-}" ]]; then
  sbom_args=(--sbom)
fi

mkdir -p "$REPORTS_DIR" "$CACHE_DIR"

TARGET_PATH="$(cd "$TARGET_PATH" && pwd -P)"
REPORTS_DIR="$(cd "$REPORTS_DIR" && pwd -P)"
CACHE_DIR="$(cd "$CACHE_DIR" && pwd -P)"

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
  ${repo_args[@]+"${repo_args[@]}"} \
  ${sbom_args[@]+"${sbom_args[@]}"} \
  --tools "$TOOLS" \
  --format "$FORMAT" \
  --output "/workspace/reports/${REPORT_DATE}_${REPORT_NAME}.${extension}" \
  "$@"
