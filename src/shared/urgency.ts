export type Urgency = "immediate" | "planned" | "deferred";

/**
 * KEV / severity / EPSS から urgency を導出する。
 * sentry-report（ReportInput 生成）と sentry-watch（差分検出）で共通のルール。
 *
 * Rules:
 *   kev あり または severity=critical      → immediate
 *   severity=high、または medium && epss>=0.4 → planned
 *   それ以外                               → deferred
 */
export function deriveUrgency(
  finding: { severity: string; kev?: unknown; epss?: { epss: number } },
): Urgency {
  if (finding.kev) return "immediate";
  if (finding.severity === "critical") return "immediate";
  const epss = finding.epss?.epss ?? 0;
  if (finding.severity === "high" || (finding.severity === "medium" && epss >= 0.4)) {
    return "planned";
  }
  return "deferred";
}
