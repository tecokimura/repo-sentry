#!/usr/bin/env -S deno run
import { runEnrich } from "./run-enrich.ts";
import { writeEnrichedJson } from "./reporters/json.ts";
import { safeErrorMessage } from "../shared/utils.ts";
import type { EnrichRequest } from "./types.ts";

export async function main(args: string[] = Deno.args): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(helpText());
    return 0;
  }

  try {
    const request = parseArgs(args);
    const report = await runEnrich(request);

    if (request.output) {
      await writeEnrichedJson(report, request.output);
    } else {
      const { renderEnrichedJson } = await import("./reporters/json.ts");
      console.log(renderEnrichedJson(report));
    }

    return 0;
  } catch (error) {
    console.error(`sentry-enrich: ${safeErrorMessage(error)}`);
    return 2;
  }
}

function parseArgs(args: string[]): EnrichRequest {
  const request: Partial<EnrichRequest> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--input" || arg === "-i") {
      request.input = args[++i];
    } else if (arg.startsWith("--input=")) {
      request.input = arg.slice("--input=".length);
    } else if (arg === "--output" || arg === "-o") {
      request.output = args[++i];
    } else if (arg.startsWith("--output=")) {
      request.output = arg.slice("--output=".length);
    } else if (arg === "--sbom") {
      request.sbomPath = args[++i];
    } else if (arg.startsWith("--sbom=")) {
      request.sbomPath = arg.slice("--sbom=".length);
    }
  }
  if (!request.input) throw new Error("--input is required");
  return request as EnrichRequest;
}

function helpText(): string {
  return `sentry-enrich

Usage:
  sentry-enrich --input ./reports/project/scan_critter_A3F226061914.json --output ./reports/project/enriched_critter_A3F226061914.json

Options:
  --input PATH, -i PATH    Input scan JSON file (required)
  --output PATH, -o PATH   Output path. Prints to stdout when omitted
  --sbom PATH              CycloneDX SBOM for direct/transitive detection
  -h, --help               Show this help
`;
}

if (import.meta.main) {
  Deno.exit(await main());
}
