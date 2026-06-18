# repo-sentry

repo-sentry は、GitHub リポジトリを複数のセキュリティツールでチェックし、結果を JSON / Markdown
レポートへまとめる Deno + TypeScript 製 CLI です。

Docker image 内で次の collector を実行できます。

- `gitleaks`: シークレット漏洩チェック
- `trivy`: 依存関係の既知脆弱性と、IaC・設定ファイルの misconfiguration チェック。secret 検出は
  `gitleaks` に委ねるため scanner を `vuln,misconfig` に限定しています
- `dependabot`: GitHub Dependabot alerts API の取得と有効状態診断
- `clearwing`: LLM（Ollama）による各 finding のリスク分析・対応判断メモ生成（後述）

ホストに `gitleaks` や `trivy` を直接インストールする必要はありません。基本は Docker で実行します。

## 動作要件

- Docker (Engine 20.10 以上)
- bash

ホスト側に `gitleaks` や `trivy`、`deno` を別途インストールする必要はありません。 すべて Docker
image 内にパッケージされています。

## Quick Start

1. Docker image を build します。

```bash
./scripts/docker-build.sh
```

初回 build は gitleaks と Trivy のダウンロードがあるため 3〜5 分ほどかかります。 build が成功すると
`Successfully tagged repo-sentry:local` のようなメッセージが出ます。

2. スキャンしたいリポジトリのディレクトリで実行します。

```bash
# カレントディレクトリをスキャン
./scripts/docker-scan.sh

# 別のディレクトリを指定する場合
./scripts/docker-scan.sh /path/to/target-repo
```

> **注意:** `gitleaks` は git 履歴を前提とするため、スキャン対象は git 管理されたディレクトリを
> 指定してください。git 管理外のディレクトリでは gitleaks collector が失敗します(終了コード `3`)。

スキャン完了後、終了コードで結果を確認できます。

```bash
./scripts/docker-scan.sh /path/to/target-repo
echo "exit: $?"
# 0 → finding なし  1 → high 以上の finding あり  3 → collector エラー
```

3. レポートを確認します。

```text
reports/YYMMDDHHMM_repo-sentry-docker-scan.md
```

例:

```text
reports/2606181423_repo-sentry-docker-scan.md
```

## 設定ファイル（.env）

シークレットや設定は `.env` ファイルで管理できます。

```bash
cp .env.example .env
# エディタで値を設定する
```

`.env` があればスキャン実行時に自動で読み込まれます。シェル環境変数が同名の変数を持つ場合は、
シェル変数が優先されます。

**.env の設定項目:**

```bash
# GitHub Personal Access Token（dependabot使用時に必要）
GITHUB_TOKEN=ghp_xxxxxxxxxxxx

# Slack通知用 Webhook URL（任意）
SLACK_WEBHOOK_URL=https://hooks.slack.com/...

# Clearwing で使用する Ollama モデル（clearwing使用時のみ参照）
OLLAMA_MODEL=llama3.2
```

`.env` は `.gitignore` に含まれているため、誤ってコミットされることはありません。

---

## Dependabot も含めて実行する

Dependabot alerts API を使う場合は、GitHub token と repository 名が必要です。

```bash
export GITHUB_TOKEN=...

REPO=owner/name \
TOOLS=gitleaks,trivy,dependabot \
REPORT_NAME=owner-name-security-scan \
./scripts/docker-scan.sh
```

出力例:

```text
reports/YYMMDDHHMM_owner-name-security-scan.md
```

Dependabot alerts API は、API 実行時に GitHub に新規スキャンをさせるものではありません。GitHub 側で
Dependabot alerts / dependency graph が有効になっており、すでに生成されている alerts を取得します。

repo-sentry は、alerts 件数だけでなく、取得元の状態もレポートします。

| 状態                  | 意味                                             |
| --------------------- | ------------------------------------------------ |
| `enabled_with_alerts` | Dependabot alerts が有効で、alerts を取得できた  |
| `enabled_no_alerts`   | Dependabot alerts が有効だが、対象 alerts はない |
| `disabled`            | dependency alerts が無効と判断できた             |
| `permission_missing`  | token 権限不足で確認できない                     |
| `repo_archived`       | archived repository のため期待値を下げる         |
| `unknown`             | API 応答だけでは確定できない                     |

`0 件` と `権限不足で確認不能` は別物として扱います。

## Clearwing: LLM による finding 分析（オプション）

Clearwing は、スキャン結果の各 finding に対して以下を自動生成します。

- **リスク**: 攻撃シナリオとビジネスへの影響
- **類似インシデント**: この種の脆弱性に関連する実際の攻撃事例
- **対応判断メモ**: 影響範囲・対応コスト・放置した場合の最悪シナリオ

