import type { CollectorRunStatus, CollectorStatus, Finding, ScanReport } from "../types.ts";
import { severityOrder } from "../types.ts";
import { writeTextFile } from "../utils.ts";

export function renderMarkdownReport(report: ScanReport): string {
  const lines: string[] = [];
  const scanDate = report.scannedAt.slice(0, 16).replace("T", " ");

  lines.push(`# ${reportTitle(report)}`);
  lines.push("");
  const hasClearwing = report.findings.some((f) => f.clearwingRisk);
  lines.push(`Scan date: ${scanDate} (UTC)　Clearwing: ${hasClearwing ? "あり" : "なし"}`);
  lines.push("");

  lines.push("## 対応優先度サマリー");
  lines.push("");
  lines.push(renderPrioritySummary(report.findings));
  lines.push("");

  lines.push("## Collector 実行結果");
  lines.push("");
  lines.push(renderCollectorStatusTable(report.collectorStatuses));
  lines.push("");

  lines.push("## Findings");
  lines.push("");

  const sorted = sortFindings(report.findings);
  if (sorted.length === 0) {
    lines.push("_検出なし。_");
    lines.push("");
  } else {
    for (const finding of sorted) {
      lines.push(renderFinding(finding));
    }
  }

  return lines.join("\n") + "\n";
}

export async function writeMarkdownReport(report: ScanReport, output: string): Promise<void> {
  await writeTextFile(output, renderMarkdownReport(report));
}

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const diff = severityOrder[b.severity] - severityOrder[a.severity];
    if (diff !== 0) return diff;
    const aKey = a.packageName ?? a.title;
    const bKey = b.packageName ?? b.title;
    return aKey.localeCompare(bKey);
  });
}

function renderPrioritySummary(findings: Finding[]): string {
  const critical = findings.filter((f) => f.severity === "critical");
  const high = findings.filter((f) => f.severity === "high");
  const mediumLow = findings.filter((f) => f.severity === "medium" || f.severity === "low");
  const infoUnknown = findings.filter((f) => f.severity === "info" || f.severity === "unknown");

  const rows: string[] = [
    "| 優先度 | 件数 | 主なリスク | 推奨期限 |",
    "| --- | ---: | --- | --- |",
  ];

  if (critical.length > 0) {
    rows.push(
      `| 今すぐ対応 (Critical) | ${critical.length} | ${summarizeRisk(critical)} | 今週中 |`,
    );
  }
  if (high.length > 0) {
    rows.push(`| 優先対応 (High) | ${high.length} | ${summarizeRisk(high)} | 2週間以内 |`);
  }
  if (mediumLow.length > 0) {
    rows.push(
      `| 計画的に対応 (Medium/Low) | ${mediumLow.length} | ${
        summarizeRisk(mediumLow)
      } | 1ヶ月以内 |`,
    );
  }
  if (infoUnknown.length > 0) {
    rows.push(
      `| 確認 (Info/Unknown) | ${infoUnknown.length} | ${summarizeRisk(infoUnknown)} | 随時 |`,
    );
  }
  if (rows.length === 2) {
    rows.push("| — | 0 | 検出なし | — |");
  }

  return rows.join("\n");
}

function summarizeRisk(findings: Finding[]): string {
  const cats = new Set(findings.map((f) => f.category));
  const parts: string[] = [];
  if (cats.has("secret")) parts.push("シークレット漏洩");
  if (cats.has("dependency-vulnerability") || cats.has("container-vulnerability")) {
    parts.push("依存パッケージの脆弱性");
  }
  if (cats.has("iac-misconfiguration")) parts.push("IaC・設定不備");
  if (cats.has("code-vulnerability")) parts.push("コードの脆弱性");
  if (cats.has("scanner-diagnostic")) parts.push("スキャナー診断");
  return parts.join("・") || "詳細を確認";
}

const statusJa: Record<CollectorRunStatus, string> = {
  completed: "完了",
  failed: "失敗",
  skipped: "スキップ",
};

function renderCollectorStatusTable(statuses: CollectorStatus[]): string {
  if (statuses.length === 0) return "_Collector が実行されませんでした。_";

  const rows = statuses.map((s) => {
    const noteParts: string[] = [];
    if (s.sourceStatus) noteParts.push(s.sourceStatus);
    if (s.error) noteParts.push(escapeMarkdown(s.error));
    noteParts.push(...s.notes.map(escapeMarkdown));
    return `| ${s.tool} | ${statusJa[s.status] ?? s.status} | ${s.findingsCount} | ${
      noteParts.join("; ")
    } |`;
  });

  return [
    "| ツール | 状態 | 検出数 | 備考 |",
    "| --- | --- | ---: | --- |",
    ...rows,
  ].join("\n");
}

