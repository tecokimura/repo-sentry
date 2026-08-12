import type { PlanAction, PlanDeferral, ReportPlan } from "../plan.ts";
import type { ReportFinding, ReportInput, ReportSummary } from "../types.ts";
import { cmpSemVer, filterAvailableVersions, parseSemVer } from "../semver.ts";
import type { ReportLang } from "../lang.ts";

function semverGt(a: string, b: string): boolean {
  const pa = parseSemVer(a);
  const pb = parseSemVer(b);
  if (!pa || !pb) return a > b;
  return cmpSemVer(pa, pb) > 0;
}

export function renderMarkdownReport(plan: ReportPlan, input: ReportInput, lang: ReportLang = "en"): string {
  const t = lang === "ja" ? JA : EN;
  const lines: string[] = [];
  const scanDate = input.scannedAt.slice(0, 16).replace("T", " ");
  // AI reason / notes を findingId で引けるよう平坦化
  const planLookup = buildPlanLookup(plan);

  // 表示グループは ReportInput.urgency を正規分類として使用
  const immediateFindings = input.findings.filter((f) =>
    f.recommendedAction.urgency === "immediate"
  );
  const plannedFindings = input.findings.filter((f) => f.recommendedAction.urgency === "planned");
  const deferredFindings = input.findings.filter((f) => f.recommendedAction.urgency === "deferred");

  // AI plan と urgency のズレを警告（後で参照するため先に収集）
  warnUrgencyMismatch(plan, input);

  // Title
  const title = input.repository
    ? `${t.reportTitle}: ${input.repository}`
    : t.reportTitle;
  lines.push(`# ${title}`);
  lines.push("");

  // 1. Executive Summary
  lines.push(`## ${t.executiveSummary}`);
  lines.push("");
  lines.push(`**${t.overallRisk}: ${riskLabel(plan.overallRisk, lang)}**`);
  lines.push("");
  // 決定論的な事実文（Renderer生成）
  lines.push(buildSummaryOpening(input.summary, immediateFindings.length, lang));
  lines.push("");
  // AI の executiveSummary は補足文として使用（問題のある文を除外し残りを表示）
  if (plan.executiveSummary) {
    const { cleaned, removedCount } = sanitizeImmediateExpressions(
      plan.executiveSummary,
      immediateFindings.length,
      lang,
    );
    if (removedCount > 0) {
      console.error(
        `[sentry-report] warning: executiveSummary から即時対応の表現を ${removedCount} 文除外しました（immediate=0）`,
      );
    }
    const summaryText = cleaned.trim();
    if (summaryText) {
      const conflicts = detectSummaryConflicts(summaryText, input.summary, plannedFindings.length, lang);
      if (conflicts.length > 0) {
        for (const c of conflicts) {
          console.error(`[sentry-report] warning: executiveSummary が summaryFacts と矛盾: ${c}`);
        }
        console.error(
          "[sentry-report] warning: executiveSummary の表示をスキップしました（決定論的な冒頭文を使用）",
        );
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
  lines.push(`## ${t.scanOverview}`);
  lines.push("");
  lines.push("| | |");
  lines.push("| --- | --- |");
  lines.push(`| ${t.scanDate} | ${scanDate} (UTC) |`);
  if (input.repository) lines.push(`| ${t.repository} | ${escMd(input.repository)} |`);
  lines.push(`| ${t.totalFindings} | ${input.summary.total} |`);
  lines.push(`| Critical | ${input.summary.critical} |`);
  lines.push(`| High | ${input.summary.high} |`);
  lines.push(`| Medium | ${input.summary.medium} |`);
  lines.push(`| Low | ${input.summary.low} |`);
  if (input.summary.kevCount > 0) {
    lines.push(`| ${t.kev} | **${input.summary.kevCount}** |`);
  }
  if (input.summary.epssHighCount > 0) {
    lines.push(`| EPSS ≥ 70% | ${input.summary.epssHighCount} |`);
  }
  lines.push(`| ${t.immediateRequired} | **${immediateFindings.length}** |`);
  lines.push("");

  // 3. 推奨対応順序
  lines.push(...renderRecommendedActions(immediateFindings, plannedFindings, deferredFindings, t));

  // 4. Immediate Actions（ReportInput urgency=immediate が権威）
  if (immediateFindings.length > 0) {
    lines.push(`## ${t.immediateItems}`);
    lines.push("");
    if (immediateFindings.length >= 2) {
      lines.push(...renderPackageSummaryTable(immediateFindings, t));
    }
    for (const f of immediateFindings) {
      lines.push(...renderFindingWithPlan(f, planLookup, "immediate", t));
    }
  }

  // 5. Planned Actions（ReportInput urgency=planned が権威）
  if (plannedFindings.length > 0) {
    lines.push(`## ${t.plannedItems}`);
    lines.push("");
    if (plannedFindings.length >= 2) {
      lines.push(...renderPackageSummaryTable(plannedFindings, t));
    }
    for (const f of plannedFindings) {
      lines.push(...renderFindingWithPlan(f, planLookup, "planned", t));
    }
  }

  // 6. Deferred Items → パッケージ単位の集約テーブルに圧縮
  if (deferredFindings.length > 0) {
    lines.push(...renderDeferredCompact(deferredFindings, t));
  }

  // Fix Guide
  // 同パッケージに複数の CVE がある場合、最大の recommendedVersion を採用する
  const fixable = input.findings.filter((f) => f.recommendedAction.fixAvailable);
  if (fixable.length > 0) {
    lines.push(`## ${t.fixGuide}`);
    lines.push("");
    lines.push(`| ${t.colPackage} | ${t.colCurrentVersion} | ${t.colRecommendedVersion} |`);
    lines.push("| --- | --- | --- |");
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
    for (const { pkg, cur, rec } of fixMap.values()) {
      const recDisplay = rec ? `**${escMd(rec)}**` : "—";
      lines.push(`| ${escMd(pkg)} | ${escMd(cur)} | ${recDisplay} |`);
    }
    lines.push("");
    const cmds = [...fixMap.values()].map(({ cmd }) => cmd).filter(Boolean);
    if (cmds.length > 0) {
      lines.push(`**${t.updateCommands}:**`);
      lines.push("");
      lines.push("```bash");
      for (const cmd of cmds) lines.push(cmd);
      lines.push("```");
      lines.push("");
    }
  }

  // Appendix
  lines.push(`## ${t.appendix}`);
  lines.push("");
  lines.push(`| ID | ${t.colPackage} | ${t.colSeverity} | EPSS | KEV | ${t.colAction} | urgency |`);
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

interface LangStrings {
  reportTitle: string;
  executiveSummary: string;
  overallRisk: string;
  scanOverview: string;
  scanDate: string;
  repository: string;
  totalFindings: string;
  kev: string;
  immediateRequired: string;
  recommendedActions: string;
  immediateItems: string;
  plannedItems: string;
  deferredItems: (n: number) => string;
  fixGuide: string;
  appendix: string;
  updateCommands: string;
  colPackage: string;
  colCurrentVersion: string;
  colRecommendedVersion: string;
  colSeverity: string;
  colAction: string;
  colCveCount: string;
  colMaxSev: string;
  pkgSummary: string;
  actionDeadlineCol: string;
  actionTargetCol: string;
  actionCountCol: string;
  actionRecommendedCol: string;
  thisWeek: string;
  thisMonth: string;
  nextScheduled: string;
  noImmediate: string;
  noPlanned: string;
  perPackageUpdate: string;
  scheduledUpdate: string;
  packageUpdate: string;
  fallbackImmediate: string;
  fallbackPlanned: string;
  fallbackDeferred: string;
  deferReasonNoPackage: string;
  deferReasonTransitive: (pkg: string) => string;
  deferReasonLimitedScope: (pkg: string, feat: string) => string;
  deferReasonLowSeverity: (pkg: string, sev: string) => string;
  deferReasonDefault: (pkg: string) => string;
  deferNow: (n: number) => string;
  deferNote: string;
  thisWeekSection: (n: number) => string;
  thisMonthSection: (n: number, p: number) => string;
  nextScheduledSection: (n: number) => string;
  kevConfirmed: (date?: string) => string;
  pocBadgeHigh: string;
  pocBadgeMedium: string;
  pocBadgeLow: string;
  pocLabel: (badge: string, n: number) => string;
  purl: string;
  recommendedFix: string;
  available: string;
  percentile: string;
}

const EN: LangStrings = {
  reportTitle: "Security Scan Report",
  executiveSummary: "Executive Summary",
  overallRisk: "Overall Risk",
  scanOverview: "Scan Overview",
  scanDate: "Scan Date",
  repository: "Repository",
  totalFindings: "Total Findings",
  kev: "KEV (Active Exploitation)",
  immediateRequired: "Immediate Action Required",
  recommendedActions: "Recommended Action Plan",
  immediateItems: "Immediate Actions",
  plannedItems: "Planned Actions",
  deferredItems: (n) => `Deferred Items (${n})`,
  fixGuide: "Fix Guide",
  appendix: "Appendix: All Findings",
  updateCommands: "Update commands",
  colPackage: "Package",
  colCurrentVersion: "Current Version",
  colRecommendedVersion: "Recommended Version",
  colSeverity: "Severity",
  colAction: "Action",
  colCveCount: "CVEs",
  colMaxSev: "Max Severity",
  pkgSummary: "Package Summary",
  actionDeadlineCol: "Deadline",
  actionTargetCol: "Target",
  actionCountCol: "Count",
  actionRecommendedCol: "Recommended Action",
  thisWeek: "This week",
  thisMonth: "This month",
  nextScheduled: "Next scheduled",
  noImmediate: "No items require immediate action.",
  noPlanned: "No items require planned action.",
  perPackageUpdate: "Update packages",
  scheduledUpdate: "Update at next maintenance",
  packageUpdate: "Planned update",
  fallbackImmediate: "Please review and remediate promptly given the severity or known exploitation.",
  fallbackPlanned: "A fix is available — include this in your regular update schedule.",
  fallbackDeferred: "Does not meet immediate action criteria at this time. Review after higher-priority items.",
  deferReasonNoPackage: "Configuration finding that does not meet immediate action criteria (no KEV, not critical).",
  deferReasonTransitive: (pkg) => `${pkg} is a transitive dependency with indirect exposure — can be deferred.`,
  deferReasonLimitedScope: (pkg, feat) => `${pkg} impact is limited to ${feat} — can be deferred.`,
  deferReasonLowSeverity: (pkg, sev) => `${pkg} is severity ${sev}, which does not meet immediate action criteria.`,
  deferReasonDefault: (pkg) => `${pkg} has a fix available but does not meet critical/KEV immediate criteria — can be deferred.`,
  deferNow: (n) => `${n} item(s) were deferred to the next scheduled maintenance. See the Appendix for details.`,
  deferNote: "Does not meet immediate action criteria at this time. Review after higher-priority items.",
  thisWeekSection: (n) => `### (1) This week (${n} item${n !== 1 ? "s" : ""})`,
  thisMonthSection: (n, p) => `### (2) This month (${n} item${n !== 1 ? "s" : ""} / ${p} package${p !== 1 ? "s" : ""})`,
  nextScheduledSection: (n) => `### (3) Next scheduled update (${n} item${n !== 1 ? "s" : ""})`,
  kevConfirmed: (date?) => `Actively exploited${date ? ` (added ${date})` : ""}`,
  pocBadgeHigh: "High confidence",
  pocBadgeMedium: "Medium confidence",
  pocBadgeLow: "Low confidence",
  pocLabel: (badge, n) => `Public PoC [${badge}] (${n} source${n !== 1 ? "s" : ""})`,
  purl: "PURL",
  recommendedFix: "Recommended Fix",
  available: "Available Fixes",
  percentile: "percentile",
};

const JA: LangStrings = {
  reportTitle: "セキュリティスキャンレポート",
  executiveSummary: "エグゼクティブサマリー",
  overallRisk: "総合リスク評価",
  scanOverview: "スキャン概要",
  scanDate: "スキャン日時",
  repository: "対象リポジトリ",
  totalFindings: "検出総数",
  kev: "KEV（実悪用確認）",
  immediateRequired: "即時対応が必要",
  recommendedActions: "推奨対応順序",
  immediateItems: "即時対応項目",
  plannedItems: "計画対応項目",
  deferredItems: (n) => `後回し可能項目（${n}件）`,
  fixGuide: "修正ガイド",
  appendix: "付録: 全 Finding 一覧",
  updateCommands: "更新コマンド",
  colPackage: "パッケージ",
  colCurrentVersion: "現在バージョン",
  colRecommendedVersion: "推奨バージョン",
  colSeverity: "重大度",
  colAction: "対応",
  colCveCount: "CVE数",
  colMaxSev: "最大重大度",
  pkgSummary: "パッケージ別サマリー",
  actionDeadlineCol: "対応期限",
  actionTargetCol: "対象",
  actionCountCol: "件数",
  actionRecommendedCol: "推奨アクション",
  thisWeek: "今週中",
  thisMonth: "今月中",
  nextScheduled: "次回定期",
  noImmediate: "即時対応が必要な項目はありません。",
  noPlanned: "計画対応が必要な項目はありません。",
  perPackageUpdate: "各パッケージを更新",
  scheduledUpdate: "定期更新で対応",
  packageUpdate: "計画アップデート",
  fallbackImmediate: "悪用状況または重大度を踏まえ、優先的に確認・対応してください。",
  fallbackPlanned: "修正版が提供されているため、通常のアップデート計画に組み込んで対応してください。",
  fallbackDeferred: "現時点では即時対応条件には該当しないため、他の高優先度項目の対応後に確認してください。",
  deferReasonNoPackage: "設定上の指摘であり、即時対応条件（KEV・critical）には該当しないため後回し可能。",
  deferReasonTransitive: (pkg) => `${pkg} は transitive 依存のため影響が間接的であり後回し可能。`,
  deferReasonLimitedScope: (pkg, feat) => `${pkg} は影響範囲が ${feat} に限定されるため後回し可能。`,
  deferReasonLowSeverity: (pkg, sev) => `${pkg} は severity が ${sev} であり即時対応条件に該当しないため後回し可能。`,
  deferReasonDefault: (pkg) => `${pkg} は修正版が提供されているが critical・KEV の即時対応条件には該当しないため後回し可能。`,
  deferNow: (n) => `${n} 件は後回し可能と判断しました。詳細は「後回し可能項目」セクションを参照してください。`,
  deferNote: "後回し理由",
  thisWeekSection: (n) => `### (1) 今週中（${n}件）`,
  thisMonthSection: (n, p) => `### (2) 今月中（${n}件 / ${p}パッケージ）`,
  nextScheduledSection: (n) => `### (3) 次回定期アップデート時（${n}件）`,
  kevConfirmed: (date?) => `悪用確認済み${date ? ` (${date})` : ""}`,
  pocBadgeHigh: "⚠ 高信頼度",
  pocBadgeMedium: "中信頼度",
  pocBadgeLow: "低信頼度",
  pocLabel: (badge, n) => `公開済み [${badge}] (${n} 件)`,
  purl: "PURL",
  recommendedFix: "推奨修正版",
  available: "利用可能",
  percentile: "パーセンタイル",
};


const CONTRADICTION_PATTERNS_JA: Record<"immediate" | "planned" | "deferred", string[]> = {
  immediate: [
    "後回しでよい",
    "後回しで良い",
    "後回しにしてください",
    "後回しで対応",
    "計画的に対応",
  ],
  planned: [
    "後回しでよい",
    "後回しで良い",
    "後回しで対応",
    "後回しでも",
    "直ちに対応が必要",
    "即時対応が必要",
    "直ちに修正",
    "緊急の対応が必要",
  ],
  deferred: [
    "即時対応が必要",
    "直ちに対応が必要",
    "早急に対応",
    "今すぐ対応",
    "緊急の対応が必要",
    "緊急対応が必要",
  ],
};

const CONTRADICTION_PATTERNS_EN: Record<"immediate" | "planned" | "deferred", string[]> = {
  immediate: [
    "can be deferred",
    "low priority",
    "no immediate action",
    "plan for later",
  ],
  planned: [
    "can be deferred",
    "immediately remediate",
    "urgent action required",
    "critical action needed",
  ],
  deferred: [
    "immediate action required",
    "must be fixed immediately",
    "urgent",
    "fix now",
  ],
};

function sanitizeReason(
  text: string | undefined,
  section: "immediate" | "planned" | "deferred",
  t: LangStrings,
  findingId?: string,
): string {
  const fallback = { immediate: t.fallbackImmediate, planned: t.fallbackPlanned, deferred: t.fallbackDeferred };
  const patterns = t === JA ? CONTRADICTION_PATTERNS_JA : CONTRADICTION_PATTERNS_EN;
  if (!text) return fallback[section];
  const contradicts = patterns[section].some((p) => text.includes(p));
  if (contradicts) {
    console.error(
      `[sentry-report] warning: ${findingId ?? "?"} reason contradicts section=${section}, using default`,
    );
    return fallback[section];
  }
  return text;
}

function buildDeferReason(f: ReportFinding, t: LangStrings): string {
  if (!f.package) return t.deferReasonNoPackage;

  const kev = f.riskSignals.kev;
  const epss = f.riskSignals.epss;
  const sev = f.riskSignals.severity?.toLowerCase();
  const dep = f.package.dependencyType;
  const feat = f.context.affectedFeatures;
  const pkg = f.package.name;

  if (!kev && (epss === undefined || epss < 0.01)) {
    return t === JA
      ? `${pkg} は KEV 未登録かつ悪用可能性が低いため後回し可能。`
      : `${pkg} is not in KEV and has low exploitation probability — can be deferred.`;
  }
  if (dep === "transitive") return t.deferReasonTransitive(pkg);
  if (feat && feat.length > 0) return t.deferReasonLimitedScope(pkg, feat.join(t === JA ? "・" : ", "));
  if (sev === "low" || sev === "unknown") return t.deferReasonLowSeverity(pkg, sev);
  return t.deferReasonDefault(pkg);
}

function higherSeverity(a: string, b: string): string {
  const order = ["critical", "high", "medium", "low", "unknown"];
  const ia = order.indexOf(a.toLowerCase());
  const ib = order.indexOf(b.toLowerCase());
  const rankA = ia === -1 ? order.length : ia;
  const rankB = ib === -1 ? order.length : ib;
  return rankA <= rankB ? a : b;
}

type PkgEntry = { findings: ReportFinding[]; maxSev: string; maxVer: string };

function buildPackageMap(findings: ReportFinding[]): Map<string, PkgEntry> {
  const map = new Map<string, PkgEntry>();
  for (const f of findings) {
    const pkg = f.package?.name ?? f.context.title ?? "—";
    const sev = f.riskSignals.severity ?? "unknown";
    const ver = f.recommendedAction.recommendedVersion ?? "";
    if (!map.has(pkg)) {
      map.set(pkg, { findings: [f], maxSev: sev, maxVer: ver });
    } else {
      const e = map.get(pkg)!;
      e.findings.push(f);
      e.maxSev = higherSeverity(sev, e.maxSev);
      if (ver && (!e.maxVer || semverGt(ver, e.maxVer))) e.maxVer = ver;
    }
  }
  return map;
}

function renderRecommendedActions(
  immediateFindings: ReportFinding[],
  plannedFindings: ReportFinding[],
  deferredFindings: ReportFinding[],
  t: LangStrings,
): string[] {
  const lines: string[] = [];
  lines.push(`## ${t.recommendedActions}`);
  lines.push("");

  // --- サマリー表（マネージャー向け一覧）---
  const immPkgMap = buildPackageMap(immediateFindings);
  const planPkgMap = buildPackageMap(plannedFindings);
  const deferPkgMap = buildPackageMap(deferredFindings);

  const pkgWord = (n: number) => t === JA ? `${n}パッケージ` : `${n} package${n !== 1 ? "s" : ""}`;

  const immTarget = immediateFindings.length === 0
    ? "—"
    : immPkgMap.size === 1
    ? `\`${escMd([...immPkgMap.keys()][0])}\``
    : pkgWord(immPkgMap.size);

  let immAction = "—";
  if (immediateFindings.length > 0) {
    const ver = [...immPkgMap.values()][0]?.maxVer;
    immAction = immPkgMap.size === 1 && ver
      ? (t === JA ? `${escMd(ver)}へ更新` : `Update to ${escMd(ver)}`)
      : t.perPackageUpdate;
  }

  lines.push(`| ${t.actionDeadlineCol} | ${t.actionTargetCol} | ${t.actionCountCol} | ${t.actionRecommendedCol} |`);
  lines.push("| --- | --- | ---: | --- |");
  lines.push(`| ${t.thisWeek} | ${immTarget} | ${immediateFindings.length} | ${immAction} |`);
  lines.push(
    `| ${t.thisMonth} | ${
      plannedFindings.length > 0 ? pkgWord(planPkgMap.size) : "—"
    } | ${plannedFindings.length} | ${plannedFindings.length > 0 ? t.packageUpdate : "—"} |`,
  );
  lines.push(
    `| ${t.nextScheduled} | ${
      deferredFindings.length > 0 ? pkgWord(deferPkgMap.size) : "—"
    } | ${deferredFindings.length} | ${deferredFindings.length > 0 ? t.scheduledUpdate : "—"} |`,
  );
  lines.push("");

  // --- 期限別リスト ---
  if (immediateFindings.length > 0) {
    lines.push(t.thisWeekSection(immediateFindings.length));
    lines.push("");
    for (const f of immediateFindings) {
      const pkg = f.package?.name ? `\`${escMd(f.package.name)}\`` : escMd(f.context.title ?? "—");
      const id = f.findingId ? ` — ${escMd(f.findingId)}` : "";
      lines.push(`- ${pkg}${id}`);
    }
    lines.push("");
  } else {
    lines.push(`### (1) ${t.thisWeek}`);
    lines.push("");
    lines.push(t.noImmediate);
    lines.push("");
  }

  if (plannedFindings.length > 0) {
    lines.push(t.thisMonthSection(plannedFindings.length, planPkgMap.size));
    lines.push("");
    for (const [pkg, { findings }] of planPkgMap.entries()) {
      const count = findings.length > 1
        ? (t === JA ? ` (${findings.length}件)` : ` (${findings.length})`)
        : "";
      lines.push(`- \`${escMd(pkg)}\`${count}`);
    }
    lines.push("");
  } else {
    lines.push(`### (2) ${t.thisMonth}`);
    lines.push("");
    lines.push(t.noPlanned);
    lines.push("");
  }

  if (deferredFindings.length > 0) {
    lines.push(t.nextScheduledSection(deferredFindings.length));
    lines.push("");
    lines.push(t.deferNow(deferredFindings.length));
    lines.push("");
  }

  return lines;
}

function renderPackageSummaryTable(findings: ReportFinding[], t: LangStrings): string[] {
  const pkgMap = buildPackageMap(findings);
  const hasGrouped = pkgMap.size > 1 || [...pkgMap.values()].some((v) => v.findings.length > 1);
  if (!hasGrouped) return [];

  const lines: string[] = [];
  lines.push(`### ${t.pkgSummary}`);
  lines.push("");
  lines.push(`| ${t.colPackage} | ${t.colCveCount} | ${t.colMaxSev} | ${t.colRecommendedVersion} |`);
  lines.push("| --- | --- | --- | --- |");
  for (const [pkg, { findings, maxSev, maxVer }] of pkgMap.entries()) {
    lines.push(`| ${escMd(pkg)} | ${findings.length} | ${maxSev} | ${escMd(maxVer || "—")} |`);
  }
  lines.push("");
  return lines;
}

function renderDeferredCompact(findings: ReportFinding[], t: LangStrings): string[] {
  const lines: string[] = [];
  lines.push(`## ${t.deferredItems(findings.length)}`);
  lines.push("");
  lines.push(
    t === JA
      ? "現時点では即時対応条件に該当しないため次回定期アップデート時に対応してください。詳細は付録を参照してください。"
      : "These items do not meet immediate action criteria. Address at the next scheduled maintenance. See the Appendix for details.",
  );
  lines.push("");

  const pkgMap = buildPackageMap(findings);
  lines.push(`| ${t.colPackage} | ${t.colCveCount} | ${t.colMaxSev} | ${t.colRecommendedVersion} |`);
  lines.push("| --- | --- | --- | --- |");
  for (const [pkg, { findings: pf, maxSev, maxVer }] of pkgMap.entries()) {
    lines.push(`| ${escMd(pkg)} | ${pf.length} | ${maxSev} | ${escMd(maxVer || "—")} |`);
  }
  lines.push("");
  return lines;
}

function renderFindingWithPlan(
  f: ReportFinding,
  planLookup: Map<string, PlanAction | PlanDeferral>,
  section: "immediate" | "planned" | "deferred",
  t: LangStrings,
): string[] {
  if (section === "deferred") {
    const rawTitle = f.context.title ?? f.findingId ?? "—";
    const title = rawTitle.length > 60 ? rawTitle.slice(0, 60) + "…" : rawTitle;
    return renderDeferralSection(
      { findingId: f.findingId, title, deferReason: buildDeferReason(f, t) },
      f,
      t,
    );
  }

  const planItem = f.findingId ? planLookup.get(f.findingId) : undefined;
  if (!planItem) return renderFindingFallback(f, t);

  const rawText = "reason" in planItem ? planItem.reason : planItem.deferReason;
  const notes = "notes" in planItem ? (planItem as PlanAction).notes : undefined;
  const text = sanitizeReason(rawText, section, t, f.findingId);
  return renderActionSection({
    findingId: planItem.findingId,
    title: planItem.title,
    reason: text,
    notes,
  }, f, t);
}

function renderActionSection(action: PlanAction, f: ReportFinding | undefined, t: LangStrings): string[] {
  const lines: string[] = [];
  const heading = f?.findingId ? `${f.findingId} — ${escMd(action.title)}` : escMd(action.title);
  lines.push(`### ${heading}`);
  lines.push("");
  lines.push(action.reason);
  if (action.notes) {
    lines.push("");
    lines.push(`> ${escMd(action.notes)}`);
  }
  if (f) lines.push(...renderFindingTable(f, t));
  lines.push("");
  return lines;
}

function renderDeferralSection(item: PlanDeferral, f: ReportFinding | undefined, t: LangStrings): string[] {
  const lines: string[] = [];
  const heading = f?.findingId ? `${f.findingId} — ${escMd(item.title)}` : escMd(item.title);
  lines.push(`### ${heading}`);
  lines.push("");
  lines.push(`${t.deferNote}: ${item.deferReason}`);
  if (f) lines.push(...renderFindingTable(f, t));
  lines.push("");
  return lines;
}

function renderFindingFallback(f: ReportFinding, t: LangStrings): string[] {
  const lines: string[] = [];
  const heading = f.findingId
    ? `${f.findingId} — ${escMd(f.context.title)}`
    : escMd(f.context.title);
  lines.push(`### ${heading}`);
  lines.push("");
  const urgency = f.recommendedAction.urgency ?? "deferred";
  const fallback = { immediate: t.fallbackImmediate, planned: t.fallbackPlanned, deferred: t.fallbackDeferred };
  lines.push(fallback[urgency]);
  lines.push(...renderFindingTable(f, t));
  lines.push("");
  return lines;
}

function renderFindingTable(f: ReportFinding, t: LangStrings): string[] {
  const rows: [string, string][] = [];
  if (f.package) {
    rows.push([t.colPackage, `${f.package.name}`]);
    rows.push([t.colCurrentVersion, f.package.version]);
    if (f.package.purl) rows.push([t.purl, f.package.purl]);
  }
  if (f.recommendedAction.recommendedVersion) {
    rows.push([t.recommendedFix, `**${f.recommendedAction.recommendedVersion}**`]);
  }
  if (f.recommendedAction.fixedVersions?.length) {
    const available = filterAvailableVersions(
      f.recommendedAction.fixedVersions,
      f.package?.version,
    );
    if (available.length > 0) {
      rows.push([t.available, available.join(", ")]);
    }
  }
  if (f.riskSignals.epss != null) {
    rows.push([
      "EPSS",
      `${(f.riskSignals.epss * 100).toFixed(1)}% (${
        f.riskSignals.epssPercentile != null
          ? `${(f.riskSignals.epssPercentile * 100).toFixed(1)} ${t.percentile}`
          : ""
      })`,
    ]);
  }
  if (f.riskSignals.kev) {
    rows.push(["KEV", t.kevConfirmed(f.context.kevDateAdded)]);
  }
  if (f.context.poc) {
    const { confidence, sources } = f.context.poc;
    const badge = confidence === "high"
      ? t.pocBadgeHigh
      : confidence === "medium"
      ? t.pocBadgeMedium
      : t.pocBadgeLow;
    rows.push(["PoC", t.pocLabel(badge, sources.length)]);
    for (const s of sources) {
      rows.push(["", s.url]);
    }
  }
  if (f.context.cweIds?.length) rows.push(["CWE", f.context.cweIds.join(", ")]);
  if (f.context.url) {
    rows.push([t === JA ? "参考" : "Reference", f.context.url]);
  }

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
          `[sentry-report] warning: ${id} は AI plan で ${section} 分類ですが urgency=${actual} のため ${
            actual === "immediate" ? "即時対応" : actual === "planned" ? "計画対応" : "後回し"
          } に表示します`,
        );
      }
    }
  };
  check("immediate", plan.immediateActions.map((a) => a.findingId));
  check("planned", plan.plannedActions.map((a) => a.findingId));
  check("deferred", plan.deferredItems.map((d) => d.findingId));
}

