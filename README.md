# repo-sentry

repo-sentry は、GitHub リポジトリを複数のセキュリティツールでチェックし、結果を JSON / Markdown
レポートへまとめる Deno + TypeScript 製 CLI です。

Docker image 内で次の collector を実行できます。

- `gitleaks`: シークレット漏洩チェック
- `trivy`: 依存関係の既知脆弱性と、IaC・設定ファイルの misconfiguration チェック。secret 検出は
  `gitleaks` に委ねるため scanner を `vuln,misconfig` に限定しています
- `dependabot`: GitHub Dependabot alerts API の取得と有効状態診断
- `clearwing`: LLM（Ollama または OpenAI）による各 finding のリスク分析・対応判断メモ生成（後述）

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

出力先は `reports/{プロジェクト名}/` ディレクトリです。

```text
reports/
  MYAPP-main/
    scan_myapp_MYAP7C1A26061217.md       ← Markdown レポート
    scan_myapp_MYAP7C1A26061217.json     ← JSON（sentry-enrich の入力に使用）
    scan_myapp_MYAP7C1A26061217.sbom.cdx.json
```

ファイル名の構成: `scan_{short}_{HASH}{YYMMDDHH}[_{suffix}].{ext}`

- `short`: プロジェクト名の最初のセグメント（小文字・12 文字以内）
- `HASH`: プロジェクト名の先頭 4 文字（英数大文字）+ sha256 末尾 4 桁（最大 8 文字）
- `YYMMDDHH`: 日時（`DATE_FORMAT` / `REPORT_DATE` で変更・省略可能）

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

# Clearwing プロバイダー（省略時: OPENAI_API_KEY があれば openai、なければ ollama）
# CLEARWING_PROVIDER=openai
# CLEARWING_PROVIDER=ollama

# OpenAI を使う場合
OPENAI_API_KEY=sk-...
# OPENAI_MODEL=gpt-4o-mini   # 省略時のデフォルト

# Ollama を使う場合
OLLAMA_MODEL=qwen2.5:7b
```

`.env` は `.gitignore` に含まれているため、誤ってコミットされることはありません。

---

## sentry-enrich: 外部 DB エンリッチ（Phase 2）

`docker-scan.sh` で生成した `scan_*.json` を、外部脆弱性データベースで補強します。

```bash
./scripts/docker-enrich.sh reports/MYAPP-main/scan_myapp_MYAP7C1A26061217.json
```

エンリッチ完了後、同じディレクトリに `enriched_*.json` が生成されます。

```text
reports/
  MYAPP-main/
    scan_myapp_MYAP7C1A26061217.json
    enriched_myapp_MYAP7C1A26061217.json   ← 追加情報付き
