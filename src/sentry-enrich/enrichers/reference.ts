import type { EnrichedFinding } from "../types.ts";

// URL 中の CVE ID を抽出（cve-2023-50164 形式）
const CVE_IN_URL = /(?:^|[\/-])cve-(\d{4}-\d+)(?:$|[^\d])/i;
// URL 中の GHSA ID を抽出（GHSA-xxxx-xxxx-xxxx 形式）
const GHSA_IN_URL = /(?:^|\/)(?:GHSA-)([a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})(?:$|[^\w-])/i;

function extractIdFromUrl(url: string): { type: "cve" | "ghsa"; id: string } | null {
  const cveMatch = url.match(CVE_IN_URL);
  if (cveMatch) return { type: "cve", id: `CVE-${cveMatch[1]}` };
  const ghsaMatch = url.match(GHSA_IN_URL);
  if (ghsaMatch) return { type: "ghsa", id: `GHSA-${ghsaMatch[1]}` };
  return null;
}

function buildCanonicalUrl(id: string): string | undefined {
  if (/^CVE-\d{4}-\d+$/i.test(id)) {
    return `https://avd.aquasec.com/nvd/${id.toLowerCase()}`;
  }
  if (/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i.test(id)) {
    return `https://github.com/advisories/${id.toUpperCase()}`;
  }
  return undefined;
}

function isMismatch(findingId: string, url: string, aliases: string[]): boolean {
  const extracted = extractIdFromUrl(url);
  if (!extracted) return false;

  const urlIdNorm = extracted.id.toUpperCase();
  const findingIdNorm = findingId.toUpperCase();

  // finding ID と一致すれば問題なし
  if (urlIdNorm === findingIdNorm) return false;

  // OSV aliases と一致する場合も問題なし（エイリアス経由の正規 URL）
  if (aliases.some((a) => a.toUpperCase() === urlIdNorm)) return false;

  return true;
}

export function validateReferences(findings: EnrichedFinding[]): EnrichedFinding[] {
  return findings.map((f) => {
    const id = f.id;
    if (!id) return f;

    const result: EnrichedFinding = { ...f };
    const aliases = f.osv?.aliases ?? [];

    // canonicalReference を ID から生成
    const canonical = buildCanonicalUrl(id);
    if (canonical) result.canonicalReference = canonical;

    // finding.url の検証
    if (f.url && isMismatch(id, f.url, aliases)) {
      console.error(
        `[sentry-enrich] warning: reference mismatch: ${id} の url が別 ID を指しています → ${f.url}`,
      );
      result.invalidReferences = [...(f.invalidReferences ?? []), f.url];
      result.url = undefined;
    }

    return result;
  });
}
