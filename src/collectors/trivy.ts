import { completeCollector, failCollector, startCollector } from "./common.ts";
import type { CollectorResult, Finding, FindingCategory, ScanRequest } from "../types.ts";
import { ensureDir, readJsonFile, safeErrorMessage, toSeverity } from "../utils.ts";

interface TrivyReport {
  Results?: TrivyResult[];
}

interface TrivyResult {
  Target?: string;
  Type?: string;
  Vulnerabilities?: TrivyVulnerability[];
  Misconfigurations?: TrivyMisconfiguration[];
}

interface TrivyVulnerability {
  VulnerabilityID?: string;
  PkgName?: string;
  InstalledVersion?: string;
  FixedVersion?: string;
  Title?: string;
  Description?: string;
  Severity?: string;
  PrimaryURL?: string;
}

interface TrivyMisconfiguration {
  ID?: string;
  Title?: string;
  Description?: string;
  Severity?: string;
  PrimaryURL?: string;
  CauseMetadata?: {
    Resource?: string;
    Provider?: string;
    Service?: string;
    StartLine?: number;
    EndLine?: number;
    Code?: {
      Lines?: Array<{
        Number?: number;
      }>;
    };
  };
}

export async function collectTrivy(request: ScanRequest): Promise<CollectorResult> {
  const timing = startCollector();

  if (!request.path) {
    return failCollector("trivy", timing, "--path is required for trivy");
  }

  const rawReportPath = `${request.artifactsDir}/trivy.json`;

  try {
    await ensureDir(request.artifactsDir);

    const command = new Deno.Command("trivy", {
      args: [
        "fs",
        "--scanners",
        "vuln,misconfig",
        "--format",
        "json",
        "--quiet",
        "--exit-code",
        "0",
        "--output",
        rawReportPath,
        request.path,
      ],
      stdout: "piped",
      stderr: "piped",
    });

    const output = await command.output();
    if (output.code !== 0) {
      const stderr = new TextDecoder().decode(output.stderr);
      return failCollector("trivy", timing, stderr || `trivy exited with ${output.code}`, {
        rawReportPath,
      });
    }

    const report = await readJsonFile(rawReportPath);
    const findings = normalizeTrivyReport(report, rawReportPath);
    const status = completeCollector("trivy", timing, findings.length, { rawReportPath });

    return { status, findings };
  } catch (error) {
    return failCollector("trivy", timing, safeErrorMessage(error), { rawReportPath });
  }
}

export function normalizeTrivyReport(report: unknown, rawReportPath?: string): Finding[] {
  const trivyReport = report as TrivyReport;
  const results = Array.isArray(trivyReport.Results) ? trivyReport.Results : [];
  const findings: Finding[] = [];

  for (const result of results) {
    for (const vulnerability of result.Vulnerabilities ?? []) {
      findings.push(normalizeVulnerability(result, vulnerability, rawReportPath));
    }

    for (const misconfiguration of result.Misconfigurations ?? []) {
      findings.push(normalizeMisconfiguration(result, misconfiguration, rawReportPath));
    }
  }

  return findings;
}

function normalizeVulnerability(
  result: TrivyResult,
  vulnerability: TrivyVulnerability,
  rawReportPath?: string,
): Finding {
  const title = vulnerability.Title ??
    `${vulnerability.VulnerabilityID ?? "Vulnerability"} in ${vulnerability.PkgName ?? "package"}`;

  return {
    id: vulnerability.VulnerabilityID,
    tool: "trivy",
    category: result.Type === "container_image"
      ? "container-vulnerability"
      : "dependency-vulnerability",
    severity: toSeverity(vulnerability.Severity),
    title,
    description: vulnerability.Description,
    location: result.Target,
    status: "open",
    url: vulnerability.PrimaryURL,
    identifiers: vulnerability.VulnerabilityID ? [vulnerability.VulnerabilityID] : [],
    packageName: vulnerability.PkgName,
    packageVersion: vulnerability.InstalledVersion,
    rawReportPath,
    raw: {
      target: result.Target,
      type: result.Type,
      fixedVersion: vulnerability.FixedVersion,
    },
  };
}

function normalizeMisconfiguration(
  result: TrivyResult,
  misconfiguration: TrivyMisconfiguration,
  rawReportPath?: string,
): Finding {
  const location = formatMisconfigurationLocation(result, misconfiguration);

  return {
    id: misconfiguration.ID,
    tool: "trivy",
    category: toMisconfigurationCategory(result.Type),
    severity: toSeverity(misconfiguration.Severity),
    title: misconfiguration.Title ?? misconfiguration.ID ?? "Misconfiguration",
    description: misconfiguration.Description,
    location,
    status: "open",
    url: misconfiguration.PrimaryURL,
    identifiers: misconfiguration.ID ? [misconfiguration.ID] : [],
    rawReportPath,
    raw: {
      target: result.Target,
      type: result.Type,
      resource: misconfiguration.CauseMetadata?.Resource,
      provider: misconfiguration.CauseMetadata?.Provider,
      service: misconfiguration.CauseMetadata?.Service,
    },
  };
}

function formatMisconfigurationLocation(
  result: TrivyResult,
  misconfiguration: TrivyMisconfiguration,
): string | undefined {
  const target = result.Target;
  const startLine = misconfiguration.CauseMetadata?.StartLine ??
    misconfiguration.CauseMetadata?.Code?.Lines?.[0]?.Number;
  if (!target) return undefined;
  return startLine ? `${target}:${startLine}` : target;
}

function toMisconfigurationCategory(type: string | undefined): FindingCategory {
  if (type === "terraform" || type === "kubernetes" || type === "cloudformation") {
    return "iac-misconfiguration";
  }
  return "scanner-diagnostic";
}
