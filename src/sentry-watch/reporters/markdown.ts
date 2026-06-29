import type { WatchChange, WatchDiff } from "../types.ts";
import { ensureParentDir } from "../../shared/utils.ts";

export function renderWatchReportMarkdown(diff: WatchDiff): string {
  const lines: string[] = [];

  // (1) ヘッダー
  lines.push("# sentry-watch レポート");
  lines.push("");
  lines.push(`- **チェック日時**: ${diff.checkedAt}`);
  lines.push(`- **ベーススキャン日時**: ${diff.baseline.scannedAt}`);
  lines.push(`- **ベースラインファイル**: ${diff.baseline.enrichedFile}`);
  lines.push(`- **新規エンリッチファイル**: ${diff.newEnrichedFile}`);
  lines.push("");

  // (2) サマリー表
  lines.push("## サマリー");
  lines.push("");
  lines.push("| 種別 | 件数 |");
  lines.push("|------|------|");
  lines.push(`| 全 finding 数 | ${diff.summary.totalFindings} |`);
  lines.push(`| 変化あり | ${diff.summary.changed} |`);
  lines.push(`| KEV 新規登録 | ${diff.summary.kevAdded} |`);
  lines.push(`| urgency 上昇 | ${diff.summary.urgencyUpgraded} |`);
  lines.push(`| EPSS 上昇 | ${diff.summary.epssRisen} |`);
  lines.push(`| OSV 情報更新 | ${diff.summary.osvUpdated} |`);
  lines.push(`| 新規検出 | ${diff.summary.newFindings} |`);
  lines.push(`| 消滅 | ${diff.summary.removedFindings} |`);
  lines.push("");

  if (diff.summary.changed === 0) {
    lines.push(`> 変化なし: ${diff.summary.totalFindings} 件`);
    lines.push("");
    return lines.join("\n");
  }

  const urgencyUpgraded = diff.changes.filter((c) => c.changeTypes.includes("urgency_upgraded"));
  const kevAdded = diff.changes.filter((c) => c.changeTypes.includes("kev_added"));
  const epssRisen = diff.changes.filter((c) => c.changeTypes.includes("epss_risen"));
  const osvUpdated = diff.changes.filter((c) => c.changeTypes.includes("osv_updated"));
  const newFindings = diff.changes.filter((c) => c.changeTypes.includes("new_finding"));
  const removedFindings = diff.changes.filter((c) => c.changeTypes.includes("removed_finding"));

  // (3) 要対応: urgency が上がった項目
  if (urgencyUpgraded.length > 0) {
    lines.push("## 要対応: urgency が上昇した項目");
    lines.push("");
    for (const change of urgencyUpgraded) {
      lines.push(...renderChangeBlock(change));
    }
  }

  // (4) 要確認: KEV に新規登録された項目
  if (kevAdded.length > 0) {
    lines.push("## 要確認: KEV に新規登録された項目");
    lines.push("");
    for (const change of kevAdded) {
      lines.push(...renderChangeBlock(change));
    }
  }

  // (5) EPSS が上昇した項目
  if (epssRisen.length > 0) {
    lines.push("## EPSS が上昇した項目");
    lines.push("");
    for (const change of epssRisen) {
      lines.push(...renderChangeBlock(change));
    }
  }

  // (6) OSV 情報が更新された項目
  if (osvUpdated.length > 0) {
    lines.push("## OSV 情報が更新された項目");
    lines.push("");
    for (const change of osvUpdated) {
      lines.push(...renderChangeBlock(change));
    }
  }

  // (7) 新規検出 finding
  if (newFindings.length > 0) {
    lines.push("## 新規検出: ベースライン以降に追加された項目");
    lines.push("");
    for (const change of newFindings) {
      lines.push(...renderNewFindingBlock(change));
    }
  }

  // (8) 消滅 finding
  if (removedFindings.length > 0) {
    lines.push("## 消滅: ベースラインから除外された項目");
    lines.push("");
    for (const change of removedFindings) {
      lines.push(...renderRemovedFindingBlock(change));
    }
  }

  return lines.join("\n");
}

function renderChangeBlock(change: WatchChange): string[] {
  const lines: string[] = [];
  const id = change.findingId;
  const pkg = change.package ? ` (${change.package.name} ${change.package.version})` : "";
  lines.push(`### ${id}${pkg}`);
  lines.push("");
  lines.push(`- **変化種別**: ${change.changeTypes.join(", ")}`);
  // before/after は kev_added/urgency_upgraded/epss_risen/osv_updated では必ず存在する
  const before = change.before!;
  const after = change.after!;
  lines.push(`- **urgency**: ${before.urgency} → ${after.urgency}`);
  lines.push(`- **KEV**: ${before.kev} → ${after.kev}`);
  if (before.epss !== undefined || after.epss !== undefined) {
    const bEpss = before.epss !== undefined ? before.epss.toFixed(4) : "N/A";
    const aEpss = after.epss !== undefined ? after.epss.toFixed(4) : "N/A";
    lines.push(`- **EPSS**: ${bEpss} → ${aEpss}`);
  }
  if (before.osvModifiedAt !== undefined || after.osvModifiedAt !== undefined) {
    const bOsv = before.osvModifiedAt ?? "N/A";
    const aOsv = after.osvModifiedAt ?? "N/A";
    lines.push(`- **OSV modifiedAt**: ${bOsv} → ${aOsv}`);
  }
  lines.push("");
  return lines;
}

function renderNewFindingBlock(change: WatchChange): string[] {
  const lines: string[] = [];
  const id = change.findingId;
  const pkg = change.package ? ` (${change.package.name} ${change.package.version})` : "";
  lines.push(`### ${id}${pkg}`);
  lines.push("");
  if (change.after) {
    lines.push(`- **urgency**: ${change.after.urgency}`);
    lines.push(`- **KEV**: ${change.after.kev}`);
    if (change.after.epss !== undefined) {
      lines.push(`- **EPSS**: ${change.after.epss.toFixed(4)}`);
    }
  }
  lines.push("");
  return lines;
}

function renderRemovedFindingBlock(change: WatchChange): string[] {
  const lines: string[] = [];
  const id = change.findingId;
  const pkg = change.package ? ` (${change.package.name} ${change.package.version})` : "";
  lines.push(`### ${id}${pkg}`);
  lines.push("");
  if (change.before) {
    lines.push(`- **urgency** (ベースライン時): ${change.before.urgency}`);
    lines.push(`- **KEV** (ベースライン時): ${change.before.kev}`);
    if (change.before.epss !== undefined) {
      lines.push(`- **EPSS** (ベースライン時): ${change.before.epss.toFixed(4)}`);
    }
  }
  lines.push("");
  return lines;
}

export async function writeWatchReportMarkdown(diff: WatchDiff, path: string): Promise<void> {
  await ensureParentDir(path);
  await Deno.writeTextFile(path, renderWatchReportMarkdown(diff));
}
