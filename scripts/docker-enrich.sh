#!/usr/bin/env bash
set -uo pipefail

_START_SECONDS=$SECONDS

usage() {
  cat <<'EOF'
Usage: docker-enrich.sh <SCAN_JSON> [OPTIONS]

scan_*.json を OSV / CISA KEV / EPSS でエンリッチし、
enriched_*.json を同じディレクトリに出力します。

Arguments:
  SCAN_JSON             エンリッチ対象の scan_*.json ファイルパス (必須)

Options:
  --output PATH         出力ファイルパス (default: 入力と同じディレクトリに enriched_... を生成)
  --sbom PATH           CycloneDX SBOM ファイル (direct/transitive 判定用)
  -h, --help            このヘルプを表示

環境変数:
  GITHUB_TOKEN          GitHub Personal Access Token（スコープ不要）
                        設定すると CVE ごとに GitHub Search API で PoC リポジトリを検索する
                        未設定時は OSV references からの PoC 抽出のみ実行
  DATE_FORMAT           ファイル名のタイムスタンプ形式 (default: hour)
                        none: なし / date: YYYYMMDD / datetime: YYYYMMDD-HHMM / hour: YYMMDDHH
  REPORT_DATE           タイムスタンプ文字列を直接指定（DATE_FORMAT より優先）
  REPORTS_DIR           reports ルートディレクトリ (default: 入力ファイルの親の親)
  CACHE_DIR             Deno キャッシュディレクトリ (default: .repo-sentry/)
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

IMAGE="${REPO_SENTRY_ENRICH_IMAGE:-repo-sentry-enrich:local}"
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
SBOM_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --output)   OUTPUT_FILE="$2"; shift 2 ;;
    --output=*) OUTPUT_FILE="${1#*=}"; shift ;;
    --sbom)     SBOM_FILE="$2"; shift 2 ;;
    --sbom=*)   SBOM_FILE="${1#*=}"; shift ;;
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
  echo "エラー: SCAN_JSON を指定してください" >&2
  usage >&2
  exit 2
fi

if [[ ! -f "$INPUT_FILE" ]]; then
  echo "エラー: ファイルが見つかりません: $INPUT_FILE" >&2
  exit 2
fi

INPUT_FILE="$(cd "$(dirname "$INPUT_FILE")" && pwd -P)/$(basename "$INPUT_FILE")"
INPUT_DIR="$(dirname "$INPUT_FILE")"
INPUT_BASE="$(basename "$INPUT_FILE" .json)"

# scan_{short}_{HASH}{YYMMDDHH}[_{suffix}] からプロジェクト識別子を抽出
_stripped="${INPUT_BASE#scan_}"
_short="${_stripped%%_*}"
_after_short="${_stripped#${_short}_}"
_hash="${_after_short:0:8}"

# reports ルートを決定
if [[ -n "${REPORTS_DIR:-}" ]]; then
  _reports_dir="$(cd "$REPORTS_DIR" && pwd -P)"
else
  # reports/{project}/scan_*.json を前提として、 reports/ を基点にする
  _reports_dir="$(dirname "$INPUT_DIR")"
fi
mkdir -p "$_reports_dir"

# 入力ファイルが reports ルート配下にあることを確認
if [[ "$INPUT_FILE" != "${_reports_dir}/"* ]]; then
  echo "エラー: 入力ファイルが REPORTS_DIR の外にあります。REPORTS_DIR を指定してください。" >&2
  exit 2
fi

# 出力ファイルパスを決定
if [[ -z "$OUTPUT_FILE" ]]; then
  OUTPUT_FILE="${INPUT_DIR}/enriched_${_short}_${_hash}${REPORT_DATE}.json"
fi
mkdir -p "$(dirname "$OUTPUT_FILE")"
OUTPUT_FILE="$(cd "$(dirname "$OUTPUT_FILE")" && pwd -P)/$(basename "$OUTPUT_FILE")"

# Deno キャッシュディレクトリ
CACHE_DIR="${CACHE_DIR:-$PWD/.repo-sentry}"
mkdir -p "$CACHE_DIR"
CACHE_DIR="$(cd "$CACHE_DIR" && pwd -P)"

# コンテナ内パスへ変換
_container_input="/workspace/reports/${INPUT_FILE#${_reports_dir}/}"
_container_output="/workspace/reports/${OUTPUT_FILE#${_reports_dir}/}"

echo "[sentry-enrich] エンリッチ開始: $(basename "$INPUT_FILE")" >&2

_enrich_args=(--input "$_container_input" --output "$_container_output")

if [[ -n "$SBOM_FILE" ]]; then
  SBOM_FILE="$(cd "$(dirname "$SBOM_FILE")" && pwd -P)/$(basename "$SBOM_FILE")"
  if [[ "$SBOM_FILE" != "${_reports_dir}/"* ]]; then
    echo "エラー: SBOM ファイルが REPORTS_DIR の外にあります。" >&2
    exit 2
  fi
  _enrich_args+=(--sbom "/workspace/reports/${SBOM_FILE#${_reports_dir}/}")
fi

# .envファイルがあればコンテナに渡す（シェル変数が優先される）
_env_file_args=()
if [[ -f "${ENV_FILE:-.env}" ]]; then
  _env_file_args=(--env-file "${ENV_FILE:-.env}")
fi

_enrich_exit=0
docker run --rm \
  --user "$DOCKER_USER" \
  ${_env_file_args[@]+"${_env_file_args[@]}"} \
  -e DENO_DIR=/workspace/.repo-sentry/deno-cache \
  -e GITHUB_TOKEN \
  -v "${_reports_dir}:/workspace/reports" \
  -v "${CACHE_DIR}:/workspace/.repo-sentry" \
  "$IMAGE" \
  "${_enrich_args[@]}" || _enrich_exit=$?

_elapsed=$(( SECONDS - _START_SECONDS ))
echo "" >&2
case $_enrich_exit in
  0)
    echo "[sentry-enrich] 完了: エンリッチが正常に終了しました。" >&2
    echo "[sentry-enrich] 生成       : ${OUTPUT_FILE#${PWD}/}" >&2
    ;;
  2) echo "[sentry-enrich] エラー: 引数または入力ファイルに問題があります。" >&2 ;;
  *) echo "[sentry-enrich] エラー: 終了コード ${_enrich_exit} で終了しました。" >&2 ;;
esac
printf "[sentry-enrich] 所要時間   : %d分%02d秒\n" "$(( _elapsed / 60 ))" "$(( _elapsed % 60 ))" >&2

exit $_enrich_exit
