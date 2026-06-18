#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: docker-scan.sh [TARGET_DIR] [OPTIONS]

Options:
  --tools LIST          Collectors to run (default: gitleaks,trivy)
                        Example: --tools gitleaks,trivy,dependabot
  --format FORMAT       Output format: markdown or json (default: markdown)
  --sbom                Generate a CycloneDX SBOM alongside the report
  --repo OWNER/NAME     GitHub repository (required for dependabot)
  --report-name NAME    Report filename prefix (default: repo-sentry-docker-scan)
  -h, --help            Show this help

Environment variables can also set defaults (see README.md). CLI options
take precedence over environment variables.

Unknown --flag=value options are passed through to the repo-sentry CLI
(e.g. --fail-on=critical, --artifacts-dir=./raw).
EOF
}

# Defaults from environment variables
IMAGE="${REPO_SENTRY_IMAGE:-repo-sentry:local}"
TARGET_PATH="${TARGET_PATH:-$PWD}"
REPORTS_DIR="${REPORTS_DIR:-$PWD/reports}"
CACHE_DIR="${CACHE_DIR:-$PWD/.repo-sentry}"
TOOLS="${TOOLS:-gitleaks,trivy}"
FORMAT="${FORMAT:-markdown}"
REPORT_DATE="${REPORT_DATE:-$(date +%y%m%d%H%M)}"
REPORT_NAME="${REPORT_NAME:-repo-sentry-docker-scan}"
DOCKER_USER="${DOCKER_USER:-$(id -u):$(id -g)}"

# Parse arguments — script-level flags are consumed; unknown --* are collected
# for passthrough to the container CLI (use --flag=value form for those).
passthrough_args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage; exit 0 ;;
    --tools)
      TOOLS="$2"; shift 2 ;;
    --tools=*)
      TOOLS="${1#*=}"; shift ;;
    --format)
      FORMAT="$2"; shift 2 ;;
    --format=*)
      FORMAT="${1#*=}"; shift ;;
    --sbom)
      SBOM=true; shift ;;
    --repo)
      REPO="$2"; shift 2 ;;
    --repo=*)
      REPO="${1#*=}"; shift ;;
    --report-name)
      REPORT_NAME="$2"; shift 2 ;;
    --report-name=*)
      REPORT_NAME="${1#*=}"; shift ;;
    --*)
      passthrough_args+=("$1"); shift ;;
    *)
      TARGET_PATH="$1"; shift ;;
  esac
done

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

# .envファイルがあればコンテナに渡す（シェル変数が優先される）
_env_file_args=()
if [[ -f "${ENV_FILE:-.env}" ]]; then
  _env_file_args=(--env-file "${ENV_FILE:-.env}")
fi

docker run --rm \
  --user "$DOCKER_USER" \
  "${_env_file_args[@]+"${_env_file_args[@]}"}" \
  -e DENO_DIR=/workspace/.repo-sentry/deno-cache \
  -e GITHUB_TOKEN \
  -e SLACK_WEBHOOK_URL \
  -e OPENAI_API_KEY \
  -e OLLAMA_HOST \
  -e OLLAMA_MODEL \
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
  ${passthrough_args[@]+"${passthrough_args[@]}"}
