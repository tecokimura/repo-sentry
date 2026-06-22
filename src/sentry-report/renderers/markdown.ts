import type { ReportPlan, PlanAction, PlanDeferral } from "../plan.ts";
import type { ReportInput, ReportFinding, ReportSummary } from "../types.ts";
import { filterAvailableVersions, parseSemVer, cmpSemVer } from "../semver.ts";

function semverGt(a: string, b: string): boolean {
  const pa = parseSemVer(a);
  const pb = parseSemVer(b);
  if (!pa || !pb) return a > b;
  return cmpSemVer(pa, pb) > 0;
}

export function renderMarkdownReport(plan: ReportPlan, input: ReportInput): string {
  const lines: string[] = [];
  const scanDate = input.scannedAt.slice(0, 16).replace("T", " ");
  // AI reason / notes を findingId で引けるよう平坦化
  const planLookup = buildPlanLookup(plan);

  // 表示グループは ReportInput.urgency を正規分類として使用
  const immediateFindings = input.findings.filter((f) => f.recommendedAction.urgency === "immediate");
  const plannedFindings   = input.findings.filter((f) => f.recommendedAction.urgency === "planned");
  const deferredFindings  = input.findings.filter((f) => f.recommendedAction.urgency === "deferred");

  // AI plan と urgency のズレを警告（後で参照するため先に収集）
  warnUrgencyMismatch(plan, input, planLookup);

  // Title
  const title = input.repository
    ? `セキュリティスキャンレポート: ${input.repository}`
    : "セキュリティスキャンレポート";
  lines.push(`# ${title}`);
  lines.push("");

  // 1. Executive Summary
  lines.push("## エグゼクティブサマリー");
  lines.push("");
  lines.push(`**総合リスク評価: ${riskLabel(plan.overallRisk)}**`);
  lines.push("");
  // 決定論的な事実文（Renderer生成）
  lines.push(buildSummaryOpening(input.summary, immediateFindings.length));
  lines.push("");
  // AI の executiveSummary は補足文として使用（問題のある文を除外し残りを表示）
  if (plan.executiveSummary) {
    const { cleaned, removedCount } = sanitizeImmediateExpressions(
      plan.executiveSummary, immediateFindings.length,
    );
    if (removedCount > 0) {
      console.error(
        `[sentry-report] warning: executiveSummary から即時対応の表現を ${removedCount} 文除外しました（immediate=0）`,
      );
    }
    const summaryText = cleaned.trim();
    if (summaryText) {
      const conflicts = detectSummaryConflicts(summaryText, input.summary, plannedFindings.length);
      if (conflicts.length > 0) {
        for (const c of conflicts) {
          console.error(`[sentry-report] warning: executiveSummary が summaryFacts と矛盾: ${c}`);
        }
        console.error("[sentry-report] warning: executiveSummary の表示をスキップしました（決定論的な冒頭文を使用）");
      } else {
        lines.push(summaryText);
        lines.push("");
      }
    }
  }

  if (plan.notableRisks.length > 0) {
    for (const risk of plan.notableRisks) {
      lines.push(`> **${escMd(risk.title)}**: ${escMd(risk.description)}`);
    }
    lines.push("");
  }

  // 2. Scan Overview
  lines.push("## スキャン概要");
  lines.push("");
  lines.push("| | |");
  lines.push("| --- | --- |");
  lines.push(`| スキャン日時 | ${scanDate} (UTC) |`);
  if (input.repository) lines.push(`| 対象リポジトリ | ${escMd(input.repository)} |`);
  lines.push(`| 検出総数 | ${input.summary.total} 件 |`);
  lines.push(`| Critical | ${input.summary.critical} |`);
  lines.push(`| High | ${input.summary.high} |`);
  lines.push(`| Medium | ${input.summary.medium} |`);
  lines.push(`| Low | ${input.summary.low} |`);
  if (input.summary.kevCount > 0) {
    lines.push(`| KEV（実悪用確認） | **${input.summary.kevCount} 件** |`);
  }
  if (input.summary.epssHighCount > 0) {
    lines.push(`| EPSS ≥ 70% | ${input.summary.epssHighCount} 件 |`);
  }
  // 即時対応は正規化後の件数（ReportInput.urgency ベース）
  lines.push(`| 即時対応が必要 | **${immediateFindings.length} 件** |`);
  lines.push("");

  // 3. Immediate Actions（ReportInput urgency=immediate が権威）
  if (immediateFindings.length > 0) {
    lines.push("## 即時対応項目");
    lines.push("");
    for (const f of immediateFindings) {
      lines.push(...renderFindingWithPlan(f, planLookup, "immediate"));
    }
  }

  // 4. Planned Actions（ReportInput urgency=planned が権威）
  if (plannedFindings.length > 0) {
    lines.push("## 計画対応項目");
    lines.push("");
    for (const f of plannedFindings) {
      lines.push(...renderFindingWithPlan(f, planLookup, "planned"));
    }
  }

  // 5. Deferred Items（ReportInput urgency=deferred が権威）
  if (deferredFindings.length > 0) {
    lines.push("## 後回し可能項目");
    lines.push("");
    for (const f of deferredFindings) {
      lines.push(...renderFindingWithPlan(f, planLookup, "deferred"));
    }
  }

  // 6. Fix Guide
  // 同パッケージに複数の CVE がある場合、最大の recommendedVersion を採用する
  const fixable = input.findings.filter((f) => f.recommendedAction.fixAvailable);
  if (fixable.length > 0) {
    lines.push("## 修正ガイド");
    lines.push("");
    lines.push("| パッケージ | 現在バージョン | 推奨バージョン | 修正コマンド |");
    lines.push("| --- | --- | --- | --- |");
    const fixMap = new Map<string, { pkg: string; cur: string; rec: string; cmd: string }>();
    for (const f of fixable) {
      const key = `${f.package?.name ?? ""}@${f.package?.version ?? ""}`;
      const pkg = f.package?.name ?? "—";
      const cur = f.package?.version ?? "—";
      const rec = f.recommendedAction.recommendedVersion ?? "";
      const rawCmd = f.recommendedAction.fixCommand ?? f.recommendedAction.command ?? "";
      if (!fixMap.has(key)) {
        fixMap.set(key, { pkg, cur, rec, cmd: rawCmd });
      } else if (rec && semverGt(rec, fixMap.get(key)!.rec)) {
        fixMap.set(key, { pkg, cur, rec, cmd: rawCmd });
      }
    }
    for (const { pkg, cur, rec, cmd } of fixMap.values()) {
      const recDisplay = rec || "—";
      const cmdDisplay = cmd ? `\`${escMd(cmd)}\`` : "—";
      lines.push(`| ${escMd(pkg)} | ${escMd(cur)} | ${escMd(recDisplay)} | ${cmdDisplay} |`);
    }
    lines.push("");
  }

  // 7. Appendix
  lines.push("## 付録: 全 Finding 一覧");
  lines.push("");
  lines.push("| ID | パッケージ | 重大度 | EPSS | KEV | 対応 | urgency |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const f of input.findings) {
    const id = f.findingId ?? "—";
    const pkg = f.package ? `${f.package.name}@${f.package.version}` : f.context.location ?? "—";
    const sev = f.riskSignals.severity;
    const epss = f.riskSignals.epss != null ? `${(f.riskSignals.epss * 100).toFixed(1)}%` : "—";
    const kev = f.riskSignals.kev ? "✓" : "—";
    const action = f.recommendedAction.action;
    const urgency = f.recommendedAction.urgency;
    lines.push(
      `| ${escMd(id)} | ${escMd(pkg)} | ${sev} | ${epss} | ${kev} | ${action} | ${urgency} |`,
    );
  }
  lines.push("");

  return lines.join("\n") + "\n";
}

