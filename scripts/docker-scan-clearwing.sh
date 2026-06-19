#!/usr/bin/env bash
# Clearwing（LLM分析）付きセキュリティスキャン
#
# Ollamaコンテナを起動してスキャンを実行し、終了後にコンテナを停止する。
# モデルデータは Docker ボリューム repo-sentry-ollama-models に保存される（初回ダウンロード後は再利用）。
#
# Ollamaを完全に削除する場合（速度が問題な場合など）:
#   1. このスクリプトを削除
#   2. docker rmi ollama/ollama
#   3. docker volume rm repo-sentry-ollama-models
#   ※ docker-scan.sh の変更は不要

usage() {
  cat <<'EOF'
Usage: docker-scan-clearwing.sh [TARGET_DIR] [OPTIONS]

Ollama コンテナを起動し、LLM 分析（Clearwing）付きでスキャンを実行します。

デフォルト動作（オプション省略時）:
  gitleaks + trivy でスキャン → critical/high/medium の finding を LLM 分析。
  Markdown レポートと CycloneDX SBOM を reports/ に出力。
  high 以上の finding があれば終了コード 1。

Options:
  TARGET_DIR                    スキャン対象ディレクトリ (default: カレントディレクトリ)
  --tools LIST                  実行する collector (default: gitleaks,trivy,clearwing)
                                値: gitleaks, trivy, dependabot, clearwing (カンマ区切り)
  --format FORMAT               出力形式 (default: markdown)
                                値: markdown, json
  --no-sbom                     SBOM 生成をスキップ (既定では CycloneDX SBOM を生成)
  --repo OWNER/NAME             GitHub repository (dependabot 使用時に必須)
  --report-name NAME            レポートファイル名のプレフィックス (default: スキャン対象ディレクトリ名)
  --clearwing-depth=DEPTH       LLM 分析の深さ (default: standard)
                                値: priority (critical/high のみ), standard (+ medium), verbose (+ low)
  --fail-on=SEVERITY            終了コード 1 の閾値 (default: high)
                                値: critical, high, medium, low
  --debug                       診断ログを常時表示 (エラー時は自動表示)
  -h, --help                    このヘルプを表示

環境変数:
  OLLAMA_MODEL                  使用するモデル (default: llama3.2、.env でも設定可)
  TOOLS, FORMAT, SBOM, REPO, REPORT_NAME, REPORTS_DIR, CACHE_DIR, REPORT_DATE

所要時間の目安 (llama3.2 / CPU / standard モード):
  finding 1 件につき 20〜60 秒。Mac スリープを防ぐには caffeinate -i を使用してください。

Ollama を完全に削除する場合:
  rm scripts/docker-scan-clearwing.sh
  docker rmi ollama/ollama
  docker volume rm repo-sentry-ollama-models
EOF
}

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
_START_SECONDS=$SECONDS

# --debug / --help フラグをここで処理し、docker-scan.sh には渡さない
# --clearwing-depth はレポートファイル名に反映するため先読みする（そのままパススルーもする）
_debug=0
_clearwing_depth="standard"
_pass_args=()
_skip_next=0
for _arg in "$@"; do
  if [[ $_skip_next -eq 1 ]]; then
    _clearwing_depth="$_arg"
    _skip_next=0
    _pass_args+=("$_arg")
    continue
  fi
  case "$_arg" in
    --debug) _debug=1 ;;
    -h|--help) usage; exit 0 ;;
    --clearwing-depth=*)
      _clearwing_depth="${_arg#*=}"
      _pass_args+=("$_arg") ;;
    --clearwing-depth)
      _skip_next=1
      _pass_args+=("$_arg") ;;
    *) _pass_args+=("$_arg") ;;
  esac
done

