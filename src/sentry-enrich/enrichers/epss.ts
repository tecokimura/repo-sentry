import type { EnrichedFinding } from "../types.ts";
import type { EpssScore } from "../types.ts";

const EPSS_API = "https://api.first.org/data/v1/epss";

export async function enrichWithEpss(findings: EnrichedFinding[]): Promise<EnrichedFinding[]> {
  const cveIds = findings
    .flatMap((f) => f.identifiers ?? [])
    .filter((id) => id.startsWith("CVE-"));
  if (cveIds.length === 0) return findings;

  const scores = await fetchEpssScores(cveIds);
  if (scores.size === 0) return findings;

  return findings.map((f) => {
    const cveId = f.identifiers?.find((id) => id.startsWith("CVE-"));
    if (!cveId) return f;
    const score = scores.get(cveId);
    if (!score) return f;
    return { ...f, epss: score };
  });
}

async function fetchEpssScores(cveIds: string[]): Promise<Map<string, EpssScore>> {
  try {
    const params = new URLSearchParams({ cve: cveIds.join(",") });
    const res = await fetch(`${EPSS_API}?${params}`);
    if (!res.ok) return new Map();
    const data = await res.json();
    const map = new Map<string, EpssScore>();
    for (const item of data.data ?? []) {
      map.set(item.cve, {
        cve: item.cve,
        epss: parseFloat(item.epss),
        percentile: parseFloat(item.percentile),
        date: item.date,
      });
    }
    return map;
  } catch {
    return new Map();
  }
}
