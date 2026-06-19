import { collectDependabot } from "./collectors/dependabot.ts";
import { collectGitleaks } from "./collectors/gitleaks.ts";
import { collectTrivy } from "./collectors/trivy.ts";
import { DEFAULT_OLLAMA_MODEL, DEFAULT_OPENAI_MODEL, enrichWithClearwing } from "./collectors/clearwing.ts";
import type {
  CollectorResult,
  CollectorStatus,
  ScanReport,
  ScanRequest,
  ToolName,
} from "./types.ts";
import { nowIso, summarizeSeverities } from "./utils.ts";

export async function runScan(request: ScanRequest): Promise<ScanReport> {
  // Clearwing is a post-processing enrichment step, not a discovery collector.
  // Run all other tools in parallel first, then enrich.
  const discoveryTools = request.tools.filter((t) => t !== "clearwing");
  const [collectorResults, toolVersions] = await Promise.all([
    Promise.all(discoveryTools.map((tool) => runCollector(tool, request))),
    fetchToolVersions(request.tools, request),
  ]);

  let findings = collectorResults.flatMap((result) => result.findings);
  const collectorStatuses = collectorResults.map((result) => result.status);

  if (request.tools.includes("clearwing") && request.clearwing?.ackRisk) {
    const cwResult = await enrichWithClearwing(request, findings);
    findings = cwResult.enriched;
    collectorStatuses.push(cwResult.status);
  }

  return {
    scanId: crypto.randomUUID(),
    profile: deriveProfile(request),
    repository: request.repo,
    path: request.path,
    scannedAt: nowIso(),
    toolVersions,
    summary: summarizeSeverities(findings),
    collectorStatuses,
    findings,
  };
}

function deriveProfile(request: ScanRequest): string {
  if (request.tools.includes("clearwing") && request.clearwing?.ackRisk) {
    const depth = request.clearwing?.depth ?? "standard";
    return `clearwing-${depth}`;
  }
  return "base";
}

async function fetchToolVersions(tools: ToolName[], request: ScanRequest): Promise<Record<string, string>> {
  const versions: Record<string, string> = {};
  const checks: Promise<void>[] = [];

  if (tools.includes("gitleaks")) {
    checks.push((async () => {
      try {
        const { stdout } = await new Deno.Command("gitleaks", {
          args: ["version"],
          stdout: "piped",
          stderr: "null",
        }).output();
        const v = new TextDecoder().decode(stdout).trim().replace(/^v/, "");
        if (v) versions["gitleaks"] = v;
      } catch { /* ignore */ }
    })());
  }

  if (tools.includes("trivy")) {
    checks.push((async () => {
      try {
        const { stdout } = await new Deno.Command("trivy", {
          args: ["--version"],
          stdout: "piped",
          stderr: "null",
        }).output();
        const match = new TextDecoder().decode(stdout).match(/Version:\s*(\S+)/);
        if (match) versions["trivy"] = match[1];
      } catch { /* ignore */ }
    })());
  }

  if (tools.includes("clearwing")) {
    const apiKey = request.clearwing?.openaiApiKey;
    const provider = request.clearwing?.provider ?? (apiKey ? "openai" : "ollama");
    const model = provider === "openai"
      ? (request.clearwing?.openaiModel ?? DEFAULT_OPENAI_MODEL)
      : (request.clearwing?.ollamaModel ?? DEFAULT_OLLAMA_MODEL);
    versions["clearwing"] = `${provider}/${model}`;
  }

  await Promise.all(checks);
  return versions;
}

async function runCollector(tool: ToolName, request: ScanRequest): Promise<CollectorResult> {
  switch (tool) {
    case "dependabot":
      return await collectDependabot(request);
    case "gitleaks":
      return await collectGitleaks(request);
    case "trivy":
      return await collectTrivy(request);
    case "trufflehog":
      return notImplemented(tool, "TruffleHog collector is planned for a later phase");
    case "clearwing":
      // Should not be reached; clearwing is handled above as post-processing.
      return notImplemented(tool, "Clearwing は後処理ステップとして別途実行されます");
  }
}

function notImplemented(tool: ToolName, note: string): CollectorResult {
  const timestamp = nowIso();
  const status: CollectorStatus = {
    tool,
    status: "failed",
    startedAt: timestamp,
    finishedAt: timestamp,
    durationMs: 0,
    findingsCount: 0,
    error: "Collector is not implemented yet",
    notes: [note],
  };

  return {
    status,
    findings: [],
  };
}
