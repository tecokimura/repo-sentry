#!/usr/bin/env -S deno run
import { runReport } from "./run-report.ts";
import type { ReportRequest } from "./run-report.ts";
import { safeErrorMessage } from "../shared/utils.ts";

export async function main(args: string[] = Deno.args): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(helpText());
    return 0;
  }

  try {
    const request = parseArgs(args);
    const result = await runReport(request);

    if (!request.reportOutput) {
      console.log(result.markdown);
    }

    return 0;
  } catch (error) {
    console.error(`sentry-report: ${safeErrorMessage(error)}`);
    return 2;
  }
}

function parseArgs(args: string[]): ReportRequest {
  const req: Partial<ReportRequest> & { planner: ReportRequest["planner"] } = { planner: {} };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => args[++i];
    const val = (prefix: string) => arg.slice(prefix.length);

    if (arg === "--input" || arg === "-i")           { req.input = next(); }
    else if (arg.startsWith("--input="))             { req.input = val("--input="); }
    else if (arg === "--output" || arg === "-o")      { req.reportOutput = next(); }
    else if (arg.startsWith("--output="))            { req.reportOutput = val("--output="); }
    else if (arg === "--plan-output")                 { req.planOutput = next(); }
    else if (arg.startsWith("--plan-output="))       { req.planOutput = val("--plan-output="); }
    else if (arg === "--debug-input")                 { req.debugInputOutput = next(); }
    else if (arg.startsWith("--debug-input="))       { req.debugInputOutput = val("--debug-input="); }
    else if (arg === "--provider")                    { req.planner.provider = next() as "openai" | "ollama"; }
    else if (arg.startsWith("--provider="))          { req.planner.provider = val("--provider=") as "openai" | "ollama"; }
    else if (arg === "--ollama-host")                 { req.planner.ollamaHost = next(); }
    else if (arg.startsWith("--ollama-host="))       { req.planner.ollamaHost = val("--ollama-host="); }
    else if (arg === "--ollama-model")                { req.planner.ollamaModel = next(); }
    else if (arg.startsWith("--ollama-model="))      { req.planner.ollamaModel = val("--ollama-model="); }
    else if (arg === "--openai-model")               { req.planner.openaiModel = next(); }
    else if (arg.startsWith("--openai-model="))     { req.planner.openaiModel = val("--openai-model="); }
  }

  req.planner.openaiApiKey = Deno.env.get("OPENAI_API_KEY");
  // REPORT_LLM_PROVIDER が優先。未設定時は CLEARWING_PROVIDER にフォールバック
  if (!req.planner.provider) {
    const p = Deno.env.get("REPORT_LLM_PROVIDER") ?? Deno.env.get("CLEARWING_PROVIDER");
    if (p) req.planner.provider = p as "openai" | "ollama";
  }
  // REPORT_LLM_MODEL が優先。未設定時は OLLAMA_MODEL にフォールバック
  if (!req.planner.ollamaModel) {
    req.planner.ollamaModel = Deno.env.get("REPORT_LLM_MODEL") ?? Deno.env.get("OLLAMA_MODEL");
  }
  // OLLAMA_BASE_URL が優先。未設定時は OLLAMA_HOST にフォールバック
  if (!req.planner.ollamaHost) {
    req.planner.ollamaHost = Deno.env.get("OLLAMA_BASE_URL") ?? Deno.env.get("OLLAMA_HOST");
  }

  if (!req.input) throw new Error("--input is required");
  return req as ReportRequest;
}

function helpText(): string {
  return `sentry-report

Usage:
  sentry-report --input enriched.json --output report.md --plan-output plan.json

Options:
  --input PATH, -i PATH        Input enriched JSON file (required)
  --output PATH, -o PATH       Output report.md path. Prints to stdout when omitted
  --plan-output PATH           Output report-plan.json path
  --debug-input PATH           Save report-input.json (debug)
  --provider openai|ollama     LLM provider (default: auto-detect)
  --ollama-host URL            Ollama host (default: http://host.docker.internal:11434)
  --ollama-model MODEL         Ollama model
  --openai-model MODEL         OpenAI model (default: gpt-4o-mini)
  -h, --help                   Show this help

Environment variables:
  OPENAI_API_KEY               OpenAI API key
  REPORT_LLM_PROVIDER          LLM provider: openai or ollama (CLEARWING_PROVIDER as fallback)
  REPORT_LLM_MODEL             Ollama model (OLLAMA_MODEL as fallback)
  OLLAMA_BASE_URL              Ollama host URL (OLLAMA_HOST as fallback)
`;
}

if (import.meta.main) {
  Deno.exit(await main());
}