const FALLBACK_REASON = {
  immediate: "悪用状況または重大度を踏まえ、優先的に確認・対応してください。",
  planned:   "修正版が提供されているため、通常のアップデート計画に組み込んで対応してください。",
  deferred:  "現時点では即時対応条件には該当しないため、他の高優先度項目の対応後に確認してください。",
} as const;

const CONTRADICTION_PATTERNS: Record<"immediate" | "planned" | "deferred", string[]> = {
  immediate: ["後回しでよい", "後回しで良い", "後回しにしてください", "後回しで対応", "計画的に対応"],
  planned:   ["後回しでよい", "後回しで良い", "後回しで対応", "後回しでも", "直ちに対応が必要", "即時対応が必要", "直ちに修正", "緊急の対応が必要"],
  deferred:  ["即時対応が必要", "直ちに対応が必要", "早急に対応", "今すぐ対応", "緊急の対応が必要", "緊急対応が必要"],
};

function sanitizeReason(
  text: string | undefined,
  section: "immediate" | "planned" | "deferred",
  findingId?: string,
): string {
  if (!text) return FALLBACK_REASON[section];
  const contradicts = CONTRADICTION_PATTERNS[section].some((p) => text.includes(p));
  if (contradicts) {
    console.error(
      `[sentry-report] warning: ${findingId ?? "?"} の reason が ${section} セクションと矛盾するためデフォルト文に置き換えました`,
    );
    return FALLBACK_REASON[section];
  }
  return text;
}

