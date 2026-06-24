#!/usr/bin/env bash
set -uo pipefail

_START_SECONDS=$SECONDS

usage() {
  cat <<'EOF'
Usage: docker-export.sh <REPORT_MD> [OPTIONS]

report_*.md を PDF に変換します。

Arguments:
  REPORT_MD             変換対象の report_*.md ファイルパス (必須)

Options:
  --output PATH         出力 PDF パス (default: 入力と同じディレクトリに .pdf を生成)
  -h, --help            このヘルプを表示

環境変数:
  REPORTS_DIR    reports ルートディレクトリ (default: 入力ファイルの親の親)
  DOCKER_USER    Docker 実行ユーザー (default: 現在の UID:GID)
EOF
}

IMAGE="${REPO_SENTRY_EXPORT_IMAGE:-repo-sentry-export:local}"
DOCKER_USER="${DOCKER_USER:-$(id -u):$(id -g)}"

INPUT_FILE=""
OUTPUT_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)     usage; exit 0 ;;
    --output)      OUTPUT_FILE="$2"; shift 2 ;;
    --output=*)    OUTPUT_FILE="${1#*=}"; shift ;;
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
  echo "エラー: REPORT_MD を指定してください" >&2; usage >&2; exit 2
fi
if [[ ! -f "$INPUT_FILE" ]]; then
  echo "エラー: ファイルが見つかりません: $INPUT_FILE" >&2; exit 2
fi

INPUT_FILE="$(cd "$(dirname "$INPUT_FILE")" && pwd -P)/$(basename "$INPUT_FILE")"
INPUT_DIR="$(dirname "$INPUT_FILE")"

# reports ルートを決定
if [[ -n "${REPORTS_DIR:-}" ]]; then
  _reports_dir="$(cd "$REPORTS_DIR" && pwd -P)"
else
  _reports_dir="$(dirname "$INPUT_DIR")"
fi

if [[ "$INPUT_FILE" != "${_reports_dir}/"* ]]; then
  echo "エラー: 入力ファイルが REPORTS_DIR の外にあります。REPORTS_DIR を指定してください。" >&2
  exit 2
fi

# 出力パスを決定（拡張子を .pdf に変更）
if [[ -z "$OUTPUT_FILE" ]]; then
  _base="${INPUT_FILE%.md}"
  OUTPUT_FILE="${_base}.pdf"
fi
mkdir -p "$(dirname "$OUTPUT_FILE")"
OUTPUT_FILE="$(cd "$(dirname "$OUTPUT_FILE")" && pwd -P)/$(basename "$OUTPUT_FILE")"

# コンテナ内パスへ変換
_container_input="/workspace/reports/${INPUT_FILE#${_reports_dir}/}"
_container_output="/workspace/reports/${OUTPUT_FILE#${_reports_dir}/}"

echo "[sentry-export] PDF変換開始: $(basename "$INPUT_FILE")" >&2

_exit=0
docker run --rm \
  --user "$DOCKER_USER" \
  -v "${_reports_dir}:/workspace/reports" \
  "$IMAGE" \
  "$_container_input" \
  "$_container_output" || _exit=$?

_elapsed=$(( SECONDS - _START_SECONDS ))
echo "" >&2
case $_exit in
  0)
    echo "[sentry-export] 完了: PDF が生成されました。" >&2
    echo "[sentry-export] 生成: ${OUTPUT_FILE#${PWD}/}" >&2
    ;;
  2) echo "[sentry-export] エラー: 引数または入力ファイルに問題があります。" >&2 ;;
  *) echo "[sentry-export] エラー: 終了コード ${_exit} で終了しました。" >&2 ;;
esac
printf "[sentry-export] 所要時間: %d分%02d秒\n" "$(( _elapsed / 60 ))" "$(( _elapsed % 60 ))" >&2

exit $_exit
