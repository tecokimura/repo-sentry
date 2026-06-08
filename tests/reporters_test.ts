import { evaluatePolicy, ExitCode } from "../src/policy.ts";
import { renderMarkdownReport } from "../src/reporters/markdown.ts";
import type { ScanReport, ScanRequest } from "../src/types.ts";
import { assert, assertEquals } from "./assert.ts";

Deno.test("renderMarkdownReport includes collector statuses and findings", () => {
  const markdown = renderMarkdownReport(sampleReport());

  assert(markdown.includes("## Collector Statuses"));
  assert(markdown.includes("enabled_no_alerts"));
  assert(markdown.includes("Possible token"));
});

Deno.test("evaluatePolicy fails on high findings", () => {
  const exitCode = evaluatePolicy(sampleReport(), sampleRequest());
  assertEquals(exitCode, ExitCode.policyViolation);
});

Deno.test("evaluatePolicy treats permission_missing as a distinct exit code", () => {
  const report = sampleReport();
  report.collectorStatuses[0].sourceStatus = "permission_missing";

  const exitCode = evaluatePolicy(report, sampleRequest());
  assertEquals(exitCode, ExitCode.permissionMissing);
});

function sampleReport(): ScanReport {
  return {
    repository: "owner/name",
    path: "./target-repo",
    scannedAt: "2026-06-08T00:00:00.000Z",
    summary: {
      critical: 0,
      high: 1,
      medium: 0,
      low: 0,
      info: 0,
      unknown: 0,
    },
    collectorStatuses: [
      {
        tool: "dependabot",
        status: "completed",
        sourceStatus: "enabled_no_alerts",
        startedAt: "2026-06-08T00:00:00.000Z",
        finishedAt: "2026-06-08T00:00:00.001Z",
        durationMs: 1,
        findingsCount: 0,
        notes: [],
      },
    ],
    findings: [
      {
        tool: "gitleaks",
        category: "secret",
        severity: "high",
        title: "Possible token",
        location: "src/config.ts:18",
        status: "open",
      },
    ],
  };
}

function sampleRequest(): ScanRequest {
  return {
    repo: "owner/name",
    path: "./target-repo",
    tools: ["gitleaks", "dependabot"],
    format: "json",
    artifactsDir: "reports/raw",
    failOnSeverity: "high",
  };
}
