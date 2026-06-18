#!/usr/bin/env bash
# Clearwing（LLM分析）付きセキュリティスキャン
#
# Ollamaコンテナを起動してスキャンを実行し、終了後にコンテナを停止する。
# モデルデータは Docker ボリューム repo-sentry-ollama-models に保存される（初回ダウンロード後は再利用）。
#
# 使い方:
#   ./scripts/docker-scan-clearwing.sh [TARGET_DIR] [OPTIONS]
#   OPTIONS は docker-scan.sh と同様（--tools, --format, --repo 等）
#
# Ollamaを完全に削除する場合（速度が問題な場合など）:
#   1. このスクリプトを削除
#   2. scripts/docker-scan.sh の「Clearwing連携用の内部フック」コメント部分（4行）と
#      docker run 内の _network_args 展開を削除
#   3. docker rmi ollama/ollama
#   4. docker volume rm repo-sentry-ollama-models

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
_START_SECONDS=$SECONDS

# .envからOLLAMA_MODELを読む（シェル変数が未設定の場合）
_ENV_FILE="${ENV_FILE:-${SCRIPT_DIR}/../.env}"
if [[ -z "${OLLAMA_MODEL:-}" ]] && [[ -f "$_ENV_FILE" ]]; then
  _model_from_env=$(grep -E "^OLLAMA_MODEL=" "$_ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
  [[ -n "$_model_from_env" ]] && OLLAMA_MODEL="$_model_from_env"
fi
OLLAMA_MODEL="${OLLAMA_MODEL:-llama3.2}"
OLLAMA_IMAGE="${OLLAMA_IMAGE:-ollama/ollama}"
OLLAMA_VOLUME="repo-sentry-ollama-models"

# PIDベースのユニーク名（並列実行対応）
_RUN_ID="$$"
_CONTAINER="repo-sentry-ollama-${_RUN_ID}"
_NETWORK="repo-sentry-net-${_RUN_ID}"

cleanup() {
  echo "[clearwing] Ollamaコンテナを停止中..." >&2
  docker stop "$_CONTAINER" >/dev/null 2>&1 || true
  docker rm   "$_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$_NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "[clearwing] Dockerネットワークを作成中..." >&2
docker network create "$_NETWORK" >/dev/null

echo "[clearwing] Ollamaコンテナを起動中 (model: ${OLLAMA_MODEL})..." >&2
docker run -d \
  --name "$_CONTAINER" \
  --network "$_NETWORK" \
  -v "${OLLAMA_VOLUME}:/root/.ollama" \
  "$OLLAMA_IMAGE" >/dev/null

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

echo "[clearwing] スキャンを開始します..." >&2

# --toolsにclearwingを追加（未指定の場合）
_tools="${TOOLS:-gitleaks,trivy}"
if [[ "$_tools" != *"clearwing"* ]]; then
  _tools="${_tools},clearwing"
fi

# レポートパスを事前に確定して表示
_report_dir="$(cd "${REPORTS_DIR:-$PWD/reports}" 2>/dev/null && pwd -P || echo "$PWD/reports")"
_report_date="${REPORT_DATE:-$(date +%F)}"
_report_name="${REPORT_NAME:-repo-sentry-docker-scan}"
_format="${FORMAT:-markdown}"
case "$_format" in
  json) _ext="json" ;;
  *)    _ext="md"   ;;
esac
_report_path="${_report_dir}/${_report_date}_${_report_name}.${_ext}"

# docker-scan.sh を呼び出す（終了コードを保存）
# _DOCKER_OPTS_NETWORK: repo-sentryコンテナをOllamaと同じネットワークに接続させる内部フック
# OLLAMA_HOST: コンテナ名でOllamaを参照（Dockerネットワーク内のDNS解決）
_scan_exit=0
TOOLS="$_tools" \
OLLAMA_HOST="http://${_CONTAINER}:11434" \
OLLAMA_MODEL="$OLLAMA_MODEL" \
_DOCKER_OPTS_NETWORK="$_NETWORK" \
  "$SCRIPT_DIR/docker-scan.sh" \
  --clearwing-ack-risk \
  "$@" || _scan_exit=$?

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

exit $_scan_exit
