import type { EnrichedFinding, PocConfidence, PocInfo, PocSource } from "../types.ts";
import { searchExploitDb } from "./exploitdb.ts";

const GITHUB_SEARCH_API = "https://api.github.com/search/repositories";

// 1リクエストあたりの待機時間（ms）。未認証: 6000ms, 認証済み: 2000ms
const RATE_LIMIT_DELAY_MS = 2100;

const CONFIDENCE_RANK: Record<PocConfidence, number> = { low: 0, medium: 1, high: 2 };

/** 既存の confidence を下げないよう、高い方を採用する */
export function maxConfidence(a: PocConfidence, b: PocConfidence): PocConfidence {
  return CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b;
}

export interface PocEnrichConfig {
  githubToken?: string;
  cacheDir?: string;
}

/**
 * Exploit-DB CSV をキャッシュ検索して PoC を付与する。
 * トークン不要・ローカル検索のためレート制限なし。
 * CVE ID がない finding はスキップ。
 */
export async function enrichWithExploitDbPoc(
  findings: EnrichedFinding[],
  config: { cacheDir: string },
): Promise<EnrichedFinding[]> {
  const results: EnrichedFinding[] = [];

  for (const f of findings) {
    const cveId = findCveId(f.identifiers);
    if (!cveId) {
      results.push(f);
      continue;
    }

    const entries = await searchExploitDb(cveId, config.cacheDir);
    if (entries.length === 0) {
      results.push(f);
      continue;
    }

    const newSources: PocSource[] = entries.map((e) => ({
      url: e.url,
      source: "exploitdb" as const,
      reason: `Exploit-DB #${e.id}: ${e.description}${e.verified ? " (verified)" : ""}`,
    }));

    const existing = f.poc;
    const merged: PocInfo = {
      found: true,
      // OSV 由来で high が付いている場合に medium へ降格させない
      confidence: maxConfidence(existing?.confidence ?? "low", "medium"),
      sources: [...(existing?.sources ?? []), ...newSources],
    };
    results.push({ ...f, poc: merged });
  }

  return results;
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
    if (!cveId || (f.poc && f.poc.sources.length > 0)) {
      results.push(f);
      continue;
    }

    const newSources = await searchGithubPoc(cveId, config.githubToken);
    if (newSources.length > 0) {
      const existing = f.poc;
      const merged: PocInfo = {
        found: true,
        confidence: existing?.confidence ?? "low",
        sources: [...(existing?.sources ?? []), ...newSources],
      };
      results.push({ ...f, poc: merged });
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
): Promise<PocSource[]> {
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
      .map((item) => ({
        url: item.html_url,
        source: "github-search" as const,
        reason: `GitHub Search: "${cveId}" にマッチ`,
      }));
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
