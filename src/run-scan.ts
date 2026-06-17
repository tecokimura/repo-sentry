import { collectDependabot } from "./collectors/dependabot.ts";
import { collectGitleaks } from "./collectors/gitleaks.ts";
import { collectTrivy } from "./collectors/trivy.ts";
import type {
  CollectorResult,
  CollectorStatus,
  ScanReport,
  ScanRequest,
  ToolName,
} from "./types.ts";
import { nowIso, summarizeSeverities } from "./utils.ts";

export async function runScan(request: ScanRequest): Promise<ScanReport> {
  const collectorResults: CollectorResult[] = await Promise.all(
    request.tools.map((tool) => runCollector(tool, request)),
  );

  const findings = collectorResults.flatMap((result) => result.findings);
  const collectorStatuses = collectorResults.map((result) => result.status);

  return {
    repository: request.repo,
    path: request.path,
    scannedAt: nowIso(),
    summary: summarizeSeverities(findings),
    collectorStatuses,
    findings,
  };
}

async function runCollector(tool: ToolName, request: ScanRequest): Promise<CollectorResult> {
  switch (tool) {
    case "dependabot":
      return await collectDependabot(request);
    case "gitleaks":
      return await collectGitleaks(request);
    case "trivy":
      return await collectTrivy(request);
    case "trufflehog":
      return notImplemented(tool, "TruffleHog collector is planned for a later phase");
    case "clearwing":
      return notImplemented(tool, "Clearwing collector is planned for a later phase");
  }
}

function notImplemented(tool: ToolName, note: string): CollectorResult {
  const timestamp = nowIso();
  const status: CollectorStatus = {
    tool,
    status: "failed",
    startedAt: timestamp,
    finishedAt: timestamp,
    durationMs: 0,
    findingsCount: 0,
    error: "Collector is not implemented yet",
    notes: [note],
  };

  return {
    status,
    findings: [],
  };
}