// deferred 理由を ReportFinding のデータから決定論的に生成（AI に委ねない）
function buildDeferReason(f: ReportFinding): string {
  const kev  = f.riskSignals.kev;
  const epss = f.riskSignals.epss;
  const sev  = f.riskSignals.severity?.toLowerCase();
  const dep  = f.package?.dependencyType;
  const feat = f.context.affectedFeatures;
  const pkg  = f.package?.name ?? f.context.title;

  if (!kev && (epss === undefined || epss < 0.01)) {
    return `${pkg} は KEV 未登録かつ悪用可能性が低いため後回し可能。`;
  }
  if (dep === "transitive") {
    return `${pkg} は transitive 依存のため影響が間接的であり後回し可能。`;
  }
  if (feat && feat.length > 0) {
    return `${pkg} は影響範囲が ${feat.join("・")} に限定されるため後回し可能。`;
  }
  if (sev === "low" || sev === "unknown") {
    return `${pkg} は severity が ${sev} であり即時対応条件に該当しないため後回し可能。`;
  }
  return `${pkg} は修正版が提供されているが critical・KEV の即時対応条件には該当しないため後回し可能。`;
}

// finding を planLookup の AI テキストで補完してレンダー（セクション整合性チェック付き）
function renderFindingWithPlan(
  f: ReportFinding,
  planLookup: Map<string, PlanAction | PlanDeferral>,
  section: "immediate" | "planned" | "deferred",
): string[] {
  const planItem = f.findingId ? planLookup.get(f.findingId) : undefined;
  if (!planItem) return renderFindingFallback(f);

  if (section === "deferred") {
    const text = buildDeferReason(f);
    return renderDeferralSection({ findingId: planItem.findingId, title: planItem.title, deferReason: text }, f);
  } else {
    const rawText = "reason" in planItem ? planItem.reason : planItem.deferReason;
    const notes = "notes" in planItem ? (planItem as PlanAction).notes : undefined;
    const text = sanitizeReason(rawText, section, f.findingId);
    return renderActionSection({ findingId: planItem.findingId, title: planItem.title, reason: text, notes }, f);
  }
}

function renderActionSection(action: PlanAction, f: ReportFinding | undefined): string[] {
  const lines: string[] = [];
  const heading = f?.findingId ? `${f.findingId} — ${escMd(action.title)}` : escMd(action.title);
  lines.push(`### ${heading}`);
  lines.push("");
  lines.push(action.reason);
  if (action.notes) {
    lines.push("");
    lines.push(`> ${escMd(action.notes)}`);
  }
  if (f) lines.push(...renderFindingTable(f));
  lines.push("");
  return lines;
}

function renderDeferralSection(item: PlanDeferral, f: ReportFinding | undefined): string[] {
  const lines: string[] = [];
  const heading = f?.findingId ? `${f.findingId} — ${escMd(item.title)}` : escMd(item.title);
  lines.push(`### ${heading}`);
  lines.push("");
  lines.push(`後回し理由: ${item.deferReason}`);
  if (f) lines.push(...renderFindingTable(f));
  lines.push("");
  return lines;
}

function renderFindingFallback(f: ReportFinding): string[] {
  const lines: string[] = [];
  const heading = f.findingId
    ? `${f.findingId} — ${escMd(f.context.title)}`
    : escMd(f.context.title);
  lines.push(`### ${heading}`);
  lines.push("");
  const urgency = f.recommendedAction.urgency ?? "deferred";
  lines.push(FALLBACK_REASON[urgency]);
  lines.push(...renderFindingTable(f));
  lines.push("");
  return lines;
}

