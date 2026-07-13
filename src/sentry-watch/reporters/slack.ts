import type { WatchDiff } from "../types.ts";

/**
 * 変化があった場合のみ Slack に通知する。
 * 変化なし（summary.changed === 0）は無通知。
 * エラーは呼び出し元でキャッチして非致命的扱いにすること。
 */
export async function sendSlackNotification(
  diff: WatchDiff,
  webhookUrl: string,
): Promise<void> {
  if (diff.summary.changed === 0) return;

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: buildMessage(diff) }),
  });
  if (!res.ok) {
    throw new Error(`Slack webhook responded with ${res.status}`);
  }
}

function buildMessage(diff: WatchDiff): string {
  const { summary } = diff;
  const date = diff.checkedAt.slice(0, 10);
  const project = extractProjectName(diff.baseline.enrichedFile);

  const lines: string[] = [
    `*[sentry-watch] ${project}*: 変化あり ${summary.changed}件 (${date})`,
  ];

  if (summary.kevAdded > 0) lines.push(`• KEV 新規登録: ${summary.kevAdded}件`);
  if (summary.urgencyUpgraded > 0) lines.push(`• urgency 上昇: ${summary.urgencyUpgraded}件`);
  if (summary.epssRisen > 0) lines.push(`• EPSS 上昇: ${summary.epssRisen}件`);
  if (summary.osvUpdated > 0) lines.push(`• OSV 更新: ${summary.osvUpdated}件`);
  if (summary.newFindings > 0) lines.push(`• 新規検出: ${summary.newFindings}件`);
  if (summary.removedFindings > 0) lines.push(`• 消滅: ${summary.removedFindings}件`);

  return lines.join("\n");
}

function extractProjectName(filePath: string): string {
  // reports/MYAPP-main/watch/watch-enrich_*.json → MYAPP-main
  // reports/MYAPP-main/enriched_*.json            → MYAPP-main
  const parts = filePath.replaceAll("\\", "/").split("/");
  const idx = parts.lastIndexOf("reports");
  if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
  return parts[parts.length - 2] ?? "unknown";
}
