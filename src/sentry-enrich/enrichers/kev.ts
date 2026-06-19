import type { EnrichedFinding } from "../types.ts";
import type { KevEntry } from "../types.ts";

const KEV_URL =
  "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";

interface KevCatalog {
  vulnerabilities: {
    cveID: string;
    vendorProject: string;
    product: string;
    dateAdded: string;
    requiredAction: string;
    dueDate: string;
  }[];
}

let _kevCache: Map<string, KevEntry> | undefined;

async function loadKev(): Promise<Map<string, KevEntry>> {
  if (_kevCache) return _kevCache;
  const res = await fetch(KEV_URL);
  if (!res.ok) throw new Error(`KEV fetch failed: ${res.status}`);
  const catalog: KevCatalog = await res.json();
  _kevCache = new Map(
    catalog.vulnerabilities.map((v) => [
      v.cveID,
      {
        cveId: v.cveID,
        vendorProject: v.vendorProject,
        product: v.product,
        dateAdded: v.dateAdded,
        requiredAction: v.requiredAction,
        dueDate: v.dueDate,
      },
    ]),
  );
  return _kevCache;
}

export async function enrichWithKev(findings: EnrichedFinding[]): Promise<EnrichedFinding[]> {
  let kev: Map<string, KevEntry>;
  try {
    kev = await loadKev();
  } catch {
    return findings;
  }

  return findings.map((f) => {
    const cveId = f.identifiers?.find((id) => id.startsWith("CVE-"));
    if (!cveId) return f;
    const entry = kev.get(cveId);
    if (!entry) return f;
    return { ...f, kev: entry };
  });
}
