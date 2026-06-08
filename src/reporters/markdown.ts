import type { CollectorStatus, Finding, ScanReport, SeveritySummary } from "../types.ts";
import { writeTextFile } from "../utils.ts";

export function renderMarkdownReport(report: ScanReport): string {
  const lines: string[] = [];
  const title = reportTitle(report);
  const scanDate = report.scannedAt.slice(0, 10);

  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`Scan date: ${scanDate}`);
  lines.push("");
  lines.push(`- Repository: ${report.repository ?? "(not provided)"}`);
  lines.push(`- Path: ${report.path ?? "(not provided)"}`);
  lines.push(`- Scanned at: ${report.scannedAt}`);
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push(renderSummaryTable(report.summary));
  lines.push("");

  lines.push("## Collector Statuses");
  lines.push("");
  lines.push(renderCollectorStatusTable(report.collectorStatuses));
  lines.push("");

  lines.push("## Findings");
  lines.push("");
  lines.push(renderFindingsTable(report.findings));
  lines.push("");

  return `${lines.join("\n")}\n`;
}

export async function writeMarkdownReport(report: ScanReport, output: string): Promise<void> {
  await writeTextFile(output, renderMarkdownReport(report));
}

function renderSummaryTable(summary: SeveritySummary): string {
  return [
    "| Critical | High | Medium | Low | Info | Unknown |",
    "|---:|---:|---:|---:|---:|---:|",
    `| ${summary.critical} | ${summary.high} | ${summary.medium} | ${summary.low} | ${summary.info} | ${summary.unknown} |`,
  ].join("\n");
}

function renderCollectorStatusTable(statuses: CollectorStatus[]): string {
  if (statuses.length === 0) return "_No collectors ran._";

  const rows = statuses.map((status) => [
    status.tool,
    status.status,
    status.sourceStatus ?? "",
    String(status.findingsCount),
    status.error ? escapeMarkdown(status.error) : "",
    status.notes.map(escapeMarkdown).join("; "),
  ]);

  return [
    "| Tool | Status | Source Status | Findings | Error | Notes |",
    "|---|---|---|---:|---|---|",
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function renderFindingsTable(findings: Finding[]): string {
  if (findings.length === 0) return "_No findings._";

  const rows = findings.map((finding) => [
    finding.tool,
    finding.category,
    finding.severity,
    finding.status,
    escapeMarkdown(finding.title),
    escapeMarkdown(finding.location ?? ""),
    finding.url ? `[link](${finding.url})` : "",
  ]);

  return [
    "| Tool | Category | Severity | Status | Title | Location | URL |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function reportTitle(report: ScanReport): string {
  if (report.repository) {
    return `repo-sentry Security Scan Report: ${report.repository}`;
  }

  if (report.path && report.path !== ".") {
    return `repo-sentry Security Scan Report: ${report.path}`;
  }

  return "repo-sentry Security Scan Report";
}
