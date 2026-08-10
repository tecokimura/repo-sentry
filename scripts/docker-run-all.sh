#!/usr/bin/env bash
set -uo pipefail

_START_SECONDS=$SECONDS
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"

_die() { echo "[run-all] エラー: $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: docker-run-all.sh [TARGET_DIR] [OPTIONS]

scan → enrich → report を一括実行します。
途中でエラーが発生した場合は再開コマンドを表示します。

Arguments:
  TARGET_DIR              スキャン対象ディレクトリ (default: カレントディレクトリ)

再開オプション (エラー時に表示されるコマンドをそのままコピーして使えます):
  --from-scan   SCAN_JSON     scan_*.json からエンリッチ・レポートを再実行
  --from-enrich ENRICH_JSON   enriched_*.json からレポートのみ再実行

スキャンオプション (docker-scan.sh と同じ):
  --tools LIST          実行する collector (default: gitleaks,trivy)
  --no-sbom             SBOM 生成をスキップ
  --fail-on SEVERITY    閾値 (default: high)
  --report-name NAME    レポート名プレフィックス

  -h, --help            このヘルプを表示

環境変数:
  REPORT_LLM_MODEL      Ollama モデル名 (default: qwen2.5:7b)
  その他は docker-scan.sh / docker-enrich.sh / docker-report.sh -h を参照
EOF
}

FROM_SCAN=""
FROM_ENRICH=""
TARGET_DIR=""
EXTRA_SCAN_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)       usage; exit 0 ;;
    --from-scan)     FROM_SCAN="$2"; shift 2 ;;
    --from-scan=*)   FROM_SCAN="${1#*=}"; shift ;;
    --from-enrich)   FROM_ENRICH="$2"; shift 2 ;;
    --from-enrich=*) FROM_ENRICH="${1#*=}"; shift ;;
    *)
      if [[ -z "$TARGET_DIR" && ( -d "$1" || "$1" == "." ) ]]; then
        TARGET_DIR="$1"
      else
        EXTRA_SCAN_ARGS+=("$1")
      fi
      shift ;;
  esac
done

# ログはキャッシュディレクトリ以下に保存
_cache_dir="${CACHE_DIR:-$PWD/.repo-sentry}"
_log_dir="${_cache_dir}/run-all"
mkdir -p "$_log_dir"
_scan_log="${_log_dir}/scan.log"
_enrich_log="${_log_dir}/enrich.log"

SCAN_OUTPUT=""
ENRICH_OUTPUT=""

# ---- STEP 1: SCAN ----
if [[ -n "$FROM_ENRICH" ]]; then
  [[ -f "$FROM_ENRICH" ]] || _die "ファイルが見つかりません: $FROM_ENRICH"
  ENRICH_OUTPUT="$(cd "$(dirname "$FROM_ENRICH")" && pwd -P)/$(basename "$FROM_ENRICH")"
  echo "[run-all] ステップ 1/3, 2/3 をスキップ (--from-enrich)" >&2
elif [[ -n "$FROM_SCAN" ]]; then
  [[ -f "$FROM_SCAN" ]] || _die "ファイルが見つかりません: $FROM_SCAN"
  SCAN_OUTPUT="$(cd "$(dirname "$FROM_SCAN")" && pwd -P)/$(basename "$FROM_SCAN")"
  echo "[run-all] ステップ 1/3 をスキップ (--from-scan)" >&2
else
  echo "[run-all] ステップ 1/3: スキャン" >&2
  : > "$_scan_log"
  _scan_exit=0
  "$SCRIPT_DIR/docker-scan.sh" \
    ${TARGET_DIR:+"$TARGET_DIR"} \
    ${EXTRA_SCAN_ARGS[@]+"${EXTRA_SCAN_ARGS[@]}"} \
    2> >(tee -a "$_scan_log" >&2) || _scan_exit=$?
  wait

  # exit 1 = finding あり（想定内）、2以上 = 実行エラー
  if [[ $_scan_exit -ge 2 ]]; then
    echo "" >&2
    echo "[run-all] スキャン実行エラー（終了コード: ${_scan_exit}）" >&2
    echo "[run-all] 修正後に以下のコマンドで再実行:" >&2
    echo "[run-all]   $0${TARGET_DIR:+ \"$TARGET_DIR\"}${EXTRA_SCAN_ARGS[*]:+ ${EXTRA_SCAN_ARGS[*]}}" >&2
    exit $_scan_exit
  elif [[ $_scan_exit -eq 1 ]]; then
    echo "[run-all] スキャン完了（要対応の finding あり → エンリッチ・レポートに進みます）" >&2
  fi

  # スキャン出力ファイルパスを取得
  SCAN_OUTPUT=$(grep '\[sentry-scan\] 出力先' "$_scan_log" | tail -1 | sed 's/.*出力先[[:space:]]*: //')
  [[ -n "$SCAN_OUTPUT" && -f "$SCAN_OUTPUT" ]] \
    || _die "スキャン出力ファイルを特定できませんでした（ログ: $_scan_log）"
fi

# ---- STEP 2: ENRICH ----
if [[ -z "$ENRICH_OUTPUT" ]]; then
  echo "" >&2
  echo "[run-all] ステップ 2/3: エンリッチ" >&2
  : > "$_enrich_log"
  _enrich_exit=0
  "$SCRIPT_DIR/docker-enrich.sh" "$SCAN_OUTPUT" \
    2> >(tee -a "$_enrich_log" >&2) || _enrich_exit=$?
  wait

  if [[ $_enrich_exit -ne 0 ]]; then
    echo "" >&2
    echo "[run-all] エンリッチ失敗（終了コード: ${_enrich_exit}）" >&2
    echo "[run-all] 修正後に以下のコマンドで再実行:" >&2
    echo "[run-all]   $0 --from-scan \"${SCAN_OUTPUT}\"" >&2
    exit $_enrich_exit
  fi

  # エンリッチ出力ファイルパスを取得（相対パスの場合は絶対パスに変換）
  ENRICH_OUTPUT=$(grep '\[sentry-enrich\] 生成' "$_enrich_log" | tail -1 | sed 's/.*生成[[:space:]]*: //')
  [[ "$ENRICH_OUTPUT" = /* ]] || ENRICH_OUTPUT="$PWD/$ENRICH_OUTPUT"
  [[ -n "$ENRICH_OUTPUT" && -f "$ENRICH_OUTPUT" ]] \
    || _die "エンリッチ出力ファイルを特定できませんでした（ログ: $_enrich_log）"
fi

# ---- STEP 3: REPORT ----
echo "" >&2
echo "[run-all] ステップ 3/3: レポート生成" >&2
_report_exit=0
"$SCRIPT_DIR/docker-report.sh" "$ENRICH_OUTPUT" || _report_exit=$?

if [[ $_report_exit -ne 0 ]]; then
  echo "" >&2
  echo "[run-all] レポート生成失敗（終了コード: ${_report_exit}）" >&2
  echo "[run-all] 修正後に以下のコマンドで再実行:" >&2
  echo "[run-all]   $0 --from-enrich \"${ENRICH_OUTPUT}\"" >&2
  exit $_report_exit
fi

_elapsed=$(( SECONDS - _START_SECONDS ))
echo "" >&2
printf "[run-all] 全ステップ完了 / 所要時間: %d分%02d秒\n" "$(( _elapsed / 60 ))" "$(( _elapsed % 60 ))" >&2
