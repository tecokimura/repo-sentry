#!/usr/bin/env bash
set -uo pipefail

_START_SECONDS=$SECONDS

usage() {
  cat <<'EOF'
Usage: docker-report.sh <ENRICHED_JSON> [OPTIONS]

enriched_*.json を AI で分析し、report-plan.json と report.md を生成します。

Arguments:
  ENRICHED_JSON         エンリッチ済みの enriched_*.json ファイルパス (必須)

Options:
  --output PATH         report.md の出力パス (default: 入力と同じディレクトリに report_... を生成)
  --plan-input PATH     既存の report-plan.json を再利用（AI 呼び出しをスキップ）
  --plan-output PATH    report-plan.json の出力パス (default: 同ディレクトリに自動生成)
  --debug               report-input.json も保存する
  -h, --help            このヘルプを表示

環境変数:
  REPORT_LLM_PROVIDER   LLM プロバイダー: openai または ollama (CLEARWING_PROVIDER でも可)
  OPENAI_API_KEY        OpenAI API キー
  REPORT_LLM_MODEL      Ollama モデル名 (OLLAMA_MODEL でも可)
  OLLAMA_BASE_URL       Ollama ホスト URL (OLLAMA_HOST でも可)
  OLLAMA_CONTAINER      Ollama の Docker コンテナ名 (default: ollama-report)
                        停止中の場合は自動起動する（OpenAI 使用時はスキップ）
  DATE_FORMAT           ファイル名のタイムスタンプ形式 (default: hour)
                        none: なし / date: YYYYMMDD / datetime: YYYYMMDD-HHMM / hour: YYMMDDHH
  REPORT_DATE           タイムスタンプ文字列を直接指定（DATE_FORMAT より優先）
  REPORTS_DIR           reports ルートディレクトリ (default: 入力ファイルの親の親)
  DOCKER_USER           Docker 実行ユーザー (default: 現在の UID:GID)
EOF
}

# DATE_FORMAT / REPORT_DATE はホスト側で使うため .env を直接読む
_env_file="${ENV_FILE:-.env}"
if [[ -z "${DATE_FORMAT:-}" && -f "$_env_file" ]]; then
  DATE_FORMAT="$(grep -E '^DATE_FORMAT=' "$_env_file" | tail -1 | cut -d= -f2-)"
fi
if [[ -z "${REPORT_DATE:-}" && -f "$_env_file" ]]; then
  REPORT_DATE="$(grep -E '^REPORT_DATE=' "$_env_file" | tail -1 | cut -d= -f2-)"
fi

IMAGE="${REPO_SENTRY_REPORT_IMAGE:-repo-sentry-report:local}"
if [[ -z "${REPORT_DATE:-}" ]]; then
  case "${DATE_FORMAT:-hour}" in
    none)     REPORT_DATE="" ;;
    date)     REPORT_DATE="$(date +%Y%m%d)" ;;
    datetime) REPORT_DATE="$(date +%Y%m%d-%H%M)" ;;
    *)        REPORT_DATE="$(date +%y%m%d%H)" ;;
  esac
fi
DOCKER_USER="${DOCKER_USER:-$(id -u):$(id -g)}"

INPUT_FILE=""
OUTPUT_FILE=""
PLAN_INPUT_FILE=""
PLAN_FILE=""
DEBUG=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)    usage; exit 0 ;;
    --output)     OUTPUT_FILE="$2"; shift 2 ;;
    --output=*)   OUTPUT_FILE="${1#*=}"; shift ;;
    --plan-input)  PLAN_INPUT_FILE="$2"; shift 2 ;;
    --plan-input=*) PLAN_INPUT_FILE="${1#*=}"; shift ;;
    --plan-output)  PLAN_FILE="$2"; shift 2 ;;
    --plan-output=*) PLAN_FILE="${1#*=}"; shift ;;
    --debug)      DEBUG=true; shift ;;
    -*)
      echo "不明なオプション: $1" >&2; usage >&2; exit 2 ;;
    *)
      if [[ -z "$INPUT_FILE" ]]; then
        INPUT_FILE="$1"
      else
        echo "予期しない引数: $1" >&2; usage >&2; exit 2
      fi
      shift ;;
  esac