function renderFindingTable(f: ReportFinding): string[] {
  const rows: [string, string][] = [];
  if (f.package) {
    rows.push(["パッケージ", `${f.package.name}`]);
    rows.push(["現在バージョン", f.package.version]);
    if (f.package.purl) rows.push(["PURL", f.package.purl]);
  }
  if (f.recommendedAction.recommendedVersion) {
    rows.push(["推奨修正版", `**${f.recommendedAction.recommendedVersion}**`]);
  }
  if (f.recommendedAction.fixedVersions?.length) {
    const available = filterAvailableVersions(
      f.recommendedAction.fixedVersions,
      f.package?.version,
    );
    if (available.length > 0) {
      rows.push(["利用可能", available.join(", ")]);
    }
  }
  if (f.riskSignals.epss != null) {
    rows.push(["EPSS", `${(f.riskSignals.epss * 100).toFixed(1)}% (${
      f.riskSignals.epssPercentile != null
        ? `${(f.riskSignals.epssPercentile * 100).toFixed(1)}パーセンタイル`
        : ""
    })`]);
  }
  if (f.riskSignals.kev) {
    rows.push(["KEV", `悪用確認済み${f.context.kevDateAdded ? ` (${f.context.kevDateAdded})` : ""}`]);
  }
  if (f.context.poc) {
    const { confidence, sources } = f.context.poc;
    const badge = confidence === "high" ? "⚠ 高信頼度" : confidence === "medium" ? "中信頼度" : "低信頼度";
    rows.push(["PoC", `公開済み [${badge}] (${sources.length} 件)`]);
    for (const s of sources) {
      rows.push(["", s.url]);
    }
  }
  if (f.context.cweIds?.length) rows.push(["CWE", f.context.cweIds.join(", ")]);
  if (f.context.url) rows.push(["参考", f.context.url]);

  if (rows.length === 0) return [];

  return [
    "",
    "| | |",
    "| --- | --- |",
    ...rows.map(([k, v]) => `| ${k} | ${escMd(v)} |`),
  ];
}

// findingId → plan item（immediate > planned > deferred 優先、重複は最初のみ）
function buildPlanLookup(plan: ReportPlan): Map<string, PlanAction | PlanDeferral> {
  const map = new Map<string, PlanAction | PlanDeferral>();
  for (const a of [...plan.immediateActions, ...plan.plannedActions]) {
    if (a.findingId && !map.has(a.findingId)) map.set(a.findingId, a);
  }
  for (const d of plan.deferredItems) {
    if (d.findingId && !map.has(d.findingId)) map.set(d.findingId, d);
  }
  return map;
}

// AI plan の urgency 分類と ReportInput urgency のズレを stderr に出力
function warnUrgencyMismatch(
  plan: ReportPlan,
  input: ReportInput,
  planLookup: Map<string, PlanAction | PlanDeferral>,
): void {
  const urgencyMap = new Map<string, "immediate" | "planned" | "deferred">();
  for (const f of input.findings) {
    if (f.findingId) urgencyMap.set(f.findingId, f.recommendedAction.urgency);
  }

  const check = (section: "immediate" | "planned" | "deferred", ids: (string | undefined)[]) => {
    for (const id of ids) {
      if (!id) continue;
      const actual = urgencyMap.get(id);
      if (actual && actual !== section) {
        console.error(
          `[sentry-report] warning: ${id} は AI plan で ${section} 分類ですが urgency=${actual} のため ${actual === "immediate" ? "即時対応" : actual === "planned" ? "計画対応" : "後回し"} に表示します`,
        );
      }
    }
  };
  check("immediate", plan.immediateActions.map((a) => a.findingId));
  check("planned",   plan.plannedActions.map((a) => a.findingId));
  check("deferred",  plan.deferredItems.map((d) => d.findingId));
}

