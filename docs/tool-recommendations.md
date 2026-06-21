# GitHub リポジトリ自動チェックツール: 推奨方針

> **このドキュメントについて**: これは実装開始前に作成した設計メモです（Phase 1 着手以前）。
> 現在の実装状態・優先順位・フェーズ定義は [docs/phase.md](phase.md) および [README.md](../README.md) を
> 参照してください。
>
> **注意**: このドキュメントの「フェーズ 1〜4」は `phase.md` の「Phase 1/2/3」と**別の分類**です。
> 混同しないようにしてください。

---

## 目的

GitHub リポジトリを定期的にスキャンし、セキュリティ上の問題を検出して、レポートをファイルまたは
Slack に共有するツールを作成する。

## 推奨するプロダクト定義

既存のセキュリティツールを実行し、その結果を正規化してレポートを生成する **Deno + TypeScript
ベースのオーケストレーション CLI** とする。

- **主な出力:** JSON
- **補助的な出力:** Markdown、Slack
- **実行方法:** GitHub Actions の schedule、cron、または Docker ベースのバッチ実行

## 各ツールの推奨役割

| ツール     | 推奨する役割                                                      |
| ---------- | ----------------------------------------------------------------- |
| gitleaks   | 定期実行や PR 向けの高速なシークレット検査                        |
| TruffleHog | 履歴を含む重めのシークレット検査。定期フルスキャン向き            |
| Trivy      | 依存関係、コンテナ、設定の脆弱性検査                              |
| Dependabot | GitHub 上で生成された依存関係・セキュリティアラートの取得元       |
| Clearwing  | 明示許可された深掘り用の LLM 脆弱性探索。通常スキャンには含めない |
| shred      | 一時ファイルや中間成果物の安全な削除                              |

## 推奨する MVP

まずは次の範囲から始める。

1. **Deno + TypeScript 製 CLI**
2. **gitleaks + Trivy + Dependabot alerts API**
3. **JSON + Markdown 出力**
4. **ローカル実行 + GitHub Actions の定期実行**

後から追加するもの:

1. Slack 通知
2. TruffleHog による履歴込みフルスキャン
3. 複数リポジトリ対応
4. Clearwing による明示許可制の深掘りスキャン

## 推奨する CLI 形状

```bash
repo-sentry run --repo owner/name --format json --output ./reports/latest.json
repo-sentry run --repo owner/name --format markdown --output ./reports/latest.md
repo-sentry notify-slack --input ./reports/latest.json
```

## 推奨する実行入力

ここでいう「入力」は、機械学習のモデルではなく、**CLI に何を渡して 1 回のスキャンを定義するか**
という意味です。

要するに、1 回の実行で次を決められるようにします。

- 対象リポジトリは何か
- どのスキャナを使うか
- 差分スキャンかフルスキャンか
- 設定ファイルは何を使うか
- 認証情報はどこから渡すか

- `--repo owner/name` または `--path /local/repo`
- `--tools gitleaks,trivy,dependabot,trufflehog,clearwing`
- `--full` または `--since 7d`
- `--config ./scan-tools.config.json`
- GitHub token と Slack webhook は環境変数で渡す

Clearwing は高コストかつ dual-use な探索ツールなので、通常の `--tools all`
には含めない方針にします。 実行する場合は、明示的な指定とリスク確認を必須にします。

- `--tools clearwing`
- `--clearwing-depth quick|standard|deep`
- `--clearwing-budget 10`
- `--clearwing-timeout 60m`
- `--clearwing-ack-risk`

デフォルトでは、Clearwing の network scan、N-day exploit、reverse
engineering、operate、interactive、auto-patch、auto-pr は無効にします。

Docker 実行を前提にするなら、引数と環境変数の責務を分けると運用しやすいです。

- **引数:** スキャン対象、利用ツール、出力形式、出力先
- **環境変数:** `GITHUB_TOKEN`、`SLACK_WEBHOOK_URL` などの秘密情報
- **ボリューム:** レポート出力先やローカルリポジトリのマウント先

## 推奨する出力モデル

入力元ツールに関係なく、内部では 1 つの共通 Finding 形式に正規化する。

例:

```json
{
  "repository": "owner/name",
  "scannedAt": "2026-06-02T09:00:00Z",
  "summary": {
    "critical": 1,
    "high": 2,
    "medium": 5,
    "low": 3
  },
  "findings": [
    {
      "tool": "gitleaks",
      "category": "secret",
      "severity": "high",
      "title": "Possible GitHub token",
      "location": "src/config.ts:18",
      "status": "open"
    }
  ]
}
```

## Dependabot を Docker で動かせるか

結論として、**MVP では「Dependabot を Docker 内で実行する」のではなく、GitHub が生成した Dependabot
alerts を API 経由で取得する構成を推奨** します。

理由は次のとおりです。