```

### 追加される情報

| フィールド           | ソース                                                                   | 内容                                                    |
| -------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------- |
| `osv`                | [OSV](https://osv.dev/)                                                  | 脆弱性詳細・aliases・summary                            |
| `kev`                | [CISA KEV](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) | 実際に悪用されているか（dateAdded など）                |
| `epss`               | [FIRST EPSS](https://www.first.org/epss/)                                | 今後悪用される可能性スコア（0.0〜1.0）                  |
| `dependencyType`     | SBOM                                                                     | `direct` または `transitive`（SBOM 指定時のみ）         |
| `canonicalReference` | finding.id から生成                                                      | CVE → AVD URL、GHSA → GitHub Advisory URL               |
| `invalidReferences`  | URL 検証                                                                 | finding.id と一致しない URL を記録（report では非表示） |

### docker-enrich.sh オプション

| オプション      | 説明                                                |
| --------------- | --------------------------------------------------- |
| `SCAN_JSON`     | エンリッチ対象の `scan_*.json` ファイルパス（必須） |
| `--output PATH` | 出力ファイルパス（省略時は入力と同じディレクトリ）  |
| `--sbom PATH`   | CycloneDX SBOM（`direct`/`transitive` 判定用）      |

### Docker image の build

`docker-build.sh` は全ツールの image を一括で build します。

```bash
./scripts/docker-build.sh   # scan + enrich + report + export + watch
```

個別に build する場合:

```bash
./scripts/docker-build-scan.sh    # repo-sentry-scan:local
./scripts/docker-build-enrich.sh  # repo-sentry-enrich:local
./scripts/docker-build-report.sh  # repo-sentry-report:local
./scripts/docker-build-export.sh  # repo-sentry-export:local
./scripts/docker-build-watch.sh   # repo-sentry-watch:local
```

`--no-cache` オプションを付けると Docker キャッシュを使わずにビルドします。

```bash
./scripts/docker-build-enrich.sh --no-cache
./scripts/docker-build-report.sh --no-cache
```

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
reports/owner-name-security-scan/scan_owner-name-s_OWNE7C1A26071016.md
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
- **悪用シナリオ**: この種の脆弱性が悪用される典型的な流れ
- **対応判断メモ**: 影響を受ける可能性がある機能・設定・条件

通常スキャンとは**完全に独立したスクリプト**で動作します。`docker-scan.sh` は LLM を一切使いません。

### プロバイダーの選択

Clearwing は **Ollama（ローカル）** と **OpenAI API** の両方に対応しています。

`.env` の `CLEARWING_PROVIDER` で切り替えます。

```bash
CLEARWING_PROVIDER=openai   # OpenAI を使用（OPENAI_API_KEY 必須）
CLEARWING_PROVIDER=ollama   # Ollama を使用
# 省略時: OPENAI_API_KEY が設定されていれば openai、なければ ollama
```

| プロバイダー           | 速度            | コスト          | プライバシー   | 推奨用途                     |
| ---------------------- | --------------- | --------------- | -------------- | ---------------------------- |
| OpenAI (`gpt-4o-mini`) | 速い            | 約 1 円 / 25 件 | データ送信あり | 品質重視・社外プロジェクト   |
| Ollama (ローカル)      | 遅い（CPU依存） | 無料            | データ送信なし | オフライン・社内プロジェクト |

### パターン A: 通常スキャン（LLM なし）

```bash
./scripts/docker-scan.sh /path/to/target-repo
```

LLM は起動しません。シンプルに gitleaks + trivy の結果のみレポートされます。

### パターン B: OpenAI で LLM 分析

`.env` に API キーを設定して `docker-scan-clearwing.sh` を実行します。

```bash
# .env に設定
CLEARWING_PROVIDER=openai
OPENAI_API_KEY=sk-...
# OPENAI_MODEL=gpt-4o-mini  # 省略可（デフォルト）
```

```bash
./scripts/docker-scan-clearwing.sh /path/to/target-repo
```

OpenAI API キーの発行方法:

1. [platform.openai.com/api-keys](https://platform.openai.com/api-keys) でキーを作成
2. Permissions は `Restricted` → `Model capabilities: Write` のみで十分
3. `Settings → Limits` で月の使用上限を設定しておくことを推奨（$5 で十分）

### パターン C: Ollama（ローカル LLM）で LLM 分析

```bash
# .env に設定
CLEARWING_PROVIDER=ollama
OLLAMA_MODEL=qwen2.5:7b
```

```bash
./scripts/docker-scan-clearwing.sh /path/to/target-repo
```

実行の流れ:

1. Ollama コンテナを自動起動
2. モデルが未ダウンロードの場合は取得（初回のみ、約 4 GB）
3. スキャンを実行し、critical / high / medium の finding に LLM 分析を追加（standard モード）
4. スキャン完了後に Ollama コンテナを自動停止・削除

モデルは 2 回目以降 Docker ボリューム `repo-sentry-ollama-models` にキャッシュされます。

### Clearwing を完全に削除する場合

```bash
# 1. Clearwing スクリプトを削除
rm scripts/docker-scan-clearwing.sh

