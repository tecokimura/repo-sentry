import type { ScanReport, ScanRequest } from "./types.ts";
import { severityOrder } from "./types.ts";

export const ExitCode = {
  ok: 0,
  policyViolation: 1,
  invalidUsage: 2,
  collectorError: 3,
  permissionMissing: 4,
} as const;

export function evaluatePolicy(report: ScanReport, request: ScanRequest): number {
  const hasPermissionIssue = report.collectorStatuses.some((status) =>
    status.sourceStatus === "permission_missing"
  );
  if (hasPermissionIssue) return ExitCode.permissionMissing;

  const hasCollectorError = report.collectorStatuses.some((status) => status.status === "failed");
  if (hasCollectorError) return ExitCode.collectorError;

  const threshold = severityOrder[request.failOnSeverity];
  const hasBlockingFinding = report.findings.some((finding) =>
    finding.status !== "dismissed" &&
    severityOrder[finding.severity] >= threshold &&
    !isLowEvidenceClearwingFinding(finding)
  );

  return hasBlockingFinding ? ExitCode.policyViolation : ExitCode.ok;
}

function isLowEvidenceClearwingFinding(finding: {
  tool: string;
  evidenceLevel?: string;
}): boolean {
  return finding.tool === "clearwing" &&
    (finding.evidenceLevel === "suspicion" ||
      finding.evidenceLevel === "static_corroboration");
}
