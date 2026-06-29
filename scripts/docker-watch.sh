#!/usr/bin/env bash
set -uo pipefail

_START_SECONDS=$SECONDS

usage() {
  cat <<'EOF'
Usage: docker-watch.sh <BASELINE_SCAN_JSON> <BASELINE_ENRICHED_JSON> [OPTIONS]

baseline-scan.json を再エンリッチし、baseline-enriched.json との差分を検出します。
watch-diff_<HASH>_<YYMMDD>.json と watch-report_<HASH>_<YYMMDD>.md を出力します。

Arguments:
  BASELINE_SCAN_JSON        ベーススキャンの scan_*.json ファイルパス (必須)
  BASELINE_ENRICHED_JSON    ベーラインの enriched_*.json ファイルパス (必須)

Options:
  --output-dir DIR          出力先ディレクトリ (default: BASELINE_ENRICHED_JSON と同じディレクトリ)
  -h, --help                このヘルプを表示

環境変数:
  DATE_FORMAT               ファイル名のタイムスタンプ形式 (default: hour)
                            none: なし / date: YYYYMMDD / datetime: YYYYMMDD-HHMM / hour: YYMMDDHH
  REPORT_DATE               タイムスタンプ文字列を直接指定（DATE_FORMAT より優先）
  REPORTS_DIR               reports ルートディレクトリ (default: 入力ファイルの親の親)
  CACHE_DIR                 Deno キャッシュディレクトリ (default: .repo-sentry/)
  DOCKER_USER               Docker 実行ユーザー (default: 現在の UID:GID)
  GITHUB_TOKEN              GitHub Personal Access Token（エンリッチ時の PoC 検索に使用）
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

IMAGE="${REPO_SENTRY_WATCH_IMAGE:-repo-sentry-watch:local}"
DOCKER_USER="${DOCKER_USER:-$(id -u):$(id -g)}"

BASELINE_SCAN_FILE=""
BASELINE_ENRICHED_FILE=""
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)       usage; exit 0 ;;
    --output-dir)    OUTPUT_DIR="$2"; shift 2 ;;
    --output-dir=*)  OUTPUT_DIR="${1#*=}"; shift ;;
    -*)
      echo "不明なオプション: $1" >&2; usage >&2; exit 2 ;;
    *)
      if [[ -z "$BASELINE_SCAN_FILE" ]]; then
        BASELINE_SCAN_FILE="$1"
      elif [[ -z "$BASELINE_ENRICHED_FILE" ]]; then
        BASELINE_ENRICHED_FILE="$1"
      else
        echo "予期しない引数: $1" >&2; usage >&2; exit 2
      fi
      shift ;;
  esac
done

if [[ -z "$BASELINE_SCAN_FILE" ]]; then
  echo "エラー: BASELINE_SCAN_JSON を指定してください" >&2; usage >&2; exit 2
fi
if [[ -z "$BASELINE_ENRICHED_FILE" ]]; then
  echo "エラー: BASELINE_ENRICHED_JSON を指定してください" >&2; usage >&2; exit 2
fi

if [[ ! -f "$BASELINE_SCAN_FILE" ]]; then
  echo "エラー: ファイルが見つかりません: $BASELINE_SCAN_FILE" >&2; exit 2
fi
if [[ ! -f "$BASELINE_ENRICHED_FILE" ]]; then
  echo "エラー: ファイルが見つかりません: $BASELINE_ENRICHED_FILE" >&2; exit 2
fi

BASELINE_SCAN_FILE="$(cd "$(dirname "$BASELINE_SCAN_FILE")" && pwd -P)/$(basename "$BASELINE_SCAN_FILE")"
BASELINE_ENRICHED_FILE="$(cd "$(dirname "$BASELINE_ENRICHED_FILE")" && pwd -P)/$(basename "$BASELINE_ENRICHED_FILE")"

BASELINE_ENRICHED_DIR="$(dirname "$BASELINE_ENRICHED_FILE")"

# reports ルートを決定
if [[ -n "${REPORTS_DIR:-}" ]]; then
  _reports_dir="$(cd "$REPORTS_DIR" && pwd -P)"
else
  _reports_dir="$(dirname "$BASELINE_ENRICHED_DIR")"
