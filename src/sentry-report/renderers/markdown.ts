import type { ReportPlan, PlanAction, PlanDeferral } from "../plan.ts";
import type { ReportInput, ReportFinding } from "../types.ts";

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
  lines.push(plan.executiveSummary);
  lines.push("");

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
  const fixable = input.findings.filter((f) => f.recommendedAction.fixAvailable);
  if (fixable.length > 0) {
    lines.push("## 修正ガイド");
    lines.push("");
    lines.push("| パッケージ | 現在バージョン | 修正バージョン | 修正コマンド |");
    lines.push("| --- | --- | --- | --- |");
    const seen = new Set<string>();
    for (const f of fixable) {
      const key = `${f.package?.name ?? ""}@${f.package?.version ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pkg = f.package?.name ?? "—";
      const cur = f.package?.version ?? "—";
      const fixed = f.recommendedAction.fixedVersions?.join(", ") ?? "—";
      const cmd = f.recommendedAction.command ? `\`${escMd(f.recommendedAction.command)}\`` : "—";
      lines.push(`| ${escMd(pkg)} | ${escMd(cur)} | ${escMd(fixed)} | ${cmd} |`);
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
  immediate: ["後回し", "計画的"],
  planned:   ["後回しでよい", "後回しで良い"],
  deferred:  ["計画的に対応", "即時", "直ちに対応"],
};

function sanitizeReason(
  text: string,
  section: "immediate" | "planned" | "deferred",
  findingId?: string,
): string {
  const contradicts = CONTRADICTION_PATTERNS[section].some((p) => text.includes(p));
  if (contradicts) {
    console.error(
      `[sentry-report] warning: ${findingId ?? "?"} の reason が ${section} セクションと矛盾するためデフォルト文に置き換えました`,
    );
    return FALLBACK_REASON[section];
  }
  return text;
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
    const rawText = "deferReason" in planItem ? planItem.deferReason : planItem.reason;
    const text = sanitizeReason(rawText, "deferred", f.findingId);
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
  if (f.recommendedAction.fixedVersions?.length) {
    rows.push(["修正バージョン", f.recommendedAction.fixedVersions.join(", ")]);
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