# .envから各変数を読む（シェル変数が未設定の場合）
_ENV_FILE="${ENV_FILE:-${SCRIPT_DIR}/../.env}"
if [[ -f "$_ENV_FILE" ]]; then
  if [[ -z "${OLLAMA_MODEL:-}" ]]; then
    _val=$(grep -E "^OLLAMA_MODEL=" "$_ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
    [[ -n "$_val" ]] && OLLAMA_MODEL="$_val"
  fi
  if [[ -z "${CLEARWING_PROVIDER:-}" ]]; then
    _val=$(grep -E "^CLEARWING_PROVIDER=" "$_ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
    [[ -n "$_val" ]] && CLEARWING_PROVIDER="$_val"
  fi
  if [[ -z "${OPENAI_API_KEY:-}" ]]; then
    _val=$(grep -E "^OPENAI_API_KEY=" "$_ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
    [[ -n "$_val" ]] && OPENAI_API_KEY="$_val"
  fi
fi
OLLAMA_MODEL="${OLLAMA_MODEL:-llama3.2}"
OLLAMA_IMAGE="${OLLAMA_IMAGE:-ollama/ollama}"
OLLAMA_VOLUME="repo-sentry-ollama-models"

# プロバイダーを決定（clearwing.tsと同じロジック）
if [[ -n "${CLEARWING_PROVIDER:-}" ]]; then
  _PROVIDER="${CLEARWING_PROVIDER}"
elif [[ -n "${OPENAI_API_KEY:-}" ]]; then
  _PROVIDER="openai"
else
  _PROVIDER="ollama"
fi

# PIDベースのユニーク名
_RUN_ID="$$"
_CONTAINER="repo-sentry-ollama-${_RUN_ID}"

_ollama_started=0
cleanup() {
  if [[ $_ollama_started -eq 1 ]]; then
    echo "[clearwing] Ollamaコンテナを停止中..." >&2
    docker stop "$_CONTAINER" >/dev/null 2>&1 || true
    docker rm   "$_CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

if [[ "$_PROVIDER" == "ollama" ]]; then
  echo "[clearwing] Ollamaコンテナを起動中 (model: ${OLLAMA_MODEL})..." >&2
  # -p 11434:11434 でポートをホストに公開 → repo-sentry は host.docker.internal:11434 で接続
  docker run -d \
    --name "$_CONTAINER" \
    -p 11434:11434 \
    -e OLLAMA_HOST=0.0.0.0 \
    -v "${OLLAMA_VOLUME}:/root/.ollama" \
    "$OLLAMA_IMAGE" >/dev/null || {
    echo "[clearwing] エラー: Ollamaコンテナの起動に失敗しました。" >&2
    echo "[clearwing] ポート 11434 が既に使用中の場合は他の Ollama プロセスを停止してください。" >&2
    exit 1
  }
  _ollama_started=1

  # Ollama API 起動待機（最大30秒）
  echo "[clearwing] Ollama API の起動を待機中..." >&2
  _waited=0
  until docker exec "$_CONTAINER" ollama list >/dev/null 2>&1; do
    _waited=$(( _waited + 1 ))
    if [[ $_waited -ge 30 ]]; then
      echo "[clearwing] エラー: Ollamaの起動がタイムアウトしました" >&2
      exit 1
    fi
    sleep 1
  done

  # モデルがなければpull（初回のみ、以降はボリュームキャッシュを使用）
  if ! docker exec "$_CONTAINER" ollama list 2>/dev/null | grep -q "^${OLLAMA_MODEL%%:*}"; then
    echo "[clearwing] モデル ${OLLAMA_MODEL} をダウンロード中（初回のみ）..." >&2
    docker exec "$_CONTAINER" ollama pull "$OLLAMA_MODEL"
  fi
fi

echo "[clearwing] スキャンを開始します..." >&2

# --toolsにclearwingを追加（未指定の場合）
_tools="${TOOLS:-gitleaks,trivy}"
if [[ "$_tools" != *"clearwing"* ]]; then
  _tools="${_tools},clearwing"
fi

# ターゲットディレクトリ名をレポート名に利用
_target_arg="${PWD}"
for _arg in "${_pass_args[@]+"${_pass_args[@]}"}"; do
  [[ "$_arg" != --* ]] && { _target_arg="$_arg"; break; }
done
_target_basename=$(basename "${_target_arg}" | tr -cd 'A-Za-z0-9._-' | cut -c1-40)
_target_short=$(printf '%s' "$_target_basename" | cut -d'_' -f1 | tr 'A-Z' 'a-z' | cut -c1-12)
_target_hash=$(printf '%s' "$_target_basename" | sha256sum | tr 'a-f' 'A-F' | cut -c1-4)

# depth → ファイル名サフィックス
case "$_clearwing_depth" in
  priority) _cw_suffix="cw-pri" ;;
  verbose)  _cw_suffix="cw-vrb" ;;
  *)        _cw_suffix="cw-std" ;;
esac

# レポートパスを事前に確定して表示
_report_dir="$(cd "${REPORTS_DIR:-$PWD/reports}" 2>/dev/null && pwd -P || echo "$PWD/reports")"
_report_date="${REPORT_DATE:-$(date +%y%m%d%H)}"
_report_name="${REPORT_NAME:-$_target_basename}"
_report_suffix="${REPORT_SUFFIX:-$_cw_suffix}"
_format="${FORMAT:-markdown}"
case "$_format" in
  json) _ext="json" ;;
  *)    _ext="md"   ;;