# 2. Ollama の Docker イメージとモデルキャッシュを削除（Ollama 使用時のみ）
docker rmi ollama/ollama
docker volume rm repo-sentry-ollama-models
```

`docker-scan.sh` 自体は変更不要で、通常スキャンへの影響はありません。

> **Mac ネイティブ Ollama への移行:** Ollama をホストに直接インストールして `ollama serve`
> を起動している場合は、`docker-scan.sh` に `--clearwing-ack-risk` と
> `--tools gitleaks,trivy,clearwing` を追加するだけでそのまま利用できます。 ホストの Ollama は
> `host.docker.internal:11434` で自動的に参照されます。

---

## Docker 実行オプション

### docker-scan.sh

デフォルト動作（オプション省略時）: `gitleaks + trivy` でスキャン、Markdown レポートと CycloneDX
SBOM を `reports/` に出力。

| オプション             | 対応する env 変数 | 既定値               | 説明                                                     |
| ---------------------- | ----------------- | -------------------- | -------------------------------------------------------- |
| `TARGET_DIR`           | `TARGET_PATH`     | カレントディレクトリ | スキャン対象ディレクトリ                                 |
| `--tools LIST`         | `TOOLS`           | `gitleaks,trivy`     | 実行する collector。カンマ区切り                         |
| `--format FORMAT`      | `FORMAT`          | `markdown`           | 出力形式。`markdown` または `json`                       |
| `--no-sbom`            | `SBOM=false`      | **SBOM 有効**        | 指定すると CycloneDX SBOM 生成をスキップ                 |
| `--repo OWNER/NAME`    | `REPO`            | 未設定               | GitHub repository。Dependabot 使用時に必須               |
| `--report-name NAME`   | `REPORT_NAME`     | `repo-sentry-scan`   | レポートファイル名のプレフィックス                       |
| `--fail-on=SEVERITY`   | —                 | `high`               | 終了コード 1 の閾値。`critical/high/medium/low` を指定可 |
| `--artifacts-dir=PATH` | —                 | 未設定               | raw scanner output (gitleaks/trivy JSON) の保存先        |

`--fail-on` と `--artifacts-dir` は `--flag=value` 形式で repo-sentry CLI に直接転送されます。

例:

```bash
# gitleaks + trivy + dependabot（SBOM はデフォルトで生成される）
./scripts/docker-scan.sh /path/to/target-repo \
  --tools gitleaks,trivy,dependabot \
  --repo owner/name \
  --report-name my-service-scan

# SBOM を生成しない
./scripts/docker-scan.sh /path/to/target-repo --no-sbom

# critical のみを失敗扱いにする
./scripts/docker-scan.sh /path/to/target-repo --fail-on=critical

# JSON 形式で出力
./scripts/docker-scan.sh /path/to/target-repo --format json
```

### docker-scan-clearwing.sh

デフォルト動作: `gitleaks + trivy + clearwing` でスキャン、critical/high/medium を LLM
分析、Markdown レポートと SBOM を出力。

| オプション                | 既定値                     | 説明                                       |
| ------------------------- | -------------------------- | ------------------------------------------ |
| `TARGET_DIR`              | カレントディレクトリ       | スキャン対象ディレクトリ                   |
| `--tools LIST`            | `gitleaks,trivy,clearwing` | 実行する collector                         |
| `--format FORMAT`         | `markdown`                 | 出力形式。`markdown` または `json`         |
| `--no-sbom`               | **SBOM 有効**              | 指定すると SBOM 生成をスキップ             |
| `--clearwing-depth=DEPTH` | `standard`                 | LLM 分析の対象範囲                         |
| `--repo OWNER/NAME`       | 未設定                     | GitHub repository。Dependabot 使用時に必須 |
| `--fail-on=SEVERITY`      | `high`                     | 終了コード 1 の閾値                        |
| `--debug`                 | オフ                       | 診断ログを常時表示（エラー時は自動表示）   |

`--clearwing-depth` の値:

| 値         | 分析対象                         |
| ---------- | -------------------------------- |
| `priority` | critical / high のみ             |
| `standard` | critical / high / medium（既定） |
| `verbose`  | info / unknown を除くすべて      |

例:

```bash
# 標準（デフォルト）
./scripts/docker-scan-clearwing.sh /path/to/target-repo

