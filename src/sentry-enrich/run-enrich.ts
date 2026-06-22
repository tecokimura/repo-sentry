import type { ScanReport } from "../sentry-scan/types.ts";
import type { EnrichedFinding, EnrichedReport, EnrichRequest } from "./types.ts";
import { enrichWithOsv } from "./enrichers/osv.ts";
import { enrichWithKev } from "./enrichers/kev.ts";
import { enrichWithEpss } from "./enrichers/epss.ts";
import { validateReferences } from "./enrichers/reference.ts";
import { enrichWithGithubPoc } from "./enrichers/poc.ts";
import { nowIso } from "../shared/utils.ts";
import { readJsonFile } from "../shared/utils.ts";
import { summarizeSeverities } from "../shared/utils.ts";

export async function runEnrich(request: EnrichRequest): Promise<EnrichedReport> {
  const scan = await readJsonFile(request.input) as ScanReport;

  let findings: EnrichedFinding[] = scan.findings.map((f) => ({ ...f }));

  const githubToken = Deno.env.get("GITHUB_TOKEN");

  [findings] = await Promise.all([
    enrichWithOsv(findings)
      .then((f) => enrichWithKev(f))
      .then((f) => enrichWithEpss(f))
      .then((f) => validateReferences(f))
      .then((f) => {
        if (githubToken !== undefined) {
          console.error(`[sentry-enrich] GitHub PoC 検索を実行します（GITHUB_TOKEN あり）`);
          return enrichWithGithubPoc(f, { githubToken });
        }
        return f;
      }),
  ]);

  return {
    scanId: scan.scanId,
    enrichId: crypto.randomUUID(),
    profile: scan.profile,
    repository: scan.repository,
    path: scan.path,
    gitBranch: scan.gitBranch,
    gitCommit: scan.gitCommit,
    scannedAt: scan.scannedAt,
    enrichedAt: nowIso(),
    toolVersions: scan.toolVersions,
    summary: summarizeSeverities(findings),
    collectorStatuses: scan.collectorStatuses,
    findings,
  };
}
