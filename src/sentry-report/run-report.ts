import type { EnrichedReport } from "../sentry-enrich/types.ts";
import type { ReportInput } from "./types.ts";
import type { ReportPlan } from "./plan.ts";
import type { PlannerConfig } from "./planner.ts";
import { buildReportInput } from "./transformer.ts";
import { generateReportPlan } from "./planner.ts";
import { renderMarkdownReport } from "./renderers/markdown.ts";
import { readJsonFile, writeTextFile } from "../shared/utils.ts";

export interface ReportRequest {
  input: string;
  planOutput?: string;
  reportOutput?: string;
  debugInputOutput?: string;
  planner: PlannerConfig;
}

export interface ReportResult {
  reportInput: ReportInput;
  plan: ReportPlan;
  markdown: string;
}

export async function runReport(request: ReportRequest): Promise<ReportResult> {
  const enriched = await readJsonFile(request.input) as EnrichedReport;

  const reportInput = buildReportInput(enriched);

  if (request.debugInputOutput) {
    await writeTextFile(request.debugInputOutput, JSON.stringify(reportInput, null, 2));
    console.error(`[sentry-report] debug: report-input → ${request.debugInputOutput}`);
  }

  const plan = await generateReportPlan(reportInput, request.planner);

  if (request.planOutput) {
    await writeTextFile(request.planOutput, JSON.stringify(plan, null, 2));
    console.error(`[sentry-report] plan     → ${request.planOutput}`);
  }

  const markdown = renderMarkdownReport(plan, reportInput);

  if (request.reportOutput) {
    await writeTextFile(request.reportOutput, markdown);
    console.error(`[sentry-report] report   → ${request.reportOutput}`);
  }

  return { reportInput, plan, markdown };
}
