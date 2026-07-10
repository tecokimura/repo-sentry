#!/usr/bin/env -S deno run
import { runWatch } from "./watcher.ts";
import type { WatchRequest } from "./watcher.ts";
import { writeWatchDiffJson } from "./reporters/json.ts";
import { writeWatchReportMarkdown } from "./reporters/markdown.ts";
import { safeErrorMessage } from "../shared/utils.ts";
import { dirname } from "../shared/utils.ts";

interface CliRequest extends WatchRequest {
  outputDir?: string;
}

export async function main(args: string[] = Deno.args): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(helpText());
    return 0;
  }

  try {
    const request = parseArgs(args);
    const diff = await runWatch(request);

    const baselineBase = basename(request.baselineEnrichedFile);
    const hash = extractHash(baselineBase);
    const dateStr = formatDate(new Date(diff.checkedAt));

    const outputDir = request.outputDir ?? dirname(request.baselineEnrichedFile);

    const jsonPath = `${outputDir}/watch-diff_${hash}_${dateStr}.json`;
    const mdPath = `${outputDir}/watch-report_${hash}_${dateStr}.md`;

    await writeWatchDiffJson(diff, jsonPath);
    await writeWatchReportMarkdown(diff, mdPath);

    console.error(`[sentry-watch] 完了`);
    console.error(`[sentry-watch] 生成(diff)  : ${jsonPath}`);
    console.error(`[sentry-watch] 生成(report): ${mdPath}`);

    return 0;
  } catch (error) {
    console.error(`sentry-watch: ${safeErrorMessage(error)}`);
    return 2;
  }
}

function parseArgs(args: string[]): CliRequest {
  const request: Partial<CliRequest> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => args[++i];
    const val = (prefix: string) => arg.slice(prefix.length);

    if (arg === "--output-dir") {
      request.outputDir = next();
    } else if (arg.startsWith("--output-dir=")) {
      request.outputDir = val("--output-dir=");
    } else if (arg === "--baseline-scan") {
      request.baselineScanFile = next();
    } else if (arg.startsWith("--baseline-scan=")) {
      request.baselineScanFile = val("--baseline-scan=");
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    } else {
      throw new Error(`不明なオプション: ${arg}`);
    }
  }

  if (positional.length < 2) {
    throw new Error(
      "引数が不足しています: <baseline-enriched.json> <new-enriched.json> が必要です",
    );
  }

  request.baselineEnrichedFile = positional[0];
  request.newEnrichedFile = positional[1];

  return request as CliRequest;
}

/**
 * enriched_{short}_{HASH}{YYMMDDHH} 形式のファイル名からハッシュ部分を抽出する。
 * 例: enriched_receiveagent_RECE77C1.json → RECE77C1
 */
function extractHash(filename: string): string {
  // 拡張子を除去
  const base = filename.endsWith(".json") ? filename.slice(0, -5) : filename;
  // "enriched_{short}_{rest}" の rest から先頭8文字を取得
  const stripped = base.startsWith("enriched_") ? base.slice("enriched_".length) : base;
  const parts = stripped.split("_");
  if (parts.length >= 2) {
    // _hash は 2番目以降の連結から先頭8文字
    return parts.slice(1).join("_").slice(0, 8);
  }
  // フォールバック: 先頭8文字
  return stripped.slice(0, 8);
}

function formatDate(date: Date): string {
  const yy = String(date.getUTCFullYear()).slice(2);
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

function basename(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function helpText(): string {
  return `sentry-watch

Usage:
  sentry-watch <baseline-enriched.json> <new-enriched.json> [OPTIONS]

Arguments:
  baseline-enriched.json    比較基点となる enriched JSON ファイル (必須)
  new-enriched.json         最新の enriched JSON ファイル (必須)

Options:
  --output-dir DIR          出力先ディレクトリ (default: baseline-enriched.json と同じディレクトリ)
  --baseline-scan FILE      ベーススキャンファイルのパス（メタデータ記録用）
  -h, --help                このヘルプを表示

出力ファイル:
  watch-diff_<HASH>_<YYMMDD>.json    差分 JSON
  watch-report_<HASH>_<YYMMDD>.md   差分レポート Markdown
`;
}

if (import.meta.main) {
  Deno.exit(await main());
}