1. Dependabot alerts は GitHub 側の機能として提供されており、CLI からは取得側の実装だけで足ります
2. Docker で自己実行したい要件がある場合でも、Dependabot そのものを自前運用するより、gitleaks や
   Trivy をコンテナ内で実行し、Dependabot は GitHub API 参照に分けた方が実装と運用が単純です
3. Dependabot の自前実行に近いものとして `dependabot-core` はありますが、MVP
   の前提としては重く、運用コストも上がります

そのため Docker ベースの実行イメージは、次のように考えるのが分かりやすいです。

- **Docker 内で実行するもの:** CLI 本体、gitleaks、Trivy、必要なら TruffleHog
- **Docker 外で提供されるもの:** GitHub Dependabot alerts、GitHub Security Advisory のデータ
- **CLI の役割:** GitHub API とローカルスキャナ結果をまとめて 1 つのレポートに正規化する

## Dependabot alerts の有効状態を診断する

Dependabot alerts API は、API を呼んだ時点で GitHub にスキャンを実行させるものではありません。
GitHub 側で dependency graph と Dependabot alerts が有効になっており、すでに生成されている alerts
を取得する API です。

そのため、Dependabot collector は alerts
の有無だけでなく、取得元の状態も診断してレポートに含めます。

推奨する確認順序:

1. `GET /repos/{owner}/{repo}` でリポジトリの存在、visibility、archived 状態、基本権限を確認する
2. `GET /repos/{owner}/{repo}/vulnerability-alerts` で dependency alerts の有効状態を確認する
3. `GET /repos/{owner}/{repo}/dependabot/alerts` で実際の alerts を取得する

`GET /repos/{owner}/{repo}/vulnerability-alerts` は、dependency alerts が有効なら `204`、無効なら
`404` を返します。 ただし GitHub API の `404`
は「存在しない」「権限がない」「機能が無効」が混ざることがあるため、単独で判断しないようにします。

レポートには、finding とは別に次のような source status を出します。

```json
{
  "tool": "dependabot",
  "sourceStatus": "enabled_no_alerts",
  "dependencyAlertsEnabled": true,
  "alertsApiAccessible": true,
  "notes": []
}
```

推奨する `sourceStatus`:

| 状態                  | 意味                                                                    |
| --------------------- | ----------------------------------------------------------------------- |
| `enabled_with_alerts` | Dependabot alerts が有効で、open/dismissed/fixed の alerts を取得できた |
| `enabled_no_alerts`   | Dependabot alerts が有効だが、対象条件に一致する alerts はない          |
| `disabled`            | dependency alerts が無効と判断できた                                    |
| `permission_missing`  | token 権限不足で有効状態または alerts を確認できない                    |
| `repo_archived`       | archived repository のため Dependabot alerts の期待値を下げる           |
| `unknown`             | GitHub API の応答だけでは状態を確定できない                             |

Dependabot の結果が 0 件の場合でも、`enabled_no_alerts` と `permission_missing`
は意味がまったく違います。 レポートでは必ず区別します。

## Clearwing の採用方針

Clearwing は gitleaks、Trivy、Dependabot alerts API と同じ扱いにはしません。

通常スキャン向けのツール:

- gitleaks: シークレット検査
- Trivy: 依存関係、コンテナ、IaC などの既知脆弱性検査
- Dependabot alerts API: GitHub 側で生成済みの依存関係 alerts の取得

深掘りスキャン向けのツール:

- TruffleHog: 履歴込みの重いシークレット検査
- Clearwing: LLM とツール実行を使ったソースコード脆弱性探索

Clearwing は、自分または組織が管理し、明示的に検査許可があるリポジトリにだけ実行します。
通常の定期実行や `--tools all` には含めず、明示的に指定されたときだけ実行します。

初期対応範囲:

- 許可: `clearwing sourcehunt`
- 許可: `--depth quick`
- 条件付き許可: `--depth standard`
- 原則禁止: `--depth deep`
- 原則禁止: `scan`, `parallel`, `operate`, `interactive`, `sourcehunt --nday`, `sourcehunt --reveng`
- 原則禁止: `--exploit`, `--auto-patch`, `--auto-pr`, `--export-disclosures`

`deep`、exploit、auto-patch、auto-pr、N-day、network scan を使いたい場合は、repo-sentry の通常 CLI
ではなく、別の明示的な承認フローを設けるべきです。

## Clearwing のリスクと対策

Clearwing は dual-use な offensive-security tool です。
対象が自分のリポジトリであっても、次のリスクを持ちます。

