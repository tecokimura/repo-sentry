import type { WatchDiff } from "../types.ts";
import { ensureParentDir } from "../../shared/utils.ts";

export function renderWatchDiffJson(diff: WatchDiff): string {
  return JSON.stringify(diff, null, 2);
}

export async function writeWatchDiffJson(diff: WatchDiff, path: string): Promise<void> {
  await ensureParentDir(path);
  await Deno.writeTextFile(path, renderWatchDiffJson(diff));
}
