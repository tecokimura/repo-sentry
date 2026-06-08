#!/usr/bin/env -S deno run
import { parseRunOptions, toScanRequest } from "./config.ts";
import { evaluatePolicy } from "./policy.ts";
import { renderJsonReport, writeJsonReport } from "./reporters/json.ts";
import { renderMarkdownReport, writeMarkdownReport } from "./reporters/markdown.ts";
import { runScan } from "./run-scan.ts";
import { safeErrorMessage } from "./utils.ts";

export async function main(args: string[] = Deno.args): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(helpText());
    return 0;
  }

  try {
    const options = parseRunOptions(args);
    const request = toScanRequest(options);
    const report = await runScan(request);

    if (request.format === "json") {
      if (request.output) {
        await writeJsonReport(report, request.output);
      } else {
        console.log(renderJsonReport(report));
      }
    } else {
      if (request.output) {
        await writeMarkdownReport(report, request.output);
      } else {
        console.log(renderMarkdownReport(report));
      }
    }

    return evaluatePolicy(report, request);
  } catch (error) {
    console.error(`repo-sentry: ${safeErrorMessage(error)}`);
    return 2;
  }
}

function helpText(): string {
  return `repo-sentry

Usage:
  repo-sentry run --path ./repo --repo owner/name --tools gitleaks,trivy,dependabot --format json --output ./reports/latest.json

Options:
  --path PATH                         Local repository path for process-based scanners
  --repo OWNER/NAME                   GitHub repository for Dependabot alerts
  --tools LIST                        Comma-separated tools. Default: gitleaks,trivy,dependabot
  --format json|markdown              Report format. Default: json
  --output PATH                       Report output path. Prints to stdout when omitted
  --artifacts-dir PATH                Raw scanner output directory. Default: derived from output
  --fail-on SEVERITY                  Policy threshold. Default: high
  --clearwing-depth quick|standard    Clearwing depth when clearwing is selected
  --clearwing-budget NUMBER           Clearwing LLM budget hint
  --clearwing-timeout DURATION        Clearwing timeout hint
  --clearwing-ack-risk                Required when clearwing is selected
`;
}

if (import.meta.main) {
  Deno.exit(await main());
}