通常スキャンとは**完全に独立したスクリプト**で動作します。`docker-scan.sh` は Ollama を一切使いません。

### パターン A: 通常スキャン（LLM なし）

```bash
./scripts/docker-scan.sh /path/to/target-repo
```

Ollama は起動しません。シンプルに gitleaks + trivy の結果のみレポートされます。

### パターン B: LLM 分析付きスキャン（Clearwing あり）

```bash
./scripts/docker-scan-clearwing.sh /path/to/target-repo
```

実行の流れ:

1. Ollama コンテナを自動起動
2. モデルが未ダウンロードの場合は取得（初回のみ、約 2 GB）
3. スキャンを実行し、critical / high の finding に LLM 分析を追加
4. スキャン完了後に Ollama コンテナを自動停止・削除

> **初回実行について:** `llama3.2` モデル（約 2 GB）のダウンロードが発生します。
> 2 回目以降は Docker ボリューム `repo-sentry-ollama-models` にキャッシュされるため、
> すぐに起動します。

モデルは `.env` の `OLLAMA_MODEL` で変更できます（既定値: `llama3.2`）。

### 分析の深さを変える

既定では critical / high / medium の finding を分析します（`standard` モード）。
finding が多すぎる場合は `--clearwing-depth=priority` で絞れます。

| 値           | 分析対象                          |
| ------------ | --------------------------------- |
| `priority`   | critical / high のみ              |
| `standard`   | critical / high / medium（既定）  |
| `verbose`    | info / unknown を除くすべて       |

```bash
# 標準（デフォルト）: critical / high / medium を分析
./scripts/docker-scan-clearwing.sh /path/to/target-repo

# mediumが多くて時間がかかる場合: critical / high のみに絞る
./scripts/docker-scan-clearwing.sh /path/to/target-repo --clearwing-depth=priority

# すべての finding を分析したい場合
./scripts/docker-scan-clearwing.sh /path/to/target-repo --clearwing-depth=verbose

# dependabot も含めてスキャン + LLM 分析
./scripts/docker-scan-clearwing.sh /path/to/target-repo \
  --repo owner/name \
  --tools gitleaks,trivy,dependabot,clearwing

# JSON 形式で出力
./scripts/docker-scan-clearwing.sh /path/to/target-repo --format json
```

### Clearwing を完全に削除する場合

Ollama の速度が許容できない場合など、完全に取り除く手順:

```bash
# 1. Clearwing スクリプトを削除
rm scripts/docker-scan-clearwing.sh

# 2. Ollama の Docker イメージとモデルキャッシュを削除
docker rmi ollama/ollama
docker volume rm repo-sentry-ollama-models
```

`docker-scan.sh` 自体は変更不要で、通常スキャンへの影響はありません。

> **Mac ネイティブ Ollama への移行:** Ollama をホストに直接インストールして
> `ollama serve` を起動している場合は、`docker-scan.sh` に `--clearwing-ack-risk` と
> `--tools gitleaks,trivy,clearwing` を追加するだけでそのまま利用できます。
> ホストの Ollama は `host.docker.internal:11434` で自動的に参照されます。

---

## Docker 実行オプション

よく使うオプションはコマンドライン引数で指定できます。

| オプション           | 対応する env 変数 | 既定値                    | 説明                                                 |
| -------------------- | ----------------- | ------------------------- | ---------------------------------------------------- |
| `--tools LIST`       | `TOOLS`           | `gitleaks,trivy`          | 実行する collector。カンマ区切り                     |
| `--format FORMAT`    | `FORMAT`          | `markdown`                | 出力形式。`markdown` または `json`                   |
| `--sbom`             | `SBOM`            | 未設定                    | 指定すると CycloneDX SBOM をレポートと同じ場所に生成 |
| `--repo OWNER/NAME`  | `REPO`            | 未設定                    | GitHub repository。Dependabot 使用時に必要           |
| `--report-name NAME` | `REPORT_NAME`     | `repo-sentry-docker-scan` | レポートファイル名のプレフィックス                   |

例:

```bash
# gitleaks + trivy + dependabot、SBOM も生成
./scripts/docker-scan.sh /path/to/target-repo \
  --tools gitleaks,trivy,dependabot \
  --sbom \
  --repo owner/name \
  --report-name my-service-scan
```

```bash
# JSON 形式で出力
./scripts/docker-scan.sh /path/to/target-repo --format json
```

上記以外のオプション(`--fail-on` など)は `--flag=value` 形式で渡すと repo-sentry CLI
にそのまま転送されます。