function buildSummaryOpening(summary: ReportSummary, immediateCount: number): string {
  const { critical, high, medium, low, kevCount, epssHighCount } = summary;

  if (critical > 0 && kevCount > 0) {
    return `今回のスキャンでは Critical の脆弱性が ${critical} 件検出され、うち ${kevCount} 件が KEV（実悪用確認済み）に登録されています。即時対応が必要な項目が ${immediateCount} 件あります。`;
  }
  if (critical > 0) {
    return `今回のスキャンでは Critical の脆弱性が ${critical} 件検出されました。即時対応対象は ${immediateCount} 件です。`;
  }
  if (high > 0 && kevCount > 0) {
    return `今回のスキャンでは High の脆弱性が ${high} 件、うち ${kevCount} 件が KEV（実悪用確認済み）に登録されています。即時対応が必要な項目が ${immediateCount} 件あります。`;
  }
  if (high > 0) {
    return `今回のスキャンでは High の脆弱性が ${high} 件検出されました。Critical / KEV には該当しないため即時対応対象は ${immediateCount} 件ですが、計画的な対応を推奨します。${epssHighCount > 0 ? ` なお EPSS ≥ 70% の脆弱性が ${epssHighCount} 件含まれます。` : ""}`;
  }
  if (medium > 0 || low > 0) {
    return `今回のスキャンでは Critical / High の脆弱性は検出されませんでした。Medium が ${medium} 件${low > 0 ? `、Low が ${low} 件` : ""}確認されており、通常の更新サイクルでの対応を推奨します。`;
  }
  return "今回のスキャンでは脆弱性は検出されませんでした。";
}

type SummaryConflict = string;

// immediate=0 のとき即時対応を示唆する文を句点単位で除外する
function sanitizeImmediateExpressions(
  text: string,
  immediateCount: number,
): { cleaned: string; removedCount: number } {
  if (immediateCount > 0) return { cleaned: text, removedCount: 0 };

  const patterns = [
    "即時対応", "緊急対応", "直ちに対応", "早急に対応",
    "優先的に対応", "至急対応", "直ちに修正", "早急な対応", "緊急な対応",
  ];

  const parts = text.split("。");
  const kept: string[] = [];
  let removedCount = 0;

  for (const part of parts) {
    if (!part.trim()) {
      kept.push(part);
      continue;
    }
    if (patterns.some((p) => part.includes(p))) {
      removedCount++;
    } else {
      kept.push(part);
    }
  }

  return { cleaned: kept.join("。"), removedCount };
}

function detectSummaryConflicts(text: string, summary: ReportSummary, plannedCount: number): SummaryConflict[] {
  const conflicts: SummaryConflict[] = [];
  const highOrAbove = summary.high + summary.critical;

  if (highOrAbove > 0) {
    const negations = [
      "高リスクの脆弱性は見られません",
      "高リスクなし",
      "高リスクは確認されません",
      "高リスクは見られません",
      "高い脆弱性はありません",
      "高リスクの脆弱性は見つかりません",
      "高リスクの脆弱性は検出されません",
    ];
    if (negations.some((p) => text.includes(p))) {
      conflicts.push(`high=${summary.high}/critical=${summary.critical} なのに高リスク否定表現あり`);
    }
  }

  if (plannedCount > 0) {
    const allDeferredPatterns = [
      "すべて後回し",
      "全て後回し",
      "すべて後回しで",
      "すべてdeferred",
    ];
    if (allDeferredPatterns.some((p) => text.includes(p))) {
      conflicts.push(`planned=${plannedCount} なのに「すべて後回し」表現あり`);
    }
  }

  if (summary.critical === 0) {
    const criticalAffirm = ["Critical が存在", "Critical が検出", "Criticalが存在", "クリティカルな脆弱性が存在"];
    if (criticalAffirm.some((p) => text.includes(p))) {
      conflicts.push("critical=0 なのに Critical 存在の表現あり");
    }
  }

  if (summary.kevCount === 0) {
    const kevAffirm = ["悪用確認済み", "KEVに登録", "実際に悪用されており", "既に悪用"];
    if (kevAffirm.some((p) => text.includes(p))) {
      conflicts.push("kev=0 なのに悪用確認済みの表現あり");
    }
  }

  return conflicts;
}

function riskLabel(risk: string): string {
  switch (risk) {
    case "critical": return "🔴 Critical";
    case "high":     return "🟠 High";
    case "medium":   return "🟡 Medium";
    default:         return "🟢 Low";
  }
}

function escMd(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
