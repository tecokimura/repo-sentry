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
  lines.push("");

  if (diff.summary.changed === 0) {
    // (7) 変化なし
    lines.push(`> 変化なし: ${diff.summary.totalFindings} 件`);
    lines.push("");
    return lines.join("\n");
  }

  const urgencyUpgraded = diff.changes.filter((c) => c.changeTypes.includes("urgency_upgraded"));
  const kevAdded = diff.changes.filter((c) => c.changeTypes.includes("kev_added"));
  const epssRisen = diff.changes.filter((c) => c.changeTypes.includes("epss_risen"));
  const osvUpdated = diff.changes.filter((c) => c.changeTypes.includes("osv_updated"));

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

  return lines.join("\n");
}

function renderChangeBlock(change: WatchChange): string[] {
  const lines: string[] = [];
  const id = change.findingId;
  const pkg = change.package ? ` (${change.package.name} ${change.package.version})` : "";
  lines.push(`### ${id}${pkg}`);
  lines.push("");
  lines.push(`- **変化種別**: ${change.changeTypes.join(", ")}`);
  lines.push(`- **urgency**: ${change.before.urgency} → ${change.after.urgency}`);
  lines.push(`- **KEV**: ${change.before.kev} → ${change.after.kev}`);
  if (change.before.epss !== undefined || change.after.epss !== undefined) {
    const bEpss = change.before.epss !== undefined ? change.before.epss.toFixed(4) : "N/A";
    const aEpss = change.after.epss !== undefined ? change.after.epss.toFixed(4) : "N/A";
    lines.push(`- **EPSS**: ${bEpss} → ${aEpss}`);
  }
  if (change.before.osvModifiedAt !== undefined || change.after.osvModifiedAt !== undefined) {
    const bOsv = change.before.osvModifiedAt ?? "N/A";
    const aOsv = change.after.osvModifiedAt ?? "N/A";
    lines.push(`- **OSV modifiedAt**: ${bOsv} → ${aOsv}`);
  }
  lines.push("");
  return lines;
}

export async function writeWatchReportMarkdown(diff: WatchDiff, path: string): Promise<void> {
  await ensureParentDir(path);
  await Deno.writeTextFile(path, renderWatchReportMarkdown(diff));
}
