import type { EnrichedFinding, OsvAdvisory, OsvReference, PocReference } from "../types.ts";

const OSV_VULNS_API = "https://api.osv.dev/v1/vulns";

// GitHub URL でPoC と判断するパターン
const POC_GITHUB_PATTERNS = [
  /\/CVE-\d{4}-\d+/i,
  /[-_/]poc($|[-_/])/i,
  /[-_/]exploit($|[-_/])/i,
];

export async function enrichWithOsv(findings: EnrichedFinding[]): Promise<EnrichedFinding[]> {
  return await Promise.all(findings.map(async (f) => {
    const id = findOsvId(f.identifiers);
    if (!id) return f;
    const result = await fetchOsvAdvisory(id);
    if (!result) return f;
    const { advisory, pocRefs } = result;
    return {
      ...f,
      osv: advisory,
      ...(pocRefs.length > 0 ? { pocReferences: pocRefs } : {}),
    };
  }));
}

function findOsvId(identifiers?: string[]): string | undefined {
  if (!identifiers) return undefined;
  return identifiers.find((id) => id.startsWith("CVE-") || id.startsWith("GHSA-"));
}

async function fetchOsvAdvisory(
  id: string,
): Promise<{ advisory: OsvAdvisory; pocRefs: PocReference[] } | undefined> {
  try {
    const res = await fetch(`${OSV_VULNS_API}/${id}`);
    if (!res.ok) return undefined;
    const vuln = await res.json() as {
      id: string;
      aliases?: string[];
      summary?: string;
      published?: string;
      modified?: string;
      references?: Array<{ type: string; url: string }>;
    };

    const references: OsvReference[] = (vuln.references ?? []).map((r) => ({
      type: r.type,
      url: r.url,
    }));

    const pocRefs = extractPocFromReferences(references);

    const advisory: OsvAdvisory = {
      id: vuln.id,
      aliases: vuln.aliases,
      summary: vuln.summary,
      publishedAt: vuln.published,
      modifiedAt: vuln.modified,
      references,
    };

    return { advisory, pocRefs };
  } catch {
    return undefined;
  }
}

function extractPocFromReferences(refs: OsvReference[]): PocReference[] {
  const seen = new Set<string>();
  const result: PocReference[] = [];

  for (const ref of refs) {
    if (seen.has(ref.url)) continue;

    const isExploit = ref.type === "EXPLOIT";
    const isGithubPoc =
      ref.url.includes("github.com") &&
      POC_GITHUB_PATTERNS.some((p) => p.test(ref.url));

    if (isExploit || isGithubPoc) {
      seen.add(ref.url);
      result.push({ url: ref.url, source: "osv" });
    }
  }

  return result;
}
