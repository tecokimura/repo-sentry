import type { EnrichedFinding, EnrichedReport } from "../sentry-enrich/types.ts";
import type {
  FindingContext,
  RecommendedAction,
  ReportFinding,
  ReportInput,
  ReportSummary,
  RiskSignals,
} from "./types.ts";
import { REPORT_INPUT_VERSION } from "./types.ts";
import { computeRecommendedVersion } from "./semver.ts";

export function buildReportInput(report: EnrichedReport): ReportInput {
  const findings = report.findings.map(toReportFinding);

  return {
    reportInputVersion: REPORT_INPUT_VERSION,
    scanId: report.scanId,
    enrichId: report.enrichId,
    profile: report.profile,
    repository: report.repository,
    scannedAt: report.scannedAt,
    summary: buildSummary(findings),
    findings: findings.sort((a, b) =>
      b.riskSignals.priorityScore - a.riskSignals.priorityScore
    ),
  };
}

function toReportFinding(f: EnrichedFinding): ReportFinding {
  const kev = !!f.kev;
  const fixAvailable = (f.fixedVersions?.length ?? 0) > 0;

  const riskSignals: RiskSignals = {
    severity: f.severity,
    epss: f.epss?.epss,
    epssPercentile: f.epss?.percentile,
    kev,
    hasFixedVersion: fixAvailable,
    priorityScore: computePriorityScore(f),
  };

  return {
    findingId: f.id,
    tool: f.tool,
    category: f.category,
    package: f.packageName
      ? {
        ecosystem: f.ecosystem ?? "",
        name: f.packageName,
        version: f.packageVersion ?? "",
        purl: f.purl ?? "",
        dependencyType: f.dependencyType === "unknown" ? undefined : f.dependencyType,
      }
      : undefined,
    riskSignals,
    recommendedAction: deriveAction(f, fixAvailable),
    context: buildContext(f),
  };
}

function computePriorityScore(f: EnrichedFinding): number {
  let score = 0;

  switch (f.severity) {
    case "critical": score += 40; break;
    case "high":     score += 25; break;
    case "medium":   score += 15; break;
    case "low":      score += 5;  break;
  }

  if (f.kev) score += 40;

  const epss = f.epss?.epss ?? 0;
  if (epss >= 0.9)      score += 20;
  else if (epss >= 0.7) score += 10;
  else if (epss >= 0.4) score += 5;

  if (f.dependencyType === "direct") score += 5;

  return Math.min(100, score);
}

function deriveAction(f: EnrichedFinding, fixAvailable: boolean): RecommendedAction {
  const urgency = deriveUrgency(f);
  const action = fixAvailable ? "upgrade" : f.clearwingMemo ? "mitigate" : "monitor";

  const result: RecommendedAction = { action, urgency, fixAvailable };
  if (f.fixedVersions?.length) {
    result.fixedVersions = f.fixedVersions;
    const rec = computeRecommendedVersion(f.packageVersion, f.fixedVersions);
    if (rec) {
      result.recommendedVersion = rec;
      result.fixCommand = generateFixCommand(f.ecosystem, f.packageName, rec);
    }
  }

  return result;
}

function generateFixCommand(
  ecosystem?: string,
  pkgName?: string,
  version?: string,
): string | undefined {
  if (!ecosystem || !pkgName || !version) return undefined;
  switch (ecosystem) {
    case "composer": return `composer require ${pkgName}:^${version}`;
    case "npm":      return `npm install ${pkgName}@${version}`;
    case "pypi":     return `pip install ${pkgName}==${version}`;
    case "golang":   return `go get ${pkgName}@v${version}`;
    case "cargo":    return `cargo add ${pkgName}@${version}`;
    case "gem":      return `gem install ${pkgName} -v ${version}`;
    case "nuget":    return `dotnet add package ${pkgName} --version ${version}`;
    case "maven":    return `<!-- pom.xml: <version>${version}</version> -->`;
    default:         return undefined;
  }
}

function deriveUrgency(f: EnrichedFinding): "immediate" | "planned" | "deferred" {
  if (f.kev) return "immediate";
  if (f.severity === "critical") return "immediate";
  const epss = f.epss?.epss ?? 0;
  if (f.severity === "high" || (f.severity === "medium" && epss >= 0.4)) return "planned";
  return "deferred";
}

function buildContext(f: EnrichedFinding): FindingContext {
  const ctx: FindingContext = {
    title: f.title,
  };

  if (f.description)   ctx.description = f.description;
  if (f.location)      ctx.location = f.location;
  if (f.cweIds?.length) ctx.cweIds = f.cweIds;
  const refUrl = f.canonicalReference ?? f.url;
  if (refUrl) ctx.url = refUrl;

  if (f.osv?.summary)       ctx.osvSummary = f.osv.summary;
  if (f.osv?.aliases?.length) ctx.osvAliases = f.osv.aliases;

  if (f.kev?.dateAdded)      ctx.kevDateAdded = f.kev.dateAdded;
  if (f.kev?.requiredAction) ctx.kevRequiredAction = f.kev.requiredAction;

  const hasAnalysis = f.clearwingRisk || f.clearwingIncidents || f.clearwingMemo;
  if (hasAnalysis) {
    ctx.analysisSource = "clearwing";
    if (f.clearwingRisk)      ctx.attackCategory = f.clearwingRisk.trim();
    if (f.clearwingIncidents) ctx.impact = splitLines(f.clearwingIncidents);
    if (f.clearwingMemo)      ctx.affectedFeatures = splitLines(f.clearwingMemo);
  }

  if (f.pocReferences && f.pocReferences.length > 0) {
    ctx.pocUrls = f.pocReferences.map((r) => r.url);
  }

  return ctx;
}

function splitLines(text: string): string[] {
  return text
    .split(/\n|・|•/)
    .map((s) => s.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

function buildSummary(findings: ReportFinding[]): ReportSummary {
  const summary: ReportSummary = {
    total: findings.length,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    immediate: 0,
    kevCount: 0,
    epssHighCount: 0,
  };

  for (const f of findings) {
    const sev = f.riskSignals.severity;
    if (sev === "critical")     summary.critical++;
    else if (sev === "high")    summary.high++;
    else if (sev === "medium")  summary.medium++;
    else if (sev === "low")     summary.low++;

    if (f.recommendedAction.urgency === "immediate") summary.immediate++;
    if (f.riskSignals.kev) summary.kevCount++;
    if ((f.riskSignals.epss ?? 0) >= 0.7) summary.epssHighCount++;
  }

  return summary;
}