esac
_report_path="${_report_dir}/${_report_name}/${_target_short}_${_target_hash}${_report_date}_${_report_suffix}.${_ext}"

if [[ $_debug -eq 1 ]]; then
  echo "[clearwing] [debug] provider    : ${_PROVIDER}" >&2
  if [[ "$_PROVIDER" == "ollama" ]]; then
    echo "[clearwing] [debug] OLLAMA_HOST : http://host.docker.internal:11434 (デフォルト)" >&2
    echo "[clearwing] [debug] Ollamaコンテナの状態:" >&2
    { docker inspect "$_CONTAINER" \
      --format '  name={{.Name}} status={{.State.Status}} ports={{json .NetworkSettings.Ports}}' \
      2>/dev/null || echo "  (コンテナ情報取得失敗)"; } >&2
  fi
fi

# docker-scan.sh を呼び出す（終了コードを保存）
# OLLAMA_HOST は clearwing.ts のデフォルト値 host.docker.internal:11434 を使用
_scan_exit=0
TOOLS="$_tools" \
OLLAMA_MODEL="$OLLAMA_MODEL" \
REPORT_NAME="${REPORT_NAME:-$_target_basename}" \
REPORT_SUFFIX="${REPORT_SUFFIX:-$_cw_suffix}" \
  "$SCRIPT_DIR/docker-scan.sh" \
  --clearwing-ack-risk \
  "${_pass_args[@]+"${_pass_args[@]}"}" || _scan_exit=$?

# スキャン結果を表示
echo "" >&2
case $_scan_exit in
  0) echo "[clearwing] 完了: 対応が必要な finding はありませんでした。" >&2 ;;
  1) echo "[clearwing] 完了: 対応が必要な finding が検出されました。" >&2 ;;
  3) echo "[clearwing] 警告: 一部の collector でエラーが発生しました。" >&2 ;;
  4) echo "[clearwing] 警告: 権限不足または token が不足しています。" >&2 ;;
  *) echo "[clearwing] スキャンが終了コード ${_scan_exit} で終了しました。" >&2 ;;
esac
echo "[clearwing] レポート: ${_report_path}" >&2
_elapsed=$(( SECONDS - _START_SECONDS ))
printf "[clearwing] 所要時間: %d分%02d秒\n" "$(( _elapsed / 60 ))" "$(( _elapsed % 60 ))" >&2

# 診断ログ: 失敗時 (exit code >= 2) は自動表示、--debug で常時表示
if [[ $_debug -eq 1 ]] || [[ $_scan_exit -ge 2 ]]; then
  echo "" >&2
  echo "[clearwing] === 診断ログ ===" >&2
  echo "[clearwing] provider: ${_PROVIDER}" >&2
  if [[ "$_PROVIDER" == "ollama" ]]; then
    echo "[clearwing] 接続設定:" >&2
    echo "  OLLAMA_HOST : http://host.docker.internal:11434" >&2
    echo "[clearwing] Ollamaコンテナ状態:" >&2
    { docker inspect "$_CONTAINER" \
      --format '  status={{.State.Status}}  ports={{json .NetworkSettings.Ports}}' \
      2>/dev/null || echo "  (コンテナが見つかりません)"; } >&2
    echo "[clearwing] Ollamaコンテナログ (直近20行):" >&2
    docker logs --tail 20 "$_CONTAINER" 2>&1 | sed 's/^/  /' >&2 || true
  fi
  echo "[clearwing] =================" >&2
  echo "[clearwing] ヒント: レポートの「Collector 実行結果」にエラー詳細が記載されています。" >&2
  [[ $_scan_exit -ge 2 ]] && echo "[clearwing]         詳細確認には --debug オプションを追加してください。" >&2
fi

exit $_scan_exit