function renderFinding(finding: Finding): string {
  const lines: string[] = [];
  const { best: bestFix, others: altFixes } = resolveFixVersions(
    finding.packageVersion,
    finding.fixedVersion,
  );

  lines.push(`### [${finding.severity.toUpperCase()}] ${escapeMarkdown(finding.title)}`);
  lines.push("");

  const subtitleParts: string[] = [];
  if (finding.id) {
    subtitleParts.push(
      finding.url ? `[**${finding.id}**](${finding.url})` : `**${finding.id}**`,
    );
  }
  if (finding.packageName) subtitleParts.push(displayPackageName(finding.packageName));
  if (finding.location) subtitleParts.push(escapeMarkdown(finding.location));
  if (subtitleParts.length > 0) {
    lines.push(subtitleParts.join(" · "));
    lines.push("");
  }

  const tableRows: [string, string][] = [];
  if (finding.packageVersion) tableRows.push(["現在バージョン", finding.packageVersion]);
  if (bestFix) tableRows.push(["推奨対応バージョン", `${bestFix} 以上`]);
  if (altFixes.length > 0) {
    tableRows.push(["他の修正バージョン", altFixes.map((v) => `${v} 以上`).join("、")]);
  }
  if (finding.url) tableRows.push(["参考", finding.url]);

  if (tableRows.length > 0) {
    lines.push("| | |");
    lines.push("| --- | --- |");
    for (const [label, value] of tableRows) {
      lines.push(`| ${label} | ${escapeMarkdown(value)} |`);
    }
    lines.push("");
  }

  const remedy = remedyCommand(finding, bestFix);
  if (remedy) {
    lines.push(`**対応コマンド** \`${remedy}\``);
    lines.push("");
  }

  if (finding.clearwingRisk) {
    lines.push("#### リスク");
    lines.push("");
    lines.push(finding.clearwingRisk);
    lines.push("");
  }

  if (finding.clearwingIncidents) {
    lines.push("#### 悪用シナリオ");
    lines.push("");
    lines.push(finding.clearwingIncidents);
    lines.push("");
  }

  if (finding.clearwingMemo) {
    lines.push("#### 対応判断メモ");
    lines.push("");
    lines.push(finding.clearwingMemo);
    lines.push("");
  }

  return lines.join("\n");
}

function displayPackageName(packageName: string): string {
  const colonIdx = packageName.indexOf(":");
  return colonIdx >= 0 ? packageName.slice(colonIdx + 1) : packageName;
}

function remedyCommand(finding: Finding, targetVersion: string | undefined): string | undefined {
  const { packageName, location } = finding;
  if (!packageName || !targetVersion) return undefined;

  const loc = (location ?? "").toLowerCase();
  const colonIdx = packageName.indexOf(":");
  const eco = colonIdx >= 0 ? packageName.slice(0, colonIdx) : detectEcosystem(loc);
  const pkg = colonIdx >= 0 ? packageName.slice(colonIdx + 1) : packageName;

  switch (eco) {
    case "composer":
    case "packagist":
      return `composer require "${pkg}:^${targetVersion}"`;
    case "npm":
    case "yarn":
      return `npm install "${pkg}@^${targetVersion}"`;
    case "pip":
    case "pypi":
      return `pip install "${pkg}>=${targetVersion}"`;
    case "go":
    case "golang":
      return `go get "${pkg}@v${targetVersion}"`;
    case "gem":
    case "rubygems":
      return `bundle update ${pkg}`;
    case "cargo":
      return `cargo update -p ${pkg}`;
    default:
      return undefined;
  }
}

function resolveFixVersions(
  currentVersion?: string,
  fixedVersion?: string,
): { best: string | undefined; others: string[] } {
  if (!fixedVersion) return { best: undefined, others: [] };

  const all = fixedVersion.split(",").map((v) => v.trim()).filter(Boolean);
  if (all.length === 0) return { best: undefined, others: [] };
  if (!currentVersion || all.length === 1) {
    return { best: all.sort(compareSemver)[0], others: [] };
  }

  // インストール済みバージョン以上で最小のものを選択
  const eligible = all.filter((v) => compareSemver(v, currentVersion) >= 0).sort(compareSemver);
  if (eligible.length === 0) {
    return { best: all.sort(compareSemver).at(-1), others: [] };
  }

  const best = eligible[0];
  const currentMajor = semverMajor(currentVersion);
  const bestMajor = semverMajor(best);

  // 同一メジャー内で修正できる場合は代替不要
  if (bestMajor === currentMajor) return { best, others: [] };

  // メジャーアップグレードが必要な場合、他のメジャーラインの最小修正バージョンを列挙
  const byMajor = new Map<number, string>();
  for (const v of eligible) {
    const major = semverMajor(v);
    if (major !== bestMajor && !byMajor.has(major)) byMajor.set(major, v);
  }
  const others = Array.from(byMajor.entries())
    .sort(([a], [b]) => a - b)
    .map(([, v]) => v);

  return { best, others };
}

function semverMajor(v: string): number {
  return parseInt(v.replace(/^[vV]/, "").split(".")[0] ?? "0", 10) || 0;
}

function compareSemver(a: string, b: string): number {
  const norm = (v: string) => v.replace(/^[vV]/, "").split(".").map((s) => parseInt(s, 10) || 0);
  const pa = norm(a);
  const pb = norm(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function detectEcosystem(loc: string): string {
  if (loc.includes("composer.lock") || loc.includes("composer.json")) return "composer";
  if (
    loc.includes("package-lock.json") || loc.includes("yarn.lock") || loc.includes("package.json")
  ) {
    return "npm";
  }
  if (loc.includes("go.sum") || loc.includes("go.mod")) return "go";
  if (loc.includes("requirements.txt") || loc.includes("pipfile")) return "pip";
  if (loc.includes("gemfile")) return "gem";
  if (loc.includes("cargo.toml") || loc.includes("cargo.lock")) return "cargo";
  return "";
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function reportTitle(report: ScanReport): string {
  if (report.repository) return `repo-sentry Security Scan Report: ${report.repository}`;
  if (report.path && report.path !== ".") return `repo-sentry Security Scan Report: ${report.path}`;
  return "repo-sentry Security Scan Report";
}
