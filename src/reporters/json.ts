import type { ScanReport } from "../types.ts";
import { writeTextFile } from "../utils.ts";

export function renderJsonReport(report: ScanReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export async function writeJsonReport(report: ScanReport, output: string): Promise<void> {
  await writeTextFile(output, renderJsonReport(report));
}
