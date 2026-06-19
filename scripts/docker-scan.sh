#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: docker-scan.sh [TARGET_DIR] [OPTIONS]

デフォルト動作（オプション省略時）:
  gitleaks + trivy でスキャン、Markdown レポートと CycloneDX SBOM を reports/ に出力。
  high 以上の finding があれば終了コード 1。

Options:
  TARGET_DIR            スキャン対象ディレクトリ (default: カレントディレクトリ)
  --tools LIST          実行する collector (default: gitleaks,trivy)
                        値: gitleaks, trivy, dependabot, clearwing (カンマ区切り)
  --format FORMAT       出力形式 (default: markdown)
                        値: markdown, json
  --no-sbom             SBOM 生成をスキップ (既定では CycloneDX SBOM を生成)
  --repo OWNER/NAME     GitHub repository (dependabot 使用時に必須)
  --report-name NAME    レポートファイル名のプレフィックス (default: スキャン対象ディレクトリ名)
  -h, --help            このヘルプを表示

repo-sentry CLI に直接渡せるオプション (--flag=value 形式):
  --fail-on=SEVERITY    終了コード 1 の閾値 (default: high)
                        値: critical, high, medium, low
  --artifacts-dir=PATH  raw scanner output (gitleaks/trivy JSON) の保存先

環境変数でデフォルト値を変更できます (CLI オプションが優先):
  TOOLS, FORMAT, SBOM, REPO, REPORT_NAME, REPORTS_DIR, CACHE_DIR, REPORT_DATE, DOCKER_USER
EOF
}

# Defaults from environment variables
IMAGE="${REPO_SENTRY_IMAGE:-repo-sentry:local}"
TARGET_PATH="${TARGET_PATH:-$PWD}"
REPORTS_DIR="${REPORTS_DIR:-$PWD/reports}"
CACHE_DIR="${CACHE_DIR:-$PWD/.repo-sentry}"
TOOLS="${TOOLS:-gitleaks,trivy}"
FORMAT="${FORMAT:-markdown}"
REPORT_DATE="${REPORT_DATE:-$(date +%y%m%d%H)}"
REPORT_NAME="${REPORT_NAME:-}"
REPORT_SUFFIX="${REPORT_SUFFIX:-}"
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
    --no-sbom)
      SBOM=false; shift ;;
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

SBOM="${SBOM:-true}"
sbom_args=()
if [[ "$SBOM" == "true" ]]; then
  sbom_args=(--sbom)
fi

mkdir -p "$REPORTS_DIR" "$CACHE_DIR"

TARGET_PATH="$(cd "$TARGET_PATH" && pwd -P)"
REPORTS_DIR="$(cd "$REPORTS_DIR" && pwd -P)"
CACHE_DIR="$(cd "$CACHE_DIR" && pwd -P)"

# ターゲットディレクトリ名をレポート名・タイトルに利用
# _target_display: レポート本文用（省略なし）
# _target_basename: サブディレクトリ名用（英数字/_/-/. のみ、40文字以内）
# _short_name: ファイル名プレフィックス（最初の_区切り要素、小文字、12文字以内）
# _hash: _target_basenameのsha256頭4文字（大文字）
_target_display=$(basename "$TARGET_PATH")
_target_basename=$(printf '%s' "$_target_display" | tr -cd 'A-Za-z0-9._-' | cut -c1-40)
_short_name=$(printf '%s' "$_target_basename" | cut -d'_' -f1 | tr 'A-Z' 'a-z' | cut -c1-12)
_hash=$(printf '%s' "$_target_basename" | sha256sum | tr 'a-f' 'A-F' | cut -c1-4)
REPORT_NAME="${REPORT_NAME:-${_target_basename}}"
_suffix_part="${REPORT_SUFFIX:+_${REPORT_SUFFIX}}"

mkdir -p "$REPORTS_DIR/$REPORT_NAME"

repo_args=()
if [[ -n "${REPO:-}" ]]; then
  repo_args=(--repo "$REPO")
else
  repo_args=(--repo "${_target_display}")
fi

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
  --output "/workspace/reports/${REPORT_NAME}/scan_${_short_name}_${_hash}${REPORT_DATE}${_suffix_part}.${extension}" \
  ${passthrough_args[@]+"${passthrough_args[@]}"}
