import type { EnrichedFinding } from "../types.ts";
import type { OsvAdvisory } from "../types.ts";

const OSV_API = "https://api.osv.dev/v1/query";

export async function enrichWithOsv(findings: EnrichedFinding[]): Promise<EnrichedFinding[]> {
  return await Promise.all(findings.map(async (f) => {
    const id = findOsvId(f.identifiers);
    if (!id) return f;
    const advisory = await fetchOsvAdvisory(id);
    if (!advisory) return f;
    return { ...f, osv: advisory };
  }));
}

function findOsvId(identifiers?: string[]): string | undefined {
  if (!identifiers) return undefined;
  return identifiers.find((id) => id.startsWith("CVE-") || id.startsWith("GHSA-"));
}

async function fetchOsvAdvisory(id: string): Promise<OsvAdvisory | undefined> {
  try {
    const res = await fetch(OSV_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) return undefined;
    const data = await res.json();
    const vuln = data.vulns?.[0];
    if (!vuln) return undefined;
    return {
      id: vuln.id,
      aliases: vuln.aliases,
      summary: vuln.summary,
      publishedAt: vuln.published,
      modifiedAt: vuln.modified,
    };
  } catch {
    return undefined;
  }
}