# critical / high のみ分析（finding が多く時間がかかる場合）
./scripts/docker-scan-clearwing.sh /path/to/target-repo --clearwing-depth=priority

# dependabot も含めてスキャン
./scripts/docker-scan-clearwing.sh /path/to/target-repo \
  --repo owner/name \
  --tools gitleaks,trivy,dependabot,clearwing

# SBOM なし・JSON 形式
./scripts/docker-scan-clearwing.sh /path/to/target-repo --no-sbom --format json
```

CLI オプションは対応する環境変数より優先されます。環境変数でのみ設定できる項目:

| 変数                | 既定値              | 説明                                                |
| ------------------- | ------------------- | --------------------------------------------------- |
| `REPO_SENTRY_IMAGE` | `repo-sentry:local` | 実行する Docker image                               |
| `REPORTS_DIR`       | `./reports`         | レポート出力先                                      |
| `CACHE_DIR`         | `./.repo-sentry`    | Deno / Trivy cache 保存先                           |
| `REPORT_DATE`       | 実行日時            | レポートファイル名の日時部分（形式: YYYYMMDD-HHMM） |
| `DOCKER_USER`       | `$(id -u):$(id -g)` | bind mount へ書き込むための Docker 実行ユーザー     |

## Secret / API Key 変数

secret は CLI 引数ではなく環境変数（または `.env` ファイル）で渡します。 repo-sentry は token
をレポート、ログ、エラー詳細に出さない方針です。

| 変数                 | 用途                                                           | 必須になる条件                 |
| -------------------- | -------------------------------------------------------------- | ------------------------------ |
| `GITHUB_TOKEN`       | GitHub API から repository 情報と Dependabot alerts を取得する | `dependabot` 使用時            |
| `SLACK_WEBHOOK_URL`  | Slack 通知用                                                   | Slack reporter 実装後          |
| `CLEARWING_PROVIDER` | Clearwing のプロバイダー指定（`openai` または `ollama`）       | 省略時は自動判定               |
| `OPENAI_API_KEY`     | OpenAI API キー                                                | `CLEARWING_PROVIDER=openai` 時 |
| `OPENAI_MODEL`       | 使用する OpenAI モデル（既定値: `gpt-4o-mini`）                | 任意                           |
| `OLLAMA_MODEL`       | 使用する Ollama モデル（推奨: `qwen2.5:7b`）                   | `CLEARWING_PROVIDER=ollama` 時 |

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

| 変数                | 説明                            |
| ------------------- | ------------------------------- |
| `LOCAL_UID`         | コンテナ実行ユーザーの UID      |
| `LOCAL_GID`         | コンテナ実行ユーザーの GID      |
| `GITHUB_TOKEN`      | Dependabot alerts API 用        |
| `SLACK_WEBHOOK_URL` | Slack 通知用。現時点では未実装  |
| `OPENAI_API_KEY`    | Clearwing OpenAI プロバイダー用 |

## CLI の直接実行

開発時は Deno で直接実行できます。ただしこの方法ではホスト側に `gitleaks` と `trivy` が必要です。

```bash
deno run \
  --allow-read \
  --allow-write=./reports \
  --allow-env=GITHUB_TOKEN \
  --allow-net=api.github.com \
  --allow-run=gitleaks,trivy \
  src/sentry-scan/cli.ts run \
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
  "scanId": "550e8400-e29b-41d4-a716-446655440000",
  "profile": "base",
  "repository": "owner/name",
  "path": "/workspace/target",
  "scannedAt": "2026-06-12T00:00:00.000Z",
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
      "tool": "trivy",
      "status": "completed",
      "findingsCount": 1,
      "notes": []
    }
  ],
  "findings": [
    {
      "tool": "trivy",
      "category": "dependency-vulnerability",
      "severity": "high",
      "title": "CVE-2024-1234 in example/package",
      "packageName": "example/package",
      "packageVersion": "1.2.3",
      "ecosystem": "composer",
      "purl": "pkg:composer/example/package@1.2.3",
      "fixedVersions": ["1.2.4", "2.0.0"],
      "identifiers": ["CVE-2024-1234"],
      "status": "open"
    }
  ]
}
```

---

## sentry-report: AI レポート生成（Phase 3）

`docker-enrich.sh` で生成した `enriched_*.json` をもとに、AI が分析して Markdown
レポートを生成します。

```bash
./scripts/docker-report.sh reports/MYAPP-main/enriched_myapp_MYAP7C1A26061217.json
```

生成ファイル:

```text
reports/
  MYAPP-main/
    report_myapp_MYAP7C1A26061217-plan.json   ← AI が生成した ReportPlan（監査用）
    report_myapp_MYAP7C1A26061217.md          ← Markdown レポート
