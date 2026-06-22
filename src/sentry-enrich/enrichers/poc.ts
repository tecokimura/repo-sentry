import type { EnrichedFinding, PocReference } from "../types.ts";

const GITHUB_SEARCH_API = "https://api.github.com/search/repositories";

// 1リクエストあたりの待機時間（ms）。未認証: 6000ms, 認証済み: 2000ms
const RATE_LIMIT_DELAY_MS = 2100;

export interface PocEnrichConfig {
  githubToken?: string;
}

/**
 * GitHub Search API を使って CVE ID に対応する PoC リポジトリを検索する（Phase B）。
 * OSV enrichment で既に pocReferences が付いている finding はスキップする。
 */
export async function enrichWithGithubPoc(
  findings: EnrichedFinding[],
  config: PocEnrichConfig,
): Promise<EnrichedFinding[]> {
  const results: EnrichedFinding[] = [];

  for (const f of findings) {
    const cveId = findCveId(f.identifiers);
    if (!cveId || (f.pocReferences && f.pocReferences.length > 0)) {
      results.push(f);
      continue;
    }

    const found = await searchGithubPoc(cveId, config.githubToken);
    if (found.length > 0) {
      const existing = f.pocReferences ?? [];
      results.push({ ...f, pocReferences: [...existing, ...found] });
    } else {
      results.push(f);
    }

    // GitHub Search API のレート制限を守る
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  return results;
}

function findCveId(identifiers?: string[]): string | undefined {
  return identifiers?.find((id) => id.startsWith("CVE-"));
}

async function searchGithubPoc(
  cveId: string,
  token?: string,
): Promise<PocReference[]> {
  try {
    const q = encodeURIComponent(`${cveId} poc exploit in:name,description`);
    const url = `${GITHUB_SEARCH_API}?q=${q}&sort=stars&order=desc&per_page=3`;

    const headers: Record<string, string> = {
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.error(`[sentry-enrich/poc] GitHub Search API error ${res.status} for ${cveId}`);
      return [];
    }

    const data = await res.json() as {
      items?: Array<{ html_url: string; full_name: string; stargazers_count: number }>;
    };

    return (data.items ?? [])
      .filter((item) => isPocRepo(item.full_name, cveId))
      .map((item) => ({ url: item.html_url, source: "github-search" as const }));
  } catch {
    return [];
  }
}

function isPocRepo(fullName: string, cveId: string): boolean {
  const name = fullName.toLowerCase();
  const cve = cveId.toLowerCase();
  return (
    name.includes(cve) ||
    name.includes("poc") ||
    name.includes("exploit")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
