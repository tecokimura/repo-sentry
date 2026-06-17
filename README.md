# repo-sentry

repo-sentry は、GitHub リポジトリを複数のセキュリティツールでチェックし、結果を JSON / Markdown
レポートへまとめる Deno + TypeScript 製 CLI です。

現在の MVP では、Docker image 内で次を実行できます。

- `gitleaks`: シークレット漏洩チェック
- `trivy`: 依存関係の既知脆弱性と、IaC・設定ファイルの misconfiguration チェック。secret 検出は
  `gitleaks` に委ねるため scanner を `vuln,misconfig` に限定しています
- `dependabot`: GitHub Dependabot alerts API の取得と有効状態診断

ホストに `gitleaks` や `trivy` を直接インストールする必要はありません。基本は Docker で実行します。

## Quick Start

1. Docker image を build します。

```bash
./scripts/docker-build.sh
```

2. カレントディレクトリをスキャンします。

```bash
./scripts/docker-scan.sh
```

別のディレクトリをスキャンする場合は、第一引数で指定できます。

```bash
./scripts/docker-scan.sh /path/to/target-repo
```

指定したディレクトリが存在しない場合は終了コード `2` で終了します。なお `gitleaks` は git
履歴を前提とするため、git 管理されていないディレクトリでは collector が失敗します。

3. レポートを確認します。

```text
reports/YYYY-MM-DD_repo-sentry-docker-scan.md
```

例:

```text
reports/2026-06-08_repo-sentry-docker-scan.md
```

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
reports/YYYY-MM-DD_owner-name-security-scan.md
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

## Docker 実行変数

`scripts/docker-scan.sh` は、次の環境変数で動作を変えられます。

| 変数                | 既定値                    | 説明                                                           |
| ------------------- | ------------------------- | -------------------------------------------------------------- |
| `REPO_SENTRY_IMAGE` | `repo-sentry:local`       | 実行する Docker image                                          |
| `TARGET_PATH`       | 現在のディレクトリ        | スキャン対象ディレクトリ。第一引数でも指定でき、引数が優先     |
| `REPORTS_DIR`       | `./reports`               | レポート出力先                                                 |
| `CACHE_DIR`         | `./.repo-sentry`          | Deno / Trivy cache 保存先                                      |
| `TOOLS`             | `gitleaks,trivy`          | 実行する collector。例: `gitleaks,trivy,dependabot`            |
| `FORMAT`            | `markdown`                | 出力形式。`markdown` または `json`                             |
| `REPORT_DATE`       | 実行日                    | レポートファイル名の日付                                       |
| `REPORT_NAME`       | `repo-sentry-docker-scan` | レポートファイル名のタイトル部分                               |
| `REPO`              | 未設定                    | GitHub repository。Dependabot 使用時に `owner/name` 形式で指定 |
| `DOCKER_USER`       | `$(id -u):$(id -g)`       | bind mount へ書き込むための Docker 実行ユーザー                |

例:

```bash
TARGET_PATH=/path/to/target-repo \
REPORTS_DIR="$PWD/reports" \
REPORT_NAME=my-service-security-scan \
./scripts/docker-scan.sh
```

JSON で出力する例:

```bash
FORMAT=json \
REPORT_NAME=my-service-security-scan \
./scripts/docker-scan.sh
```

## Secret / API Key 変数

secret は CLI 引数ではなく環境変数で渡します。repo-sentry は token
をレポート、ログ、エラー詳細に出さない方針です。

| 変数                | 用途                                                           | 必須になる条件        |
| ------------------- | -------------------------------------------------------------- | --------------------- |
| `GITHUB_TOKEN`      | GitHub API から repository 情報と Dependabot alerts を取得する | `dependabot` 使用時   |
| `SLACK_WEBHOOK_URL` | Slack 通知用                                                   | Slack reporter 実装後 |
| `OPENAI_API_KEY`    | Clearwing が外部 LLM provider を使う場合                       | Clearwing 実装後      |

Dependabot 用の `GITHUB_TOKEN` は、対象 repository の Dependabot alerts
を読める権限が必要です。fine-grained token を使う場合は Dependabot alerts の read
権限を付けてください。

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

## 現在の実装状態

利用可能:

- Docker build / Docker scan
- Deno CLI
- gitleaks collector
- Trivy collector
- Dependabot alerts collector
- JSON reporter
- Markdown reporter
- fixture ベースの tests

未実装または後続予定:

- Slack reporter
- TruffleHog collector
- Clearwing collector
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