```

`--debug` を付けると `report-input.json`（変換後の中間データ）も保存されます。

### LLM プロバイダーの設定

```bash
# OpenAI を使う場合
REPORT_LLM_PROVIDER=openai \
OPENAI_API_KEY=sk-... \
./scripts/docker-report.sh enriched.json

# Ollama（ローカル）を使う場合
REPORT_LLM_PROVIDER=ollama \
REPORT_LLM_MODEL=qwen2.5:7b \
./scripts/docker-report.sh enriched.json
```

| 環境変数              | 既定値                              | 説明                                                    |
| --------------------- | ----------------------------------- | ------------------------------------------------------- |
| `REPORT_LLM_PROVIDER` | 自動判定                            | `openai` または `ollama`（`CLEARWING_PROVIDER` でも可） |
| `OPENAI_API_KEY`      | —                                   | OpenAI API キー                                         |
| `REPORT_LLM_MODEL`    | `qwen2.5:7b` / `gpt-4o-mini`        | LLM モデル名（`OLLAMA_MODEL` でも可）                   |
| `OLLAMA_BASE_URL`     | `http://host.docker.internal:11434` | Ollama ホスト（`OLLAMA_HOST` でも可）                   |

### AI の責務分離

AI（`ReportPlan`）が担当する内容:

- 総評（executiveSummary）・全体リスク評価
- 各 finding の対応理由・後回し理由

Renderer（`ReportInput` から直接）が担当する内容:

- CVE ID・パッケージ名・バージョン・修正コマンド
- EPSS スコア・KEV 情報・CWE
- 付録の全 Finding 一覧

→ AI が修正コマンドやバージョンを捏造するリスクを排除しています。

### docker-report.sh オプション

| オプション           | 説明                                                             |
| -------------------- | ---------------------------------------------------------------- |
| `ENRICHED_JSON`      | 対象の `enriched_*.json` ファイルパス（必須）                    |
| `--output PATH`      | `report.md` の出力パス（省略時は入力と同ディレクトリに自動生成） |
| `--plan-output PATH` | `report-plan.json` の出力パス                                    |
| `--plan-input PATH`  | 既存の `report-plan.json` を再利用（AI 呼び出しをスキップ）      |
| `--debug`            | `report-input.json` も保存（デバッグ用）                         |

---

## docker-run.sh: 一括実行（scan → enrich → report）

3 ステップを一コマンドで実行します。stdout には最終レポートのファイルパスのみが出力されるため、
シェルスクリプトやパイプラインから扱いやすくなっています。進捗・警告は stderr と
`logs/{プロジェクト名}/run_YYMMDD-HHMM.log` に出力されます。

```bash
./scripts/docker-run.sh /path/to/target-repo
# stdout: reports/target-repo/report_target_XXXX26071016.md
```

| オプション           | 既定値           | 説明                      |
| -------------------- | ---------------- | ------------------------- |
| `TARGET_DIR`         | 必須             | スキャン対象ディレクトリ  |
| `--report-name NAME` | ディレクトリ名   | レポート名プレフィックス  |
| `--tools LIST`       | `gitleaks,trivy` | scan で実行する collector |