function buildSummaryOpening(summary: ReportSummary, immediateCount: number, lang: ReportLang): string {
  const { critical, high, medium, low, kevCount, epssHighCount } = summary;

  if (lang === "ja") {
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
      return `今回のスキャンでは High の脆弱性が ${high} 件検出されました。Critical / KEV には該当しないため即時対応対象は ${immediateCount} 件ですが、計画的な対応を推奨します。${
        epssHighCount > 0 ? ` なお EPSS ≥ 70% の脆弱性が ${epssHighCount} 件含まれます。` : ""
      }`;
    }
    if (medium > 0 || low > 0) {
      return `今回のスキャンでは Critical / High の脆弱性は検出されませんでした。Medium が ${medium} 件${
        low > 0 ? `、Low が ${low} 件` : ""
      }確認されており、通常の更新サイクルでの対応を推奨します。`;
    }
    return "今回のスキャンでは脆弱性は検出されませんでした。";
  }

  // English
  if (critical > 0 && kevCount > 0) {
    return `This scan detected ${critical} Critical vulnerability${critical !== 1 ? "ies" : ""}, of which ${kevCount} ${kevCount !== 1 ? "are" : "is"} listed in KEV (known active exploitation). ${immediateCount} item${immediateCount !== 1 ? "s" : ""} require immediate action.`;
  }
  if (critical > 0) {
    return `This scan detected ${critical} Critical vulnerability${critical !== 1 ? "ies" : ""}. ${immediateCount} item${immediateCount !== 1 ? "s" : ""} require immediate action.`;
  }
  if (high > 0 && kevCount > 0) {
    return `This scan detected ${high} High-severity vulnerability${high !== 1 ? "ies" : ""}, of which ${kevCount} ${kevCount !== 1 ? "are" : "is"} listed in KEV. ${immediateCount} item${immediateCount !== 1 ? "s" : ""} require immediate action.`;
  }
  if (high > 0) {
    return `This scan detected ${high} High-severity vulnerability${high !== 1 ? "ies" : ""}. None qualify as Critical/KEV so ${immediateCount} item${immediateCount !== 1 ? "s" : ""} require immediate action, but planned remediation is recommended.${
      epssHighCount > 0 ? ` Note: ${epssHighCount} finding${epssHighCount !== 1 ? "s" : ""} have EPSS ≥ 70%.` : ""
    }`;
  }
  if (medium > 0 || low > 0) {
    return `No Critical or High vulnerabilities were detected. ${medium} Medium${
      low > 0 ? ` and ${low} Low` : ""
    } finding${medium + low !== 1 ? "s" : ""} were found — address during your regular update cycle.`;
  }
  return "No vulnerabilities were detected in this scan.";
}

