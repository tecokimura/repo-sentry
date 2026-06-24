#!/usr/bin/env bash
set -uo pipefail

_START_SECONDS=$SECONDS
_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

usage() {
  cat <<'EOF'
Usage: docker-run.sh <TARGET_DIR> [OPTIONS]

scan → enrich → report を一括実行します。
stdout には最終レポートのファイルパスのみ出力します。
進捗・警告・エラーは stderr およびログファイルに出力します。

Arguments:
  TARGET_DIR            スキャン対象ディレクトリ (必須)

Options:
  --report-name NAME    レポート名プレフィックス (default: ディレクトリ名)
  --tools LIST          scan ツール (default: gitleaks,trivy)
  -h, --help            このヘルプを表示

環境変数:
  REPORTS_DIR    reports ルートディレクトリ (default: ./reports)
  DATE_FORMAT    ファイル名のタイムスタンプ形式 (default: hour)
  REPORT_DATE    タイムスタンプ文字列を直接指定（DATE_FORMAT より優先）
EOF
}

# DATE_FORMAT / REPORT_DATE を .env から読む（ホスト側で使うため）
_env_file="${ENV_FILE:-.env}"
if [[ -z "${DATE_FORMAT:-}" && -f "$_env_file" ]]; then
  DATE_FORMAT="$(grep -E '^DATE_FORMAT=' "$_env_file" | tail -1 | cut -d= -f2-)"
fi
if [[ -z "${REPORT_DATE:-}" && -f "$_env_file" ]]; then
  REPORT_DATE="$(grep -E '^REPORT_DATE=' "$_env_file" | tail -1 | cut -d= -f2-)"
fi
if [[ -z "${REPORT_DATE:-}" ]]; then
  case "${DATE_FORMAT:-hour}" in
    none)     REPORT_DATE="" ;;
    date)     REPORT_DATE="$(date +%Y%m%d)" ;;
    datetime) REPORT_DATE="$(date +%Y%m%d-%H%M)" ;;
    *)        REPORT_DATE="$(date +%y%m%d%H)" ;;
  esac
fi
export REPORT_DATE

TARGET_DIR=""
REPORT_NAME="${REPORT_NAME:-}"
TOOLS="${TOOLS:-gitleaks,trivy}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)       usage; exit 0 ;;
    --report-name)   REPORT_NAME="$2"; shift 2 ;;
    --report-name=*) REPORT_NAME="${1#*=}"; shift ;;
    --tools)         TOOLS="$2"; shift 2 ;;
    --tools=*)       TOOLS="${1#*=}"; shift ;;
    -*)
      echo "エラー: 不明なオプション: $1" >&2; usage >&2; exit 2 ;;
    *)
      if [[ -z "$TARGET_DIR" ]]; then
        TARGET_DIR="$1"
      else
        echo "エラー: 予期しない引数: $1" >&2; usage >&2; exit 2
      fi
      shift ;;
  esac
done

if [[ -z "$TARGET_DIR" ]]; then
  echo "エラー: TARGET_DIR を指定してください" >&2; usage >&2; exit 2
fi
if [[ ! -d "$TARGET_DIR" ]]; then
  echo "エラー: ディレクトリが見つかりません: $TARGET_DIR" >&2; exit 2
fi

TARGET_DIR="$(cd "$TARGET_DIR" && pwd -P)"
_target_display=$(basename "$TARGET_DIR")
_target_basename=$(printf '%s' "$_target_display" | tr -cd 'A-Za-z0-9._-' | cut -c1-40)
REPORT_NAME="${REPORT_NAME:-${_target_basename}}"
REPORTS_DIR="${REPORTS_DIR:-$PWD/reports}"
export REPORTS_DIR
mkdir -p "${REPORTS_DIR}/${REPORT_NAME}"

# docker-scan.sh と同じ命名ロジックでベース名を確定する
# （find による曖昧な検索を避け、全パスを決定論的に組み立てる）
_short_name=$(printf '%s' "$_target_basename" | cut -d'_' -f1 | tr 'A-Z' 'a-z' | cut -c1-12)
_name_prefix=$(printf '%s' "$_target_basename" | tr 'a-z' 'A-Z' | tr -cd 'A-Z0-9' | cut -c1-4)
_sha_suffix=$(printf '%s' "$_target_basename" | sha256sum | cut -c61-64 | tr 'a-f' 'A-F')
_hash="${_name_prefix}${_sha_suffix}"
_base="${_short_name}_${_hash}${REPORT_DATE}"
_proj="${REPORTS_DIR}/${REPORT_NAME}"

