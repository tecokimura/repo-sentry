import type { EnrichedReport } from "../types.ts";
import { ensureParentDir } from "../../shared/utils.ts";

export function renderEnrichedJson(report: EnrichedReport): string {
  return JSON.stringify(report, null, 2);
}

export async function writeEnrichedJson(report: EnrichedReport, path: string): Promise<void> {
  await ensureParentDir(path);
  await Deno.writeTextFile(path, renderEnrichedJson(report));
}