```bash
./scripts/docker-scan.sh /path/to/target-repo --fail-on=critical
```

CLI オプションは対応する環境変数より優先されます。環境変数でのみ設定できる項目:

| 変数                | 既定値              | 説明                                            |
| ------------------- | ------------------- | ----------------------------------------------- |
| `REPO_SENTRY_IMAGE` | `repo-sentry:local` | 実行する Docker image                           |
| `REPORTS_DIR`       | `./reports`         | レポート出力先                                  |
| `CACHE_DIR`         | `./.repo-sentry`    | Deno / Trivy cache 保存先                       |
| `REPORT_DATE`       | 実行日              | レポートファイル名の日付部分                    |
| `DOCKER_USER`       | `$(id -u):$(id -g)` | bind mount へ書き込むための Docker 実行ユーザー |

## Secret / API Key 変数

secret は CLI 引数ではなく環境変数（または `.env` ファイル）で渡します。
repo-sentry は token をレポート、ログ、エラー詳細に出さない方針です。

| 変数                | 用途                                                           | 必須になる条件      |
| ------------------- | -------------------------------------------------------------- | ------------------- |
| `GITHUB_TOKEN`      | GitHub API から repository 情報と Dependabot alerts を取得する | `dependabot` 使用時 |
| `SLACK_WEBHOOK_URL` | Slack 通知用                                                   | Slack reporter 実装後 |
| `OLLAMA_MODEL`      | Clearwing で使用する Ollama モデル名（既定値: `llama3.2`）     | `clearwing` 使用時  |

`gitleaks` と `trivy` のみ使用する場合、`GITHUB_TOKEN` は不要です。

Dependabot 用の `GITHUB_TOKEN` に必要な権限:

| token 種別         | 必要な権限                                       |
| ------------------ | ------------------------------------------------ |
| classic token      | `repo`(private repo) または public repo なら不要 |
| fine-grained token | `Dependabot alerts: Read-only`                   |

権限が不足していると collector は `permission_missing` として記録され、終了コード `4` になります。

## Build 変数

`scripts/docker-build.sh` は、次の build 変数を受け取ります。

| 変数                | 既定値              | 説明                               |
| ------------------- | ------------------- | ---------------------------------- |
| `DENO_VERSION`      | `2.5.6`             | Docker image 内の Deno version     |
| `GITLEAKS_VERSION`  | `8.30.1`            | Docker image 内の gitleaks version |
| `TRIVY_VERSION`     | `0.70.0`            | Docker image 内の Trivy version    |
| `REPO_SENTRY_IMAGE` | `repo-sentry:local` | build する Docker image 名         |

例:

```bash
DENO_VERSION=2.5.6 \
GITLEAKS_VERSION=8.30.1 \
TRIVY_VERSION=0.70.0 \
REPO_SENTRY_IMAGE=repo-sentry:local \
./scripts/docker-build.sh
```

Trivy は過去に特定リリースへ supply-chain advisory が出ているため、Dockerfile では `latest`
を使わず、明示バージョンの release asset を checksum 検証してインストールします。

## Docker Compose

Docker Compose でも実行できます。

```bash
docker compose build
LOCAL_UID=$(id -u) LOCAL_GID=$(id -g) docker compose run --rm repo-sentry
```

Compose の既定コマンドは、カレントリポジトリを read-only で `/workspace/target` に mount
し、`gitleaks,trivy` を実行して `reports/latest.md` を生成します。

Compose で使う主な変数:

| 変数                | 説明                           |
| ------------------- | ------------------------------ |
| `LOCAL_UID`         | コンテナ実行ユーザーの UID     |
| `LOCAL_GID`         | コンテナ実行ユーザーの GID     |
| `GITHUB_TOKEN`      | Dependabot alerts API 用       |
| `SLACK_WEBHOOK_URL` | Slack 通知用。現時点では未実装 |
| `OPENAI_API_KEY`    | Clearwing 用。現時点では未実装 |

## CLI の直接実行

開発時は Deno で直接実行できます。ただしこの方法ではホスト側に `gitleaks` と `trivy` が必要です。

```bash
deno run \
  --allow-read \
  --allow-write=./reports \
  --allow-env=GITHUB_TOKEN \
  --allow-net=api.github.com \
  --allow-run=gitleaks,trivy \
  src/cli.ts run \
  --path ./target-repo \
  --repo owner/name \
  --tools gitleaks,trivy,dependabot \
  --format markdown \
  --output ./reports/latest.md
```

CLI options:

