# repo-sentry ロードマップ

最終更新: 2026-06-19

---

## 全体構成

`repo-sentry` は3つのツールで構成されるモノレポ。

### ソースコード構成

```
repo-sentry/
  src/
    shared/           共通ユーティリティ（utils.ts 等）
    sentry-scan/      Phase 1 固有コード
      cli.ts
      run-scan.ts
      collectors/
      reporters/
    sentry-enrich/    Phase 2 固有コード
      main.ts
      enrichers/
      reporters/
    sentry-report/    Phase 3 固有コード
      main.ts
      reporters/
  Dockerfile.scan
  Dockerfile.enrich
  Dockerfile.report
  deno.json           ルートに1つ（Denoキャッシュ共有）
  docs/
  scripts/
    docker-scan.sh
    docker-scan-clearwing.sh
    docker-enrich.sh
    docker-report.sh
```

### 出力ファイル構成

全ツールの成果物を同じ `reports/{project}/` に出力する。
ファイル名の先頭でどのツールが生成したか判別できる。

```
reports/
  CRITTER_PRIVATE_API-master/
    scan_critter_A3F226041914_cw-std.md          sentry-scan（人間確認用）
    scan_critter_A3F226041914_cw-std.json        sentry-scan（機械可読）
    scan_critter_A3F226041914_cw-std.sbom.cdx.json
    enriched_critter_A3F226041914_cw-std.json    sentry-enrich
    report_critter_A3F226041914_cw-std.md        sentry-report
    report_critter_A3F226041914_cw-std.pdf
```

**ファイル名プレフィックス**

| プレフィックス | 生成ツール |
| --- | --- |
| `scan_` | sentry-scan |
| `enriched_` | sentry-enrich |
| `report_` | sentry-report |

### データフロー

```
リポジトリ
    │
    ▼
sentry-scan
    │
    ├─ scan_{id}_cw-std.json   （構造化スキャン結果）
    ├─ scan_{id}_cw-std.md     （人間確認用 Markdown）
    └─ scan_{id}_cw-std.sbom.cdx.json
         │
         ▼
    sentry-enrich
         │
         └─ enriched_{id}_cw-std.json（外部DB補強済みデータ）
              │
              ▼
         sentry-report
              │
              ├─ report_{id}_cw-std.md  （チーム向け報告書）
              └─ report_{id}_cw-std.pdf
```

### ツール名の意味

| ツール | 意味 |
| --- | --- |
| sentry | 歩哨・番兵（リポジトリを見張る） |
| sentry-scan | リポジトリをスキャンして脆弱性・機密情報を収集する |
| sentry-enrich | 外部DBで脆弱性情報を補強する |
| sentry-report | 収集・補強済みデータから報告書を生成する |

---

## Phase 1: sentry-scan

**目的**: 脆弱性の事実データを生成する。解釈・優先順位付けは行わない。

**進捗**: 約95%

### 実装済み

- Repository Scan
- Secret Scan（gitleaks）
- Dependency Scan（trivy）
- CycloneDX SBOM 生成
- Vulnerabilities / GHSA / CVE 取得
- CWE 取得（DB由来のみ、LLM生成禁止）
- 推奨バージョン・対応コマンド生成
- Scan metadata / status / DB更新日時
- Clearwing 分析（Category / Impact / Affected Features）
- JSON 出力・Markdown 出力
- ツールバージョン記録
- ファイル命名規則の統一

### 残タスク（優先度低）

- Direct / Transitive Dependency の区別（Phase 2 で SBOM から判定予定）

### 出力ファイル

```
reports/
  CRITTER_PRIVATE_API-master/
    scan_critter_A3F226041914_cw-std.md
    scan_critter_A3F226041914_cw-std.json
    scan_critter_A3F226041914_cw-std.sbom.cdx.json
```

**ファイル名の構成**

```
{prefix}_{short}_{HASH}{YYMMDDHH}[_{suffix}].{ext}

prefix : scan_（sentry-scan固有）
short  : プロジェクト名の最初のセグメント（小文字・12文字以内）
HASH   : プロジェクト名の sha256 頭4文字（大文字）
YYMMDDHH: 日時（時間単位）
suffix : cw-std / cw-pri / cw-vrb（Clearwing なしは省略）
```

### Clearwing 分析について

Clearwing は既存スキャン結果に構造化タグを付与する正規化エンジン。

出力項目:
- **Category**: RCE / XSS / SSRF / SQLi / DoS / Validation Bypass / Open Redirect / Auth Bypass / Info Disclosure / Command Injection / Header Injection / Path Traversal / Deserialization / Other
- **Impact**: 技術的影響のリスト
- **Affected Features**: 影響を受ける可能性のある機能・コンポーネント

**Conditions は Phase 1 では出力しない。** コード検索が必要なため Phase 2（sentry-enrich）の責務とする。

LLM: OpenAI（デフォルト）または Ollama を選択可能。

### 方針

- CWE は Trivy / GHSA / CVE ソース由来のみ。LLM による生成禁止。
- Markdown は人間確認用。提出用報告書ではない。
- 優先順位付け・リスク評価・経営向けサマリーは含めない。

---

## Phase 2: sentry-enrich

**目的**: Phase 1 の scan.json を外部脆弱性データベースで補強する。

**進捗**: 未着手

### 取得対象

| ソース | 取得内容 |
| --- | --- |
| OSV | 脆弱性詳細・影響バージョン・修正バージョン |
| GHSA | Advisory 詳細・References |
| CISA KEV | 実際に悪用されているか（既知悪用脆弱性判定） |
| EPSS | 今後悪用される可能性スコア |

将来候補: ExploitDB / Vendor Advisory / Packet Storm

### Conditions の実装

Phase 1 で収集できなかった「悪用に必要な条件」をコード検索で補完する。

### 入出力

```
入力: scan.json
出力: enriched.json
```

### LLM

OpenAI（デフォルト）または Ollama を選択可能（Phase 1 と同じ構成）。

---

## Phase 3: sentry-report

**目的**: 収集・補強済みデータを、リポジトリ管理チームが読める報告書に変換する。

**進捗**: 未着手

### 入出力

```
入力: scan.json + enriched.json
出力: report.md + report.pdf
```

### 報告書構成案

1. エグゼクティブサマリー（総評・リスク概要・推奨アクション）
2. スキャン対象（リポジトリ名・実施日時・使用ツール）
3. 検出サマリー（Critical / High / Medium / Low 件数）
4. 優先対応項目（即時対応推奨・修正理由・想定リスク）
5. 計画的対応項目（中長期対応・アップデート計画）
6. 後回し可能な項目（条件付き影響・Exploit 未確認等）
7. 修正ガイド（修正対象・推奨バージョン・修正コマンド）
8. 類似事例（実際のインシデント・Advisory・関連情報）
9. 全検出一覧

### AI 判断材料

Report AI が参照する情報:
- Severity / CVSS / EPSS / KEV
- Exploit 有無
- Affected Package / Installed Version / Fixed Version
- 利用機能（Affected Features）
- Production / Development Dependency

### LLM

OpenAI（デフォルト）または Ollama を選択可能（Phase 1・2 と同じ構成）。

---

## 開発優先順位

| 優先度 | 内容 |
| --- | --- |
| 1 | sentry-scan の残タスク（scanId・profile フィールド） |
| 2 | sentry-enrich: OSV / KEV / EPSS 連携 |
| 3 | sentry-enrich: Enriched JSON 設計 |
| 4 | sentry-report: Markdown 生成 |
| 5 | sentry-report: PDF 生成 |
| 6 | 運用改善（差分比較・履歴管理・Slack 通知・チケット自動起票） |