type SummaryConflict = string;

function sanitizeImmediateExpressions(
  text: string,
  immediateCount: number,
  lang: ReportLang,
): { cleaned: string; removedCount: number } {
  if (immediateCount > 0) return { cleaned: text, removedCount: 0 };

  const patterns = lang === "ja"
    ? [
      "即時対応",
      "緊急対応",
      "直ちに対応",
      "早急に対応",
      "優先的に対応",
      "至急対応",
      "直ちに修正",
      "早急な対応",
      "緊急な対応",
    ]
    : [
      "immediate action",
      "must be fixed immediately",
      "urgent remediation",
      "fix immediately",
      "requires immediate",
      "urgent action",
    ];

  const parts = lang === "ja" ? text.split("。") : text.split(/(?<=[.!?])\s+/);
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

  return { cleaned: kept.join(lang === "ja" ? "。" : " "), removedCount };
}

function detectSummaryConflicts(
  text: string,
  summary: ReportSummary,
  plannedCount: number,
  lang: ReportLang,
): SummaryConflict[] {
  const conflicts: SummaryConflict[] = [];
  const highOrAbove = summary.high + summary.critical;

  if (highOrAbove > 0) {
    const negations = lang === "ja"
      ? ["高リスクの脆弱性は見られません", "高リスクなし", "高リスクは確認されません", "高い脆弱性はありません"]
      : ["no high-risk", "no high severity", "no critical", "zero high"];
    if (negations.some((p) => text.toLowerCase().includes(p.toLowerCase()))) {
      conflicts.push(`high=${summary.high}/critical=${summary.critical} but negation found`);
    }
  }

  if (plannedCount > 0) {
    const allDeferred = lang === "ja"
      ? ["すべて後回し", "全て後回し", "すべてdeferred"]
      : ["all deferred", "everything deferred"];
    if (allDeferred.some((p) => text.toLowerCase().includes(p.toLowerCase()))) {
      conflicts.push(`planned=${plannedCount} but "all deferred" expression found`);
    }
  }

  if (summary.critical === 0) {
    const criticalAffirm = lang === "ja"
      ? ["Critical が存在", "Critical が検出", "クリティカルな脆弱性が存在"]
      : ["critical vulnerability exists", "critical issue detected"];
    if (criticalAffirm.some((p) => text.toLowerCase().includes(p.toLowerCase()))) {
      conflicts.push("critical=0 but affirmation of critical found");
    }
  }

  if (summary.kevCount === 0) {
    const kevAffirm = lang === "ja"
      ? ["悪用確認済み", "KEVに登録", "実際に悪用されており"]
      : ["active exploitation", "listed in kev", "actively exploited"];
    if (kevAffirm.some((p) => text.toLowerCase().includes(p.toLowerCase()))) {
      conflicts.push("kev=0 but KEV affirmation found");
    }
  }

  return conflicts;
}

function riskLabel(risk: string, _lang: ReportLang): string {
  switch (risk) {
    case "critical": return "Critical";
    case "high": return "High";
    case "medium": return "Medium";
    default: return "Low";
  }
}

function escMd(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