| Option                    | 説明                                                        |
| ------------------------- | ----------------------------------------------------------- |
| `--path PATH`             | ローカル repository path。`gitleaks` / `trivy` 使用時に必要 |
| `--repo owner/name`       | GitHub repository。`dependabot` 使用時に必要                |
| `--tools LIST`            | 実行 collector。例: `gitleaks,trivy,dependabot`             |
| `--format json\|markdown` | レポート形式                                                |
| `--output PATH`           | レポート出力先                                              |
| `--artifacts-dir PATH`    | raw scanner output の保存先                                 |
| `--fail-on SEVERITY`      | policy 閾値。既定値は `high`                                |

## レポート

Markdown レポートには次が含まれます。

- scan date
- repository / path
- severity summary
- collector status
- findings

collector が失敗した場合も、finding とは別に `Collector Statuses` として記録します。

JSON レポートは次のような形です。

```json
{
  "repository": "owner/name",
  "path": "/workspace/target",
  "scannedAt": "2026-06-08T00:00:00.000Z",
  "summary": {
    "critical": 0,
    "high": 1,
    "medium": 0,
    "low": 0,
    "info": 0,
    "unknown": 0
  },
  "collectorStatuses": [
    {
      "tool": "dependabot",
      "status": "completed",
      "sourceStatus": "enabled_no_alerts",
      "findingsCount": 0,
      "notes": []
    }
  ],
  "findings": []
}
```

## 終了コード

| 終了コード | 意味                                     |
| ---------: | ---------------------------------------- |
|        `0` | 実行成功、policy 閾値以上の finding なし |
|        `1` | policy 閾値以上の finding あり           |
|        `2` | CLI 引数や config が不正                 |
|        `3` | collector 実行エラー                     |
|        `4` | 必須権限または token 不足                |

複数の条件に該当する場合は `4` > `3` > `1` の優先順位で返します。たとえば collector の一部が失敗し、
かつ policy 閾値以上の finding がある場合の終了コードは `3` です。CI で finding
の有無だけを見る場合も `1` 以外の非ゼロ終了コードを失敗として扱ってください。

## よくある失敗と対処

**`Cannot connect to the Docker daemon` と出る**

Docker が起動していません。Docker Desktop または Docker Engine を起動してください。

**`Unable to find image 'repo-sentry:local'` と出る**

image がまだ build されていません。先に `./scripts/docker-build.sh` を実行してください。

**`gitleaks collector` が失敗して終了コード `3` になる**

スキャン対象が git 管理されていないディレクトリです。`git init`
済みのリポジトリを対象にしてください。

**Dependabot collector が `permission_missing` になる**

`GITHUB_TOKEN` が設定されていないか権限が不足しています。`gitleaks` と `trivy` だけで十分な場合は
`TOOLS=gitleaks,trivy` で Dependabot を外して実行できます。

```bash
TOOLS=gitleaks,trivy ./scripts/docker-scan.sh /path/to/target-repo
```

**レポートファイルが空または生成されない**

`reports/` ディレクトリへの書き込み権限を確認してください。`DOCKER_USER` の既定値は
`$(id -u):$(id -g)` のため、通常は問題になりません。

**`docker-scan-clearwing.sh` 実行時に「Ollamaの起動がタイムアウト」と出る**

Docker Hub からの `ollama/ollama` イメージ取得に時間がかかっている可能性があります（初回のみ）。
ネットワーク環境を確認して再実行してください。

**Clearwing の LLM 分析が遅い**

Mac の Docker は Apple Silicon GPU（Metal）が使えないため、CPU のみで推論します。
`llama3.2`（3B）であれば通常 30〜80 秒 / finding 程度です。件数が多い場合は
`--clearwing-depth=quick`（既定）のまま使うか、Mac ネイティブ Ollama への移行を検討してください。

**Clearwing の分析に時間がかかりすぎる**

`standard` モード（既定）では critical / high / medium を分析します。medium の件数が多い場合は
`--clearwing-depth=priority` で critical / high のみに絞れます。

## 現在の実装状態

利用可能:

- Docker build / Docker scan
- Deno CLI
- gitleaks collector
- Trivy collector
- Dependabot alerts collector
- Clearwing collector（Ollama による LLM 分析）
- JSON reporter
- Markdown reporter
- CycloneDX SBOM 生成（`--sbom`）
- fixture ベースの tests

未実装または後続予定:

- Slack reporter
- TruffleHog collector
- 複数 repository の一括実行
- GitHub Actions workflow

詳細な設計方針は [docs/tool-recommendations.md](docs/tool-recommendations.md) を参照してください。

## 開発者向け確認

```bash
deno fmt
deno check src/cli.ts
deno lint
deno test
```