done

if [[ -z "$INPUT_FILE" ]]; then
  echo "エラー: ENRICHED_JSON を指定してください" >&2; usage >&2; exit 2
fi

if [[ ! -f "$INPUT_FILE" ]]; then
  echo "エラー: ファイルが見つかりません: $INPUT_FILE" >&2; exit 2
fi

INPUT_FILE="$(cd "$(dirname "$INPUT_FILE")" && pwd -P)/$(basename "$INPUT_FILE")"
INPUT_DIR="$(dirname "$INPUT_FILE")"
INPUT_BASE="$(basename "$INPUT_FILE" .json)"

# enriched_{short}_{HASH}{YYMMDDHH}[_{suffix}] からプロジェクト識別子を抽出
_stripped="${INPUT_BASE#enriched_}"
_short="${_stripped%%_*}"
_after_short="${_stripped#${_short}_}"
_hash="${_after_short:0:8}"

# reports ルートを決定
if [[ -n "${REPORTS_DIR:-}" ]]; then
  _reports_dir="$(cd "$REPORTS_DIR" && pwd -P)"
else
  _reports_dir="$(dirname "$INPUT_DIR")"
fi
mkdir -p "$_reports_dir"

if [[ "$INPUT_FILE" != "${_reports_dir}/"* ]]; then
  echo "エラー: 入力ファイルが REPORTS_DIR の外にあります。REPORTS_DIR を指定してください。" >&2
  exit 2
fi

# 出力パスを決定
if [[ -z "$OUTPUT_FILE" ]]; then
  OUTPUT_FILE="${INPUT_DIR}/report_${_short}_${_hash}${REPORT_DATE}.md"
fi
if [[ -z "$PLAN_FILE" ]]; then
  PLAN_FILE="${INPUT_DIR}/report_${_short}_${_hash}${REPORT_DATE}-plan.json"
fi
mkdir -p "$(dirname "$OUTPUT_FILE")"
OUTPUT_FILE="$(cd "$(dirname "$OUTPUT_FILE")" && pwd -P)/$(basename "$OUTPUT_FILE")"
PLAN_FILE="$(cd "$(dirname "$PLAN_FILE")" && pwd -P)/$(basename "$PLAN_FILE")"

# Deno キャッシュ
CACHE_DIR="${CACHE_DIR:-$PWD/.repo-sentry}"
mkdir -p "$CACHE_DIR"
CACHE_DIR="$(cd "$CACHE_DIR" && pwd -P)"

# コンテナ内パスへ変換
_container_input="/workspace/reports/${INPUT_FILE#${_reports_dir}/}"
_container_output="/workspace/reports/${OUTPUT_FILE#${_reports_dir}/}"
_container_plan="/workspace/reports/${PLAN_FILE#${_reports_dir}/}"

echo "[sentry-report] レポート生成開始: $(basename "$INPUT_FILE")" >&2

# debug オプション
_debug_args=()
if [[ "$DEBUG" == "true" ]]; then
  _debug_file="${INPUT_DIR}/report_${_short}_${_hash}${REPORT_DATE}-input.json"
  mkdir -p "$(dirname "$_debug_file")"
  _debug_file="$(cd "$(dirname "$_debug_file")" && pwd -P)/$(basename "$_debug_file")"
  _container_debug="/workspace/reports/${_debug_file#${_reports_dir}/}"
  _debug_args=(--debug-input "$_container_debug")
fi

