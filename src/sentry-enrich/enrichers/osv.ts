import type { EnrichedFinding, OsvAdvisory, OsvReference, PocInfo, PocSource } from "../types.ts";

const OSV_VULNS_API = "https://api.osv.dev/v1/vulns";

// GitHub URL で PoC と判断するパターン（medium confidence）
// リポジトリ名（owner/repo の repo 部分）にマッチさせる。
// パス深部の一致（CVE データベース・アドバイザリ集など）を除外するため先頭から照合する。
// リポジトリ名（owner/repo の repo 部分）に CVE ID または "poc" が単語として含まれる場合に PoC と判定。
// パス深部の一致（CVEProject/cvelistV5 等）は除外。"poc" は [-_] で区切られた単語にのみマッチ。
const POC_GITHUB_REPO_RE =
  /^https:\/\/github\.com\/[^/]+\/(?:CVE-\d{4}-\d+|(?:[^/]*[-_])?poc(?:[-_][^/]*)?$)/i;

export async function enrichWithOsv(findings: EnrichedFinding[]): Promise<EnrichedFinding[]> {
  return await Promise.all(findings.map(async (f) => {
    const id = findOsvId(f.identifiers);
    if (!id) return f;
    const result = await fetchOsvAdvisory(id);
    if (!result) return f;
    const { advisory, poc } = result;
    return {
      ...f,
      osv: advisory,
      ...(poc ? { poc } : {}),
    };
  }));
}

function findOsvId(identifiers?: string[]): string | undefined {
  if (!identifiers) return undefined;
  return identifiers.find((id) => id.startsWith("CVE-") || id.startsWith("GHSA-"));
}

async function fetchOsvAdvisory(
  id: string,
): Promise<{ advisory: OsvAdvisory; poc?: PocInfo } | undefined> {
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

    const poc = buildPocInfo(references);

    const advisory: OsvAdvisory = {
      id: vuln.id,
      aliases: vuln.aliases,
      summary: vuln.summary,
      publishedAt: vuln.published,
      modifiedAt: vuln.modified,
      references,
    };

    return { advisory, poc };
  } catch {
    return undefined;
  }
}

function buildPocInfo(refs: OsvReference[]): PocInfo | undefined {
  const seen = new Set<string>();
  const sources: PocSource[] = [];

  for (const ref of refs) {
    if (seen.has(ref.url)) continue;

    if (ref.type === "EXPLOIT") {
      seen.add(ref.url);
      sources.push({ url: ref.url, source: "osv-reference", reason: "OSV reference type EXPLOIT" });
    } else if (POC_GITHUB_REPO_RE.test(ref.url)) {
      seen.add(ref.url);
      sources.push({ url: ref.url, source: "osv-reference", reason: "OSV reference GitHub PoC URL pattern" });
    }
  }

  if (sources.length === 0) return undefined;

  const confidence = sources.some((s) => s.reason.includes("EXPLOIT")) ? "high" : "medium";
  return { found: true, confidence, sources };
}