SBOM が生成されていれば enrich に自動で渡されます（direct/transitive 判定に使用）。 scan
の終了コードが `0`（finding なし）または `1`（finding あり）の場合は後続へ進み、 `2`
以上（エラー）の場合は中断します。

環境変数 `REPORTS_DIR` / `DATE_FORMAT` / `REPORT_DATE` で出力先とファイル名の日時部分を
制御できます（`DATE_FORMAT`: `none` / `date` / `datetime` / `hour`）。

---

## sentry-export: PDF 生成

`docker-report.sh` で生成した `report_*.md` を PDF
に変換します。配布・アーカイブ用途を想定しています。

```bash
./scripts/docker-export.sh reports/MYAPP-main/report_myapp_MYAP7C1A26061217.md
```

省略時は入力と同じディレクトリに `report_myapp_MYAP7C1A26061217.pdf` が生成されます。

| オプション      | 説明                                            |
| --------------- | ----------------------------------------------- |
| `REPORT_MD`     | 変換対象の `report_*.md` ファイルパス（必須）   |
| `--output PATH` | 出力 PDF パス（省略時は入力と同じディレクトリ） |

image は `./scripts/docker-build-export.sh` で build します（`repo-sentry-export:local`）。

---

## sentry-watch: 継続監視（Phase 4 最小版）

一度スキャンしたリポジトリについて、外部脆弱性 DB（KEV / EPSS / OSV）の変化を検出します。 trivy
による再スキャンは行わず、既存の `scan_*.json` を sentry-enrich で再エンリッチし、 前回の
`enriched_*.json` と比較して差分レポートを生成します。対象リポジトリへのアクセスは不要です。

```bash
./scripts/docker-watch.sh \
  reports/MYAPP-main/scan_myapp_MYAP7C1A26061217.json \
  reports/MYAPP-main/enriched_myapp_MYAP7C1A26061217.json
```

出力は `watch/` サブディレクトリにまとまります。

```text
reports/
  MYAPP-main/
    watch/
      watch-enrich_myapp_MYAP7C1A.json    ← 再エンリッチ結果（固定名・毎回上書き）
      watch-diff_MYAP7C1A_260710.json     ← 差分データ（機械可読）
      watch-report_MYAP7C1A_260710.md     ← 差分レポート（人間向け）
```

検出する変化:

| 変化種別           | 判定条件                                             |
| ------------------ | ---------------------------------------------------- |
| `kev_added`        | CISA KEV（既知悪用脆弱性カタログ）に新規登録された   |
| `urgency_upgraded` | urgency が上昇した（deferred → planned → immediate） |
| `epss_risen`       | EPSS が 0.05 以上上昇、または 0.4 閾値をまたいだ     |
| `osv_updated`      | OSV の `modifiedAt` が更新された                     |
| `new_finding`      | ベースラインにない finding が新たに検出された        |
| `removed_finding`  | ベースラインにあった finding が消滅した              |

| オプション               | 説明                                                     |
| ------------------------ | -------------------------------------------------------- |
| `BASELINE_SCAN_JSON`     | ベーススキャンの `scan_*.json` ファイルパス（必須）      |
| `BASELINE_ENRICHED_JSON` | 前回の `enriched_*.json` ファイルパス（必須）            |
| `--output-dir DIR`       | 出力先ディレクトリ（省略時は `watch/` サブディレクトリ） |

環境変数:

| 変数           | 説明                                                           |
| -------------- | -------------------------------------------------------------- |
| `REPORTS_DIR`  | reports ルートディレクトリ（デフォルト: 入力ファイルの親の親） |
| `GITHUB_TOKEN` | エンリッチ時の PoC 検索に使用（任意）                          |

image は `./scripts/docker-build-watch.sh` で build します（`repo-sentry-watch:local`）。

### fixture を使った動作確認

```bash
deno run --allow-read --allow-write src/sentry-watch/cli.ts \
  fixtures/watch-test/enriched_baseline.json \
  fixtures/watch-test/enriched_changed.json \
  --output-dir fixtures/watch-test/
```

`fixtures/watch-test/` には全 changeType を網羅した合成テストデータが含まれています （`deno test` の
`watcher.test.ts` でも使用）。