fi
mkdir -p "$_reports_dir"

# Deno キャッシュ
CACHE_DIR="${CACHE_DIR:-$PWD/.repo-sentry}"
mkdir -p "$CACHE_DIR"
CACHE_DIR="$(cd "$CACHE_DIR" && pwd -P)"

# .envファイルがあればコンテナに渡す（シェル変数が優先される）
_env_file_args=()
if [[ -f "${ENV_FILE:-.env}" ]]; then
  _env_file_args=(--env-file "${ENV_FILE:-.env}")
fi

# watch/ サブディレクトリ（なければ自動作成）
_watch_dir="${BASELINE_ENRICHED_DIR}/watch"
mkdir -p "$_watch_dir"

# (1) sentry-enrich を再実行: baseline scan.json → watch-enrich_*.json（固定名・上書き）
echo "[sentry-watch] (1) ベーススキャンを再エンリッチ中..." >&2
_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# scan ファイルの識別子を抽出
_scan_base="$(basename "$BASELINE_SCAN_FILE" .json)"
_scan_stripped="${_scan_base#scan_}"
_scan_short="${_scan_stripped%%_*}"
_scan_after_short="${_scan_stripped#${_scan_short}_}"
_scan_hash="${_scan_after_short:0:8}"

# watch-enrich_ は固定名（日付なし）で watch/ に配置して毎回上書き
NEW_ENRICHED_FILE="${_watch_dir}/watch-enrich_${_scan_short}_${_scan_hash}.json"

bash "$_SCRIPT_DIR/docker-enrich.sh" \
  "$BASELINE_SCAN_FILE" \
  --output "$NEW_ENRICHED_FILE" || {
  echo "[sentry-watch] エラー: 再エンリッチに失敗しました" >&2
  exit 1
}

echo "" >&2
echo "[sentry-watch] (2) 差分を検出中..." >&2

# 出力先ディレクトリを決定（デフォルト: watch/ サブディレクトリ）
if [[ -n "$OUTPUT_DIR" ]]; then
  mkdir -p "$OUTPUT_DIR"
  _output_dir="$(cd "$OUTPUT_DIR" && pwd -P)"
else
  _output_dir="$_watch_dir"
fi

# 入力ファイルが reports ルート配下にあることを確認
if [[ "$BASELINE_ENRICHED_FILE" != "${_reports_dir}/"* ]]; then
  echo "エラー: baseline-enriched ファイルが REPORTS_DIR の外にあります。REPORTS_DIR を指定してください。" >&2
  exit 2
fi

# コンテナ内パスへ変換
_container_baseline="/workspace/reports/${BASELINE_ENRICHED_FILE#${_reports_dir}/}"
_container_new="/workspace/reports/${NEW_ENRICHED_FILE#${_reports_dir}/}"
_container_output_dir="/workspace/reports/${_output_dir#${_reports_dir}/}"

# (2) sentry-watch コンテナを呼び出して比較・出力
_watch_exit=0
docker run --rm \
  --user "$DOCKER_USER" \
  ${_env_file_args[@]+"${_env_file_args[@]}"} \
  -e DENO_DIR=/workspace/.repo-sentry/deno-cache \
  -v "${_reports_dir}:/workspace/reports" \
  -v "${CACHE_DIR}:/workspace/.repo-sentry" \
  "$IMAGE" \
  "$_container_baseline" \
  "$_container_new" \
  --output-dir "$_container_output_dir" \
  --baseline-scan "/workspace/reports/${BASELINE_SCAN_FILE#${_reports_dir}/}" || _watch_exit=$?

_elapsed=$(( SECONDS - _START_SECONDS ))
echo "" >&2
case $_watch_exit in
  0)
    echo "[sentry-watch] 完了: 差分検出が正常に終了しました。" >&2
    ;;
  2) echo "[sentry-watch] エラー: 引数または入力ファイルに問題があります。" >&2 ;;
  *) echo "[sentry-watch] エラー: 終了コード ${_watch_exit} で終了しました。" >&2 ;;
esac
printf "[sentry-watch] 所要時間   : %d分%02d秒\n" "$(( _elapsed / 60 ))" "$(( _elapsed % 60 ))" >&2

exit $_watch_exit