| リスク           | 内容                                                                                      | 推奨する対策                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| ソースコード流出 | private repository のコード、設計情報、脆弱性候補が LLM provider に送信される可能性がある | ローカル LLM または契約済み provider を使う。対象 repo を明示許可制にする        |
| secret 流出      | repo 内の token、鍵、設定値がプロンプト、ログ、成果物に残る可能性がある                   | Clearwing の前に gitleaks を実行する。成果物を private storage に限定する        |
| 成果物流出       | PoC、脆弱性説明、再現手順、攻撃条件が report として残る                                   | `results/` を公開しない。必要なら暗号化、保存期限、アクセス制御を設ける          |
| コード実行       | build、test、PoC、依存 package script が実行される可能性がある                            | read-only clone、rootless container、network 制限、CPU/memory/timeout 制限を使う |
| ネットワーク誤爆 | network scan 系の機能が意図しない対象へアクセスする可能性がある                           | repo-sentry からは `sourcehunt` のみ許可し、network scan 系を無効にする          |
| exploit 生成     | PoC や exploit に近い成果物が生成され、漏洩時の影響が大きい                               | exploit 系フラグをデフォルト禁止にする。必要時は追加承認を必須にする             |
| コスト暴走       | `standard` や `deep` は LLM token と実行時間を大きく消費する                              | `--clearwing-budget`、`--clearwing-timeout`、`--max-parallel` を必須にする       |
| 誤検知           | LLM がもっともらしいが誤った finding を生成する可能性がある                               | evidence level を保存し、低証拠 finding は fail 条件にしない                     |
| repo 改変        | auto-patch、auto-pr、write 系の動作でリポジトリに変更が入る可能性がある                   | repo-sentry では auto-patch、auto-pr を無効にする                                |
| 権限過多         | GitHub token、cloud credentials、package registry token が実行環境から読める可能性がある  | 最小権限 token を使い、Clearwing 実行環境には不要な env を渡さない               |

Clearwing の finding は、通常の既知脆弱性 scanner の finding と同じ信頼度で扱いません。 正規化時には
`confidence` と `evidenceLevel` を必ず保持します。

例:

```json
{
  "tool": "clearwing",
  "category": "code-vulnerability",
  "severity": "high",
  "confidence": "medium",
  "evidenceLevel": "static_corroboration",
  "title": "Potential path traversal",
  "location": "src/routes/files.ts:42",
  "status": "needs_review",
  "rawReportPath": "results/clearwing/sh-xxxx/report.json"
}
```

`evidenceLevel` が `suspicion` や `static_corroboration` の finding は、人間の確認前に release gate
失敗条件にしない方針とします。 `crash_reproduced`、`root_cause_explained`
以上は重要度を上げて扱いますが、それでも最終判断には人間のレビューを挟みます。

## 推奨するアーキテクチャ

エンジニア向けには、次のような **パイプライン型の CLI** として説明すると伝わりやすいです。

```text
[CLI / Scheduler]
        |
        v
[Scan Request]
  - repo
  - tools
  - scan mode
        |
        v
[Collectors]
  - gitleaks runner
  - trivy runner
  - dependabot alerts fetcher
  - trufflehog runner
  - clearwing runner
        |
        v
[Normalizer]
        |
        v
[Policy Engine]
  - severity threshold
  - ignore rules
  - exit code
        |
        v
[Reporters]
  - json
  - markdown
  - slack
```

実装上は、**「実行リクエストを受け取って、collector 群を走らせ、正規化し、policy 判定し、reporter
で出す」** という責務分割です。

### 1. CLI / Application Layer

実行エントリーポイントです。引数・設定ファイル・環境変数を解決し、1 回のスキャン要求を組み立てます。

担当すること:

- CLI 引数の解釈
- config のロード
- 実行対象の collector 選択
- 終了コードの返却

### 2. Collectors

各スキャナの実行、またはリモートアラートの取得を担当する。

- `gitleaks collector`: ローカルリポジトリや checkout 済みソースを検査
- `Trivy collector`: 依存関係、設定、必要に応じてコンテナイメージを検査
- `Dependabot collector`: GitHub API から alerts を取得
- `TruffleHog collector`: 履歴を含む重めのシークレット検査を実行
- `Clearwing collector`: 明示許可された場合のみ sourcehunt を実行し、JSON/SARIF/Markdown を取り込む

Docker 前提なら、collector は大きく 2 種類に分かれます。

- **process runner 型:** コンテナ内でコマンドを実行する collector
- **API client 型:** GitHub API を叩いて結果を取る collector

Clearwing collector は process runner 型ですが、通常の process runner より強い制限をかけます。

- read-only の一時 clone を使う
- 不要な環境変数を渡さない
- timeout と budget を必須にする
- network scan 系のサブコマンドを許可しない
- 成果物の保存先を明示し、公開ディレクトリに置かない

### 3. Normalizer

各ツールの生出力を、共通の `Finding` 形式に変換する。

実務上はここが重要で、後続の reporter や Slack 通知は raw JSON を知らなくてよくなります。

### 4. Policy Engine

重大度の閾値、無視ルール、終了コードの判定を扱う。

