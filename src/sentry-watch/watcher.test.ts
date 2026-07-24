import { assertEquals } from "jsr:@std/assert@1";
import { diffReports } from "./watcher.ts";
import type { EnrichedReport } from "../sentry-enrich/types.ts";
import baselineJson from "../../fixtures/watch-test/enriched_baseline.json" with { type: "json" };
import changedJson from "../../fixtures/watch-test/enriched_changed.json" with { type: "json" };

const baseline = baselineJson as unknown as EnrichedReport;
const changed = changedJson as unknown as EnrichedReport;

function runDiff() {
  return diffReports(baseline, changed, {
    baselineEnrichedFile: "fixtures/watch-test/enriched_baseline.json",
    newEnrichedFile: "fixtures/watch-test/enriched_changed.json",
  });
}

function changeFor(id: string) {
  const change = runDiff().changes.find((c) => c.findingId === id);
  if (!change) throw new Error(`change not found: ${id}`);
  return change;
}

Deno.test("summary: fixture の全変化パターンを集計する", () => {
  const diff = runDiff();
  assertEquals(diff.watchVersion, "1");
  assertEquals(diff.baseline.scannedAt, baseline.scannedAt);
  assertEquals(diff.summary, {
    totalFindings: 6,
    changed: 6,
    kevAdded: 1,
    urgencyUpgraded: 2,
    epssRisen: 2,
    osvUpdated: 1,
    newFindings: 1,
    removedFindings: 1,
  });
});

Deno.test("kev_added: KEV 新規登録は urgency 上昇も伴う", () => {
  const change = changeFor("CVE-2999-1001");
  assertEquals(change.changeTypes, ["kev_added", "urgency_upgraded"]);
  assertEquals(change.before?.kev, false);
  assertEquals(change.after?.kev, true);
  assertEquals(change.before?.urgency, "planned");
  assertEquals(change.after?.urgency, "immediate");
  assertEquals(change.package, { name: "alpha-utils", version: "1.2.3" });
});

Deno.test("epss_risen: 0.05 以上の上昇を検出する", () => {
  const change = changeFor("CVE-2999-1002");
  assertEquals(change.changeTypes, ["epss_risen"]);
  assertEquals(change.before?.epss, 0.10);
  assertEquals(change.after?.epss, 0.16);
});

Deno.test("epss_risen: 0.4 閾値またぎは delta が 0.05 未満でも検出し、medium は urgency も上昇する", () => {
  const change = changeFor("CVE-2999-1003");
  assertEquals(change.changeTypes, ["urgency_upgraded", "epss_risen"]);
  assertEquals(change.before?.urgency, "deferred");
  assertEquals(change.after?.urgency, "planned");
});

Deno.test("osv_updated: modifiedAt の更新を検出する", () => {
  const change = changeFor("CVE-2999-1004");
  assertEquals(change.changeTypes, ["osv_updated"]);
  assertEquals(change.before?.osvModifiedAt, "2024-01-15T00:00:00.000Z");
  assertEquals(change.after?.osvModifiedAt, "2025-03-10T00:00:00.000Z");
});

Deno.test("new_finding: baseline にない finding を検出する（before なし）", () => {
  const change = changeFor("CVE-2999-1005");
  assertEquals(change.changeTypes, ["new_finding"]);
  assertEquals(change.before, undefined);
  assertEquals(change.after?.urgency, "deferred");
});

Deno.test("removed_finding: 消滅した finding を検出する（after なし）", () => {
  const change = changeFor("CVE-2999-1006");
  assertEquals(change.changeTypes, ["removed_finding"]);
  assertEquals(change.after, undefined);
  assertEquals(change.before?.urgency, "deferred");
});

Deno.test("変化のない finding は changes に含まれない", () => {
  const diff = runDiff();
  assertEquals(diff.changes.some((c) => c.findingId === "CVE-2999-1007"), false);
});

Deno.test("--baseline-scan 指定時は baseline.scanFile に記録される", () => {
  const diff = diffReports(baseline, changed, {
    baselineEnrichedFile: "enriched.json",
    newEnrichedFile: "new.json",
    baselineScanFile: "scan.json",
  });
  assertEquals(diff.baseline.scanFile, "scan.json");
  assertEquals(runDiff().baseline.scanFile, undefined);
});

Deno.test("変化ゼロの場合は changed=0 になる", () => {
  const diff = diffReports(baseline, baseline, {
    baselineEnrichedFile: "a.json",
    newEnrichedFile: "b.json",
  });
  assertEquals(diff.summary.changed, 0);
  assertEquals(diff.changes, []);
});
