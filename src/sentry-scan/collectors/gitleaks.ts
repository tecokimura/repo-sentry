import { completeCollector, failCollector, startCollector } from "./common.ts";
import type { CollectorResult, Finding, ScanRequest } from "../types.ts";
import { ensureDir, readJsonFile, safeErrorMessage } from "../../shared/utils.ts";

interface GitleaksFinding {
  RuleID?: string;
  Description?: string;
  File?: string;
  StartLine?: number;
  EndLine?: number;
  Secret?: string;
  Match?: string;
  Fingerprint?: string;
}

export async function collectGitleaks(request: ScanRequest): Promise<CollectorResult> {
  const timing = startCollector();

  if (!request.path) {
    return failCollector("gitleaks", timing, "--path is required for gitleaks");
  }

  const rawReportPath = `${request.artifactsDir}/gitleaks.json`;

  try {
    await ensureDir(request.artifactsDir);

    const command = new Deno.Command("gitleaks", {
      args: [
        "detect",
        "--source",
        request.path,
        "--report-format",
        "json",
        "--report-path",
        rawReportPath,
        "--redact",
      ],
      stdout: "piped",
      stderr: "piped",
    });

    const output = await command.output();
    const report = await readJsonFile(rawReportPath).catch(() => []);
    const findings = normalizeGitleaksReport(report, rawReportPath);

    if (output.code !== 0 && findings.length === 0) {
      const stderr = new TextDecoder().decode(output.stderr);
      return failCollector("gitleaks", timing, stderr || `gitleaks exited with ${output.code}`, {
        rawReportPath,
      });
    }

    const notes = output.code !== 0
      ? [`gitleaks exited with ${output.code}; treating report as findings`]
      : [];
    const status = completeCollector("gitleaks", timing, findings.length, {
      rawReportPath,
      notes,
    });

    return { status, findings };
  } catch (error) {
    return failCollector("gitleaks", timing, safeErrorMessage(error), { rawReportPath });
  }
}

export function normalizeGitleaksReport(report: unknown, rawReportPath?: string): Finding[] {
  const items = Array.isArray(report) ? report as GitleaksFinding[] : [];

  return items.map((item) => {
    const location = item.File
      ? `${item.File}${item.StartLine ? `:${item.StartLine}` : ""}`
      : undefined;

    return {
      id: item.Fingerprint ?? item.RuleID,
      tool: "gitleaks",
      category: "secret",
      severity: "high",
      title: item.Description ?? item.RuleID ?? "Potential secret",
      location,
      status: "open",
      rawReportPath,
      raw: {
        ruleId: item.RuleID,
        file: item.File,
        startLine: item.StartLine,
        endLine: item.EndLine,
        fingerprint: item.Fingerprint,
      },
    };
  });
}