例:

- `high` 以上が 1 件でもあれば exit code 1
- `ignore` ルールに一致する finding は集計から除外
- 新規 finding のみ通知対象にする

### 5. Reporters

次の出力を生成する。

- JSON
- Markdown
- Slack メッセージ

reporter は `Finding[]` と summary だけを受け取り、collector
依存を持たない構成にすると差し替えやすいです。

### 6. Scheduler Adapter

次の実行環境を支える。

- GitHub Actions `schedule`
- cron
- Docker 実行

設計としては、scheduler は本体ロジックを持たず、**同じ CLI をどう起動するかだけを変える薄い層**
にしておくのが安全です。

## 推奨する技術スタック

### Deno + TypeScript

次の用途に最適。

- CLI の制御
- JSON の処理
- GitHub API 連携
- Slack 通知
- 将来の拡張
- Deno permission model による実行権限の明示
- `deno compile` による単一バイナリ化

### Bash

次の用途に使う。

- セットアップスクリプト
- CI 用ラッパー
- ローカル補助スクリプト

### Docker

次の目的で使う。

- スキャナのバージョン固定
- 定期実行の簡素化
- 実行環境の統一

## 推奨するリポジトリ構成

```text
src/
  cli.ts
  config.ts
  types.ts
  run-scan.ts
  collectors/
    gitleaks.ts
    trivy.ts
    dependabot.ts
    trufflehog.ts
    clearwing.ts
  reporters/
    json.ts
    markdown.ts
    slack.ts
  policy/
tests/
scripts/
Dockerfile
README.md
scan-tools.config.example.json
```

## 実装前に決めるべき項目

実装前に次を定義しておく。

1. 重大度レベル: `critical`, `high`, `medium`, `low`
2. 失敗条件: たとえば `high` 以上が 1 件でもあれば非 0 終了
3. 無視ルール: パス単位、finding 単位、期限付き例外
4. スキャン範囲: 作業ツリーのみか、Git 履歴全体を含むか
5. 通知ルール: 毎回通知するか、新規 finding のみ通知するか
6. Dependabot alerts が無効または権限不足だった場合の扱い
7. Clearwing を実行できる repo、depth、budget、timeout、成果物保存先
8. Clearwing の low-evidence finding を release gate に含めるかどうか

## 推奨するテスト方針

最初は実スキャナを使ったフル E2E ではなく、fixture ベースのテストから始める。

優先順位:

1. gitleaks の生出力 -> 正規化済み findings
2. Trivy の生出力 -> 正規化済み findings と summary
3. CLI 実行 -> 期待どおりの Markdown レポート
4. Dependabot の API 応答コード -> `sourceStatus`
5. Clearwing の JSON/SARIF fixture -> `confidence` と `evidenceLevel` 付き finding
6. Clearwing の危険フラグ指定 -> CLI が拒否すること

## 推奨する進め方

### フェーズ 1

- Deno + TypeScript CLI
- gitleaks + Trivy + Dependabot
- JSON / Markdown レポート
- GitHub Actions の定期実行

### フェーズ 2

- Slack 通知
- TruffleHog のフルスキャン
- より強い ignore / policy 制御
- Dependabot alerts 有効状態の診断表示

### フェーズ 3

- Clearwing の `sourcehunt --depth quick` 統合
- Clearwing findings の正規化
- budget、timeout、成果物保存ルール
- `--clearwing-ack-risk` による明示許可制

### フェーズ 4

- Clearwing `standard` depth の条件付き有効化
- SARIF 取り込み
- 人間レビュー前提の workflow
- 必要に応じたローカル LLM / self-hosted LLM 対応

## 最終的な推奨

もっとも安全な開始地点は次のとおり。

1. **Deno + TypeScript 製 CLI** を作る
2. **gitleaks、Trivy、Dependabot** の出力を正規化する
3. **JSON を正本** として扱う
4. **Markdown レポート** を生成する
5. **GitHub Actions の schedule** で定期実行する
6. Dependabot は alerts の件数だけでなく **有効状態と権限状態** を診断する
7. コアのレポート処理が安定してから **Slack** と **TruffleHog** を追加する
8. Clearwing は通常スキャンではなく、**明示許可された深掘りスキャン** として最後に追加する

## 参考資料

- GitHub Docs: Dependabot alerts REST API
  - https://docs.github.com/en/rest/dependabot/alerts
- GitHub Docs: Check if vulnerability alerts are enabled for a repository
  - https://docs.github.com/en/rest/repos/repos
- GitHub Docs: Code security configurations
  - https://docs.github.com/en/rest/code-security/configurations
- GitHub Docs: Supply chain security
  - https://docs.github.com/en/code-security/concepts/supply-chain-security/supply-chain-security
- Clearwing
  - https://github.com/Lazarus-AI/clearwing
