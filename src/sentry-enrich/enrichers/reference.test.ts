import { assertEquals } from "jsr:@std/assert@1";
import { validateReferences } from "./reference.ts";
import type { EnrichedFinding } from "../types.ts";

function finding(id: string, url?: string, aliases?: string[]): EnrichedFinding {
  return {
    id,
    tool: "trivy",
    category: "dependency-vulnerability",
    severity: "medium",
    title: id,
    status: "open",
    url,
    osv: aliases?.length ? { id, aliases } : undefined,
  } as EnrichedFinding;
}

Deno.test("finding.id と URL の CVE が一致する場合 → 問題なし", () => {
  const result = validateReferences([
    finding("CVE-2023-50164", "https://avd.aquasec.com/nvd/cve-2023-50164"),
  ]);
  assertEquals(result[0].url, "https://avd.aquasec.com/nvd/cve-2023-50164");
  assertEquals(result[0].invalidReferences, undefined);
  assertEquals(result[0].canonicalReference, "https://avd.aquasec.com/nvd/cve-2023-50164");
});

Deno.test("finding.id と URL の CVE が不一致 → 無効化して canonical 生成", () => {
  const result = validateReferences([
    finding("CVE-2023-50164", "https://avd.aquasec.com/nvd/cve-2026-55568"),
  ]);
  assertEquals(result[0].url, undefined);
  assertEquals(result[0].invalidReferences, ["https://avd.aquasec.com/nvd/cve-2026-55568"]);
  assertEquals(result[0].canonicalReference, "https://avd.aquasec.com/nvd/cve-2023-50164");
});

Deno.test("GHSA URL で finding.id が GHSA と一致する → 問題なし", () => {
  const result = validateReferences([
    finding("GHSA-abcd-1234-efgh", "https://github.com/advisories/GHSA-abcd-1234-efgh"),
  ]);
  assertEquals(result[0].url, "https://github.com/advisories/GHSA-abcd-1234-efgh");
  assertEquals(result[0].invalidReferences, undefined);
});

Deno.test("CVE だが URL なし → canonical のみ生成", () => {
  const result = validateReferences([finding("CVE-2023-50164")]);
  assertEquals(result[0].url, undefined);
  assertEquals(result[0].invalidReferences, undefined);
  assertEquals(result[0].canonicalReference, "https://avd.aquasec.com/nvd/cve-2023-50164");
});

Deno.test("URL の CVE が OSV alias と一致する → 問題なし", () => {
  // finding.id = GHSA だが alias に CVE があり、URL が alias CVE を指している
  const result = validateReferences([
    finding(
      "GHSA-abcd-1234-efgh",
      "https://avd.aquasec.com/nvd/cve-2023-50164",
      ["CVE-2023-50164"],
    ),
  ]);
  assertEquals(result[0].url, "https://avd.aquasec.com/nvd/cve-2023-50164");
  assertEquals(result[0].invalidReferences, undefined);
});

Deno.test("CVE 形式でない ID → canonical なし、URL はそのまま", () => {
  const result = validateReferences([
    finding("OSV-2023-12345", "https://osv.dev/vulnerability/OSV-2023-12345"),
  ]);
  assertEquals(result[0].url, "https://osv.dev/vulnerability/OSV-2023-12345");
  assertEquals(result[0].canonicalReference, undefined);
});