_scan_file="${_proj}/scan_${_base}.json"
_sbom_file="${_proj}/scan_${_base}.sbom.cdx.json"
_enrich_file="${_proj}/enriched_${_base}.json"
_report_file="${_proj}/report_${_base}.md"

# ログファイル（reports/ と同階層の logs/<project>/ に保存）
_log_date="$(date +%y%m%d-%H%M)"
_logs_base="$(dirname "$REPORTS_DIR")/logs"
_log_dir="${_logs_base}/${REPORT_NAME}"
mkdir -p "$_log_dir"
_log_file="${_log_dir}/run_${_log_date}.log"

_log() {
  printf '%s\n' "$*" | tee -a "$_log_file" >&2
}

_log "[repo-sentry] 開始     : $(date '+%Y-%m-%d %H:%M:%S')"
_log "[repo-sentry] 対象     : ${_target_display}"
_log "[repo-sentry] ログ     : ${_log_file#${PWD}/}"
_log ""

# -------------------------
# Step 1: scan
# -------------------------
_log "[repo-sentry] scan 開始"
_scan_exit=0
bash "${_SCRIPT_DIR}/docker-scan.sh" "$TARGET_DIR" \
  --format json --tools "$TOOLS" \
  2> >(tee -a "$_log_file" >&2) || _scan_exit=$?

# exit 0: findings なし / exit 1: findings 検出 → どちらも継続
if [[ $_scan_exit -ge 2 ]]; then
  _log ""
  _log "[repo-sentry] エラー: scan 失敗（終了コード ${_scan_exit}）。処理を中断します。"
  exit $_scan_exit
fi
_log "[repo-sentry] scan 完了"
_log ""

if [[ ! -f "$_scan_file" ]]; then
  _log "[repo-sentry] エラー: scan 出力ファイルが見つかりません: ${_scan_file#${PWD}/}"
  exit 2
fi

# -------------------------
# Step 2: enrich
# -------------------------
_log "[repo-sentry] enrich 開始"
_enrich_exit=0
_sbom_args=()
if [[ -f "$_sbom_file" ]]; then
  _sbom_args=(--sbom "$_sbom_file")
  _log "[repo-sentry] SBOM     : ${_sbom_file#${PWD}/}"
fi
bash "${_SCRIPT_DIR}/docker-enrich.sh" "$_scan_file" \
  ${_sbom_args[@]+"${_sbom_args[@]}"} \
  2> >(tee -a "$_log_file" >&2) || _enrich_exit=$?

if [[ $_enrich_exit -ne 0 ]]; then
  _log ""
  _log "[repo-sentry] エラー: enrich 失敗（終了コード ${_enrich_exit}）。処理を中断します。"
  exit $_enrich_exit
fi
_log "[repo-sentry] enrich 完了"
_log ""

if [[ ! -f "$_enrich_file" ]]; then
  _log "[repo-sentry] エラー: enrich 出力ファイルが見つかりません: ${_enrich_file#${PWD}/}"
  exit 2
fi

# -------------------------
# Step 3: report
# -------------------------
_log "[repo-sentry] report 開始"
_report_exit=0
bash "${_SCRIPT_DIR}/docker-report.sh" "$_enrich_file" \
  2> >(tee -a "$_log_file" >&2) || _report_exit=$?

if [[ $_report_exit -ne 0 ]]; then
  _log ""
  _log "[repo-sentry] エラー: report 失敗（終了コード ${_report_exit}）。処理を中断します。"
  exit $_report_exit
fi
_log "[repo-sentry] report 完了"

if [[ ! -f "$_report_file" ]]; then
  _log "[repo-sentry] エラー: report 出力ファイルが見つかりません: ${_report_file#${PWD}/}"
  exit 2
fi

_elapsed=$(( SECONDS - _START_SECONDS ))
_log ""
_log "[repo-sentry] レポート : ${_report_file#${PWD}/}"
printf '[repo-sentry] 所要時間 : %d分%02d秒\n' "$(( _elapsed / 60 ))" "$(( _elapsed % 60 ))" | tee -a "$_log_file" >&2

# stdout: 最終レポートパスのみ
echo "${_report_file#${PWD}/}"