---

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

**Clearwing の LLM 分析が遅い / 時間がかかりすぎる**

Ollama 使用時、Mac の Docker は Apple Silicon GPU（Metal）が使えないため CPU のみで推論します。
`qwen2.5:7b` で通常 20〜60 秒 / finding 程度です。 `standard` モード（既定）では critical / high /
medium を分析するため、medium の件数が多いと 時間がかかります。`--clearwing-depth=priority` で
critical / high のみに絞れます。

```bash
./scripts/docker-scan-clearwing.sh /path/to/target-repo --clearwing-depth=priority
```

速度を優先する場合は `CLEARWING_PROVIDER=openai` への切り替えも有効です（数秒 / finding）。

## 現在の実装状態

**sentry-scan（Phase 1）**: 完了

- Docker build / Docker scan
- Deno CLI
- gitleaks collector
- Trivy collector（ecosystem・purl・fixedVersions 付与）
- Dependabot alerts collector
- Clearwing collector（Ollama / OpenAI による LLM 分析）
- JSON reporter
- Markdown reporter
- CycloneDX SBOM 生成（デフォルト有効、`--no-sbom` で無効化）
- fixture ベースの tests

**sentry-enrich（Phase 2）**: 完了

- OSV データベース連携
- CISA KEV 連携（既知悪用脆弱性判定）
- EPSS スコア取得
- SBOM による direct/transitive 判定
- 参考 URL 検証（canonicalReference 生成・不正 URL 分離）

**sentry-report（Phase 3）**: Stable（実案件検証済み）

- ReportInput スキーマ・priorityScore 自動計算
- AI による ReportPlan 生成（OpenAI / Ollama）
- urgency 自動導出（KEV / CVSS / EPSS 由来）
- 推奨修正バージョン・エコシステム別修正コマンド自動生成
- Markdown レポート生成（AI 文章 + 機械データの分離）
- エグゼクティブサマリー事実検証（AI テキスト矛盾検出・フォールバック）
- canonicalReference 優先の参考 URL 表示

**sentry-export（PDF 生成）**: 動作確認済み

- report_*.md → PDF 変換（docker-export.sh）
- サマリー表・修正ガイド・優先度別の色分け

**docker-run.sh（一括実行）**: 完了

- scan → enrich → report の一括実行・SBOM 自動パススルー
- stdout にレポートパスのみ出力（パイプライン接続対応）・logs/ へのログ保存

**sentry-watch（MVP）**: 完了

- enrich 再実行 + 差分検出（KEV 新規登録 / urgency 上昇 / EPSS 上昇 / OSV 更新）
- new_finding / removed_finding 検出
- watch-diff.json / watch-report.md 生成
- Docker 実行環境（Dockerfile.watch + docker-watch.sh）
- fixture テスト（fixtures/watch-test/ + watcher.test.ts）

**GitHub Actions（P3-6 初期版）**: 実装済み

- security-scan workflow（workflow_dispatch + Artifacts）
- 動作確認手順: [docs/github-actions-test.md](docs/github-actions-test.md)

**GitHub Actions（P3-6）**: 完了（2026-07-11）

- `workflow_dispatch` による手動実行（対象リポジトリを入力）
- scan → enrich → report → PDF の一括実行
- Artifacts（zip）への成果物保存
- ワークフロー: `.github/workflows/security-scan.yml`

未実装または後続予定:

- sentry-watch: baseline 自動切り替え・Slack / Teams 通知
- ExploitDB 連携
- Slack reporter
- TruffleHog collector
- 複数 repository の一括実行
- GitHub Actions 次段階（定期実行 / Slack 通知 / PR コメント）

詳細な設計方針は [docs/tool-recommendations.md](docs/tool-recommendations.md) を参照してください。

## 開発者向け確認

```bash
deno fmt
deno check src/sentry-scan/cli.ts src/sentry-enrich/cli.ts src/sentry-report/cli.ts src/sentry-watch/cli.ts
deno lint
deno test
```