# --plan-input オプション
_plan_input_args=()
if [[ -n "$PLAN_INPUT_FILE" ]]; then
  PLAN_INPUT_FILE="$(cd "$(dirname "$PLAN_INPUT_FILE")" && pwd -P)/$(basename "$PLAN_INPUT_FILE")"
  if [[ "$PLAN_INPUT_FILE" != "${_reports_dir}/"* ]]; then
    echo "エラー: --plan-input ファイルが REPORTS_DIR の外にあります。" >&2; exit 2
  fi
  _plan_input_args=(--plan-input "/workspace/reports/${PLAN_INPUT_FILE#${_reports_dir}/}")
fi

# .envファイルがあればコンテナに渡す（シェル変数が優先される）
_env_file_args=()
if [[ -f "${ENV_FILE:-.env}" ]]; then
  _env_file_args=(--env-file "${ENV_FILE:-.env}")
fi

# Ollama コンテナの自動起動（OpenAI 使用時はスキップ）
_provider="${REPORT_LLM_PROVIDER:-${CLEARWING_PROVIDER:-}}"
if [[ "$_provider" != "openai" && -z "${OPENAI_API_KEY:-}" ]]; then
  _ollama_container="${OLLAMA_CONTAINER:-ollama-report}"
  if docker inspect "$_ollama_container" > /dev/null 2>&1; then
    if ! docker ps --format '{{.Names}}' | grep -q "^${_ollama_container}$"; then
      echo "[sentry-report] Ollama コンテナを起動中: ${_ollama_container}" >&2
      docker start "$_ollama_container" > /dev/null
      echo "[sentry-report] Ollama の起動を待機中..." >&2
      _wait=0
      until curl -sf "http://localhost:${OLLAMA_PORT:-11434}/api/tags" > /dev/null 2>&1 || [[ $_wait -ge 30 ]]; do
        sleep 2
        _wait=$(( _wait + 2 ))
      done
      if [[ $_wait -ge 30 ]]; then
        echo "[sentry-report] 警告: Ollama 起動タイムアウト（接続を試みます）" >&2
      else
        echo "[sentry-report] Ollama 起動完了" >&2
      fi
    fi
  else
    echo "[sentry-report] 警告: Ollama コンテナ '${_ollama_container}' が見つかりません" >&2
  fi
fi

_exit=0
docker run --rm \
  --user "$DOCKER_USER" \
  ${_env_file_args[@]+"${_env_file_args[@]}"} \
  -e DENO_DIR=/workspace/.repo-sentry/deno-cache \
  -e OPENAI_API_KEY \
  -e REPORT_LLM_PROVIDER \
  -e REPORT_LLM_MODEL \
  -e OLLAMA_BASE_URL \
  -v "${_reports_dir}:/workspace/reports" \
  -v "${CACHE_DIR}:/workspace/.repo-sentry" \
  --add-host=host.docker.internal:host-gateway \
  "$IMAGE" \
  --input "$_container_input" \
  --output "$_container_output" \
  --plan-output "$_container_plan" \
  ${_plan_input_args[@]+"${_plan_input_args[@]}"} \
  ${_debug_args[@]+"${_debug_args[@]}"} || _exit=$?

_elapsed=$(( SECONDS - _START_SECONDS ))
echo "" >&2
case $_exit in
  0)
    echo "[sentry-report] 完了: レポートが正常に生成されました。" >&2
    echo "[sentry-report] 生成(plan)  : ${PLAN_FILE#${PWD}/}" >&2
    echo "[sentry-report] 生成(report): ${OUTPUT_FILE#${PWD}/}" >&2
    ;;
  2) echo "[sentry-report] エラー: 引数または入力ファイルに問題があります。" >&2 ;;
  *) echo "[sentry-report] エラー: 終了コード ${_exit} で終了しました。" >&2 ;;
esac
printf "[sentry-report] 所要時間   : %d分%02d秒\n" "$(( _elapsed / 60 ))" "$(( _elapsed % 60 ))" >&2

exit $_exit
