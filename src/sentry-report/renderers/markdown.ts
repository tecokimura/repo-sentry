import type { ReportPlan, PlanAction, PlanDeferral } from "../plan.ts";
import type { ReportInput, ReportFinding } from "../types.ts";

export function renderMarkdownReport(plan: ReportPlan, input: ReportInput): string {
  const lines: string[] = [];
  const scanDate = input.scannedAt.slice(0, 16).replace("T", " ");
  const findingMap = buildFindingMap(input);

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
  lines.push(`| 即時対応が必要 | **${input.summary.immediate} 件** |`);
  lines.push("");

  // 3. Immediate Actions
  const immediateFindings = input.findings.filter((f) => f.recommendedAction.urgency === "immediate");
  if (immediateFindings.length > 0) {
    lines.push("## 即時対応項目");
    lines.push("");
    for (const action of plan.immediateActions) {
      const f = action.findingId ? findingMap.get(action.findingId) : undefined;
      lines.push(...renderActionSection(action, f));
    }
    // plan に含まれない immediate finding を補完
    for (const f of immediateFindings) {
      if (!plan.immediateActions.some((a) => a.findingId === f.findingId)) {
        lines.push(...renderFindingFallback(f));
      }
    }
  }

  // 4. Planned Actions
  const plannedFindings = input.findings.filter((f) => f.recommendedAction.urgency === "planned");
  if (plannedFindings.length > 0) {
    lines.push("## 計画対応項目");
    lines.push("");
    for (const action of plan.plannedActions) {
      const f = action.findingId ? findingMap.get(action.findingId) : undefined;
      lines.push(...renderActionSection(action, f));
    }
    for (const f of plannedFindings) {
      if (!plan.plannedActions.some((a) => a.findingId === f.findingId)) {
        lines.push(...renderFindingFallback(f));
      }
    }
  }

  // 5. Deferred Items
  const deferredFindings = input.findings.filter((f) => f.recommendedAction.urgency === "deferred");
  if (deferredFindings.length > 0) {
    lines.push("## 後回し可能項目");
    lines.push("");
    for (const item of plan.deferredItems) {
      const f = item.findingId ? findingMap.get(item.findingId) : undefined;
      lines.push(...renderDeferralSection(item, f));
    }
    for (const f of deferredFindings) {
      if (!plan.deferredItems.some((d) => d.findingId === f.findingId)) {
        lines.push(...renderFindingFallback(f));
      }
    }
  }

  // 6. Fix Guide
  const fixable = input.findings.filter((f) => f.recommendedAction.fixAvailable);
  if (fixable.length > 0) {
    lines.push("## 修正ガイド");
    lines.push("");
    lines.push("| パッケージ | 現在バージョン | 修正バージョン | 修正コマンド |");
    lines.push("| --- | --- | --- | --- |");
    for (const f of fixable) {
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

function buildFindingMap(input: ReportInput): Map<string, ReportFinding> {
  const map = new Map<string, ReportFinding>();
  for (const f of input.findings) {
    if (f.findingId) map.set(f.findingId, f);
  }
  return map;
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
