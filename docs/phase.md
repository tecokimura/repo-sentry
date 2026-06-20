# repo-sentry ロードマップ

最終更新: 2026-06-20

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
      cli.ts
      enrichers/
      reporters/
    sentry-report/    Phase 3 固有コード
      cli.ts
      reporters/
  Dockerfile          sentry-scan 用
  Dockerfile.enrich   sentry-enrich 用
  Dockerfile.report   sentry-report 用（未実装）
  deno.json           ルートに1つ（Denoキャッシュ共有）
  docs/
  scripts/
    docker-build.sh           両 image を一括 build
    docker-build-scan.sh      sentry-scan image build
    docker-build-enrich.sh    sentry-enrich image build
    docker-scan.sh
    docker-scan-clearwing.sh
    docker-enrich.sh
    docker-report.sh          （未実装）
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

**進捗**: 完了

### 実装済み

- Repository Scan
- Secret Scan（gitleaks）
- Dependency Scan（trivy）
- CycloneDX SBOM 生成
- Vulnerabilities / GHSA / CVE 取得
- CWE 取得（DB由来のみ、LLM生成禁止）
- ecosystem / purl / fixedVersions フィールド生成
- 推奨バージョン・対応コマンド生成
- Scan metadata / status / DB更新日時
- Clearwing 分析（Category / Impact / Affected Features）
- JSON 出力・Markdown 出力
- ツールバージョン記録
- ファイル命名規則の統一

### 残タスク

なし（Direct / Transitive 判定は Phase 2 で SBOM から取得）

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

**進捗**: 実装中（約60〜70%）

### 実装済み

| ソース | 取得内容 | 備考 |
| --- | --- | --- |
| OSV | 脆弱性詳細・aliases・summary | `GET /v1/vulns/{id}` |
| CISA KEV | 実際に悪用されているか（既知悪用脆弱性判定） | `dateAdded` / `requiredAction` 等 |
| EPSS | 今後悪用される可能性スコア（0.0〜1.0） | FIRST API、CVE のみ対象 |
| SBOM | direct / transitive 判定 | `--sbom` オプションで指定 |

### 残タスク

| 内容 | 優先度 |
| --- | --- |
| ExploitDB 連携 | 中 |
| Conditions（悪用に必要な条件のコード検索） | 低 |

### 入出力

```
入力: scan_{short}_{HASH}{YYMMDDHH}.json
出力: enriched_{short}_{HASH}{YYMMDDHH}.json（同ディレクトリ）
```

### EnrichedFinding の追加フィールド

```typescript
{
  dependencyType?: "direct" | "transitive";
  osv?: { id, aliases, summary, publishedAt, modifiedAt };
  kev?: { cveId, vendorProject, product, dateAdded, requiredAction, dueDate };
  epss?: { cve, epss, percentile, date };
}
```

### LLM

Phase 2 では LLM を使用しない。外部 DB のみで補強する。

---

## Phase 3: sentry-report

### 目的

enriched.json をもとに、開発チームが対応判断できる Markdown レポートを生成する。

**進捗**: ReportInput・ReportPlan スキーマ設計完了・Markdown 生成実装中

### 入力

- `enriched_{short}_{HASH}{YYMMDDHH}.json`

### 内部処理

1. `enriched.json` を `ReportInput` に変換（`transformer.ts`）
2. `ReportInput` をもとに AI が `ReportPlan` JSON を生成（`planner.ts`）
3. `ReportPlan` と `ReportInput` を Markdown Renderer に渡す（`renderers/markdown.ts`）
4. `report.md` を生成

### 出力

通常:

```
report_{short}_{HASH}{YYMMDDHH}-plan.json   ← AI 生成（監査・再利用可能）
report_{short}_{HASH}{YYMMDDHH}.md          ← Renderer 生成
```

`--debug` 時のみ:

```
report_{short}_{HASH}{YYMMDDHH}-input.json  ← ReportInput（検証用）
```

### 責務分離

AI が担当するもの:

- `executiveSummary`（総評）
- `immediateActions` の `reason` / `notes`
- `plannedActions` の `reason` / `notes`
- `deferredItems` の `deferReason`
- `notableRisks`

AI が担当しないもの（Renderer が ReportInput から直接出力）:

