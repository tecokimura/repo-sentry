import { completeCollector, failCollector, startCollector } from "./common.ts";
import type { CollectorResult, Finding, FindingCategory, ScanRequest } from "../types.ts";
import { ensureDir, readJsonFile, safeErrorMessage, sbomOutputPath, toSeverity } from "../../shared/utils.ts";

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
  CweIDs?: string[];
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

    const notes: string[] = [];
    if (request.sbom) {
      const sbomPath = sbomOutputPath(request.output, request.artifactsDir);
      const sbomError = await generateSbom(request.path, sbomPath);
      notes.push(sbomError ?? `SBOM generated: ${sbomPath}`);
    }

    const status = completeCollector("trivy", timing, findings.length, { rawReportPath, notes });

    return { status, findings };
  } catch (error) {
    return failCollector("trivy", timing, safeErrorMessage(error), { rawReportPath });
  }
}

async function generateSbom(path: string, outputPath: string): Promise<string | undefined> {
  try {
    await ensureDir(outputPath.slice(0, outputPath.lastIndexOf("/")));
    const command = new Deno.Command("trivy", {
      args: [
        "fs",
        "--scanners",
        "vuln",
        "--format",
        "cyclonedx",
        "--quiet",
        "--output",
        outputPath,
        path,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();
    if (output.code !== 0) {
      const stderr = new TextDecoder().decode(output.stderr);
      return `SBOM generation failed: ${stderr || `trivy exited with ${output.code}`}`;
    }
    await annotateSbom(outputPath, path);
    return undefined;
  } catch (error) {
    return `SBOM generation failed: ${safeErrorMessage(error)}`;
  }
}

async function annotateSbom(sbomPath: string, scanTarget: string): Promise<void> {
  try {
    const raw = await Deno.readTextFile(sbomPath);
    const sbom = JSON.parse(raw) as Record<string, unknown>;
    const metadata = (sbom.metadata ?? {}) as Record<string, unknown>;
    const existing = Array.isArray(metadata.properties) ? (metadata.properties as unknown[]) : [];

    const props: Array<{ name: string; value: string }> = [
      { name: "repo-sentry:scan:target", value: scanTarget },
      { name: "repo-sentry:scan:scanners", value: "vuln" },
    ];

    const dbDate = await getTrivyDbDate();
    if (dbDate) props.push({ name: "repo-sentry:scan:dbUpdatedAt", value: dbDate });

    const componentCount = Array.isArray(sbom.components) ? sbom.components.length : 0;
    props.push({ name: "repo-sentry:scan:componentCount", value: String(componentCount) });
    props.push({
      name: "repo-sentry:scan:status",
      value: componentCount === 0 ? "no_components_found" : "completed",
    });

    metadata.properties = [...existing, ...props];
    sbom.metadata = metadata;
    await Deno.writeTextFile(sbomPath, JSON.stringify(sbom, null, 2));
  } catch {
    // best-effort; don't fail SBOM generation if annotation fails
  }
}

async function getTrivyDbDate(): Promise<string | undefined> {
  try {
    const cmd = new Deno.Command("trivy", {
      args: ["version", "--format", "json"],
      stdout: "piped",
      stderr: "piped",
    });
    const out = await cmd.output();
    if (out.code !== 0) return undefined;
    const json = JSON.parse(new TextDecoder().decode(out.stdout)) as Record<string, unknown>;
    const db = json["VulnerabilityDB"] as Record<string, string> | undefined;
    return db?.["UpdatedAt"];
  } catch {
    return undefined;
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
    fixedVersion: vulnerability.FixedVersion,
    cweIds: vulnerability.CweIDs?.length ? vulnerability.CweIDs : undefined,
    rawReportPath,
    raw: {
      target: result.Target,
      type: result.Type,
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
