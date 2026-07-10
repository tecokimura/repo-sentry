import type { ChangeType, Urgency, WatchChange, WatchDiff, WatchSnapshot } from "./types.ts";
import type { EnrichedFinding, EnrichedReport } from "../sentry-enrich/types.ts";
import { deriveUrgency } from "../shared/urgency.ts";

function toSnapshot(finding: EnrichedFinding): WatchSnapshot {
  return {
    urgency: deriveUrgency(finding),
    kev: !!finding.kev,
    epss: finding.epss?.epss,
    osvModifiedAt: finding.osv?.modifiedAt,
  };
}

const URGENCY_RANK: Record<Urgency, number> = {
  deferred: 0,
  planned: 1,
  immediate: 2,
};

function isUrgencyUpgraded(before: Urgency, after: Urgency): boolean {
  return URGENCY_RANK[after] > URGENCY_RANK[before];
}

function isEpssRisen(before?: number, after?: number): boolean {
  if (after === undefined) return false;
  if (before === undefined) return false;
  const delta = after - before;
  if (delta >= 0.05) return true;
  // EPSS が 0.4 をまたいだ（before < 0.4 <= after）
  if (before < 0.4 && after >= 0.4) return true;
  return false;
}

function isOsvUpdated(before?: string, after?: string): boolean {
  if (!after) return false;
  if (!before) return false;
  return after > before;
}

export interface WatchRequest {
  baselineEnrichedFile: string;
  newEnrichedFile: string;
  baselineScanFile?: string;
}

export async function runWatch(request: WatchRequest): Promise<WatchDiff> {
  const [baselineRaw, newRaw] = await Promise.all([
    Deno.readTextFile(request.baselineEnrichedFile),
    Deno.readTextFile(request.newEnrichedFile),
  ]);

  return diffReports(JSON.parse(baselineRaw), JSON.parse(newRaw), request);
}

/**
 * baseline と新規エンリッチ結果を比較して差分を生成する（純粋関数・テスト対象）。
 */
export function diffReports(
  baseline: EnrichedReport,
  newReport: EnrichedReport,
  request: Pick<WatchRequest, "baselineEnrichedFile" | "newEnrichedFile" | "baselineScanFile">,
): WatchDiff {
  // findingId でマップ化（id が同一でも location が異なる場合は複合キーにする）
  const baselineMap = new Map<string, EnrichedFinding>();
  for (const f of baseline.findings) {
    const key = buildKey(f);
    baselineMap.set(key, f);
  }

  const changes: WatchChange[] = [];

  // 新規エンリッチマップ（removed_finding 検出用）
  const newMap = new Map<string, EnrichedFinding>();
  for (const f of newReport.findings) {
    newMap.set(buildKey(f), f);
  }

  // 既存 finding の変化を検出
  for (const newFinding of newReport.findings) {
    const key = buildKey(newFinding);
    const baseFinding = baselineMap.get(key);
    if (!baseFinding) continue; // new_finding は別途処理

    const before = toSnapshot(baseFinding);
    const after = toSnapshot(newFinding);

    const changeTypes: ChangeType[] = [];

    if (!before.kev && after.kev) changeTypes.push("kev_added");
    if (isUrgencyUpgraded(before.urgency, after.urgency)) changeTypes.push("urgency_upgraded");
    if (isEpssRisen(before.epss, after.epss)) changeTypes.push("epss_risen");
    if (isOsvUpdated(before.osvModifiedAt, after.osvModifiedAt)) changeTypes.push("osv_updated");

    if (changeTypes.length === 0) continue;

    const change: WatchChange = {
      findingId: key,
      changeTypes,
      before,
      after,
    };

    if (newFinding.packageName) {
      change.package = {
        name: newFinding.packageName,
        version: newFinding.packageVersion ?? "",
      };
    }

    changes.push(change);
  }

  // new_finding: baseline になく新規エンリッチにある
  for (const newFinding of newReport.findings) {
    const key = buildKey(newFinding);
    if (baselineMap.has(key)) continue;

    const change: WatchChange = {
      findingId: key,
      changeTypes: ["new_finding"],
      after: toSnapshot(newFinding),
    };
    if (newFinding.packageName) {
      change.package = { name: newFinding.packageName, version: newFinding.packageVersion ?? "" };
    }
    changes.push(change);
  }

  // removed_finding: baseline にあり新規エンリッチにない
  for (const baseFinding of baseline.findings) {
    const key = buildKey(baseFinding);
    if (newMap.has(key)) continue;

    const change: WatchChange = {
      findingId: key,
      changeTypes: ["removed_finding"],
      before: toSnapshot(baseFinding),
    };
    if (baseFinding.packageName) {
      change.package = { name: baseFinding.packageName, version: baseFinding.packageVersion ?? "" };
    }
    changes.push(change);
  }

  const summary = {
    totalFindings: newReport.findings.length,
    changed: changes.length,
    kevAdded: changes.filter((c) => c.changeTypes.includes("kev_added")).length,
    urgencyUpgraded: changes.filter((c) => c.changeTypes.includes("urgency_upgraded")).length,
    epssRisen: changes.filter((c) => c.changeTypes.includes("epss_risen")).length,
    osvUpdated: changes.filter((c) => c.changeTypes.includes("osv_updated")).length,
    newFindings: changes.filter((c) => c.changeTypes.includes("new_finding")).length,
    removedFindings: changes.filter((c) => c.changeTypes.includes("removed_finding")).length,
  };

  return {
    watchVersion: "1",
    baseline: {
      enrichedFile: request.baselineEnrichedFile,
      ...(request.baselineScanFile ? { scanFile: request.baselineScanFile } : {}),
      scannedAt: baseline.scannedAt,
    },
    checkedAt: new Date().toISOString(),
    newEnrichedFile: request.newEnrichedFile,
    summary,
    changes,
  };
}

/**
 * finding の一意キーを生成する。
 * id + location の組み合わせで同一性を判定する。
 */
function buildKey(finding: EnrichedFinding): string {
  const id = finding.id ?? "";
  const location = finding.location ?? "";
  return location ? `${id}@${location}` : id;
}
