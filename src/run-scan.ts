import { collectDependabot } from "./collectors/dependabot.ts";
import { collectGitleaks } from "./collectors/gitleaks.ts";
import { collectTrivy } from "./collectors/trivy.ts";
import { enrichWithClearwing } from "./collectors/clearwing.ts";
import type {
  CollectorResult,
  CollectorStatus,
  ScanReport,
  ScanRequest,
  ToolName,
} from "./types.ts";
import { nowIso, summarizeSeverities } from "./utils.ts";

export async function runScan(request: ScanRequest): Promise<ScanReport> {
  // Clearwing is a post-processing enrichment step, not a discovery collector.
  // Run all other tools in parallel first, then enrich.
  const discoveryTools = request.tools.filter((t) => t !== "clearwing");
  const collectorResults: CollectorResult[] = await Promise.all(
    discoveryTools.map((tool) => runCollector(tool, request)),
  );

  let findings = collectorResults.flatMap((result) => result.findings);
  const collectorStatuses = collectorResults.map((result) => result.status);

  if (request.tools.includes("clearwing") && request.clearwing?.ackRisk) {
    const cwResult = await enrichWithClearwing(request, findings);
    findings = cwResult.enriched;
    collectorStatuses.push(cwResult.status);
  }

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
      // Should not be reached; clearwing is handled above as post-processing.
      return notImplemented(tool, "Clearwing は後処理ステップとして別途実行されます");
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