- CVE / GHSA 一覧
- パッケージ名・バージョン
- 修正バージョン・修正コマンド
- EPSS / KEV スコア
- CWE
- 付録の全 Finding 一覧

### ReportInput スキーマ（固定版）

`src/sentry-report/types.ts` にて定義。`buildReportInput()` で EnrichedReport → ReportInput に変換。

```typescript
interface ReportInput {
  reportInputVersion: "1";
  scanId: string;
  enrichId?: string;
  profile: string;
  repository?: string;
  scannedAt: string;
  summary: ReportSummary;   // total / critical / high / medium / low / immediate / kevCount / epssHighCount
  findings: ReportFinding[]; // priorityScore 降順ソート済み
}

interface ReportFinding {
  findingId?: string;
  tool: string;
  category: string;
  package?: {
    ecosystem: string;
    name: string;
    version: string;
    purl: string;
    dependencyType?: "direct" | "transitive";
  };
  riskSignals: {
    severity: string;
    epss?: number;           // 0.0–1.0
    epssPercentile?: number;
    kev: boolean;
    hasFixedVersion: boolean;
    priorityScore: number;   // 0–100 自動計算
  };
  recommendedAction: {
    action: "upgrade" | "mitigate" | "monitor" | "accept";
    urgency: "immediate" | "planned" | "deferred";
    fixAvailable: boolean;
    fixedVersions?: string[];
    command?: string;
  };
  context: {
    title: string;
    description?: string;
    location?: string;
    cweIds?: string[];
    url?: string;
    osvSummary?: string;
    osvAliases?: string[];
    kevDateAdded?: string;
    kevRequiredAction?: string;
    attackCategory?: string;      // Clearwing 由来
    impact?: string[];            // Clearwing 由来
    affectedFeatures?: string[];  // Clearwing 由来
    analysisSource?: "clearwing";
  };
}
```

### priorityScore 計算式

| 要素 | 加算 |
| --- | --- |
| critical | +40 |
| high | +25 |
| medium | +15 |
| low | +5 |
| kev=true | +40（実悪用確認済み） |
| epss ≥ 0.9 | +20 |
| epss ≥ 0.7 | +10 |
| epss ≥ 0.4 | +5 |
| direct 依存 | +5 |
| 上限 | 100 |

### urgency 導出ルール

| 条件 | urgency |
| --- | --- |
| kev=true | `immediate` |
| severity=critical | `immediate` |
| severity=high, または medium && epss≥0.4 | `planned` |
| それ以外 | `deferred` |

### ReportPlan v1

```typescript
interface ReportPlan {
  planVersion: "1";
  overallRisk: "critical" | "high" | "medium" | "low";
  executiveSummary: string;
  immediateActions: PlanAction[];
  plannedActions: PlanAction[];
  deferredItems: PlanDeferral[];
  notableRisks: NotableRisk[];
}

interface PlanAction {
  findingId?: string;
  title: string;
  reason: string;   // なぜ対応すべきか（AI が記述）
  notes?: string;   // アップグレード時の注意など（任意）
}

interface PlanDeferral {
  findingId?: string;
  title: string;
  deferReason: string;
}

interface NotableRisk {
  title: string;
  description: string;
}
```

### Markdown 構成

1. エグゼクティブサマリー（ReportPlan）
2. スキャン概要（ReportInput）
3. 即時対応項目（urgency=immediate）
4. 計画対応項目（urgency=planned）
5. 後回し可能項目（urgency=deferred）
6. 修正ガイド（fixAvailable=true の一覧）
7. 付録: 全 Finding 一覧

### LLM

OpenAI（デフォルト）または Ollama を選択可能（Phase 1・2 と同じ構成）。

---

## 開発優先順位

| 優先度 | 内容 | 状態 |
| --- | --- | --- |
| 1 | sentry-scan: ecosystem / purl / fixedVersions | 完了 |
| 2 | sentry-enrich: OSV / KEV / EPSS 連携 | 完了 |
| 3 | sentry-enrich: ExploitDB 連携 | 未着手 |
| 4 | sentry-report: ReportInput / ReportPlan スキーマ設計 | 完了 |
| 5 | sentry-report: Markdown 生成・Docker 実行環境 | 実装中 |
| 6 | sentry-export: PDF 生成（別ツールとして分離） | 未着手 |
| 6 | 運用改善（差分比較・履歴管理・Slack 通知・チケット自動起票） | 未着手 |
