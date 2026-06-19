import type { OutputFormat, ScanRequest, Severity, ToolName } from "./types.ts";
import { defaultArtifactsDir } from "../shared/utils.ts";

export interface CliRunOptions {
  command: "run";
  repo?: string;
  path?: string;
  tools: ToolName[];
  format: OutputFormat;
  output?: string;
  artifactsDir?: string;
  failOnSeverity: Severity;
  sbom: boolean;
  clearwingDepth?: "priority" | "standard" | "verbose";
  clearwingBudget?: number;
  clearwingTimeout?: string;
  clearwingAckRisk: boolean;
  ollamaHost?: string;
  ollamaModel?: string;
}

const supportedTools: ToolName[] = [
  "gitleaks",
  "trivy",
  "dependabot",
  "trufflehog",
  "clearwing",
];

export function parseRunOptions(args: string[]): CliRunOptions {
  const [command, ...rest] = args;
  if (command !== "run") {
    throw new Error(`Unknown command: ${command ?? "(missing)"}`);
  }

  const flags = parseFlags(rest);
  const format = parseFormat(flags.format ?? "json");
  const tools = parseTools(flags.tools ?? "gitleaks,trivy,dependabot");
  const failOnSeverity = parseSeverity(flags["fail-on"] ?? "high");

  return {
    command: "run",
    repo: flags.repo,
    path: flags.path,
    tools,
    format,
    output: flags.output,
    artifactsDir: flags["artifacts-dir"],
    failOnSeverity,
    sbom: flags["no-sbom"] !== "true",
    clearwingDepth: parseClearwingDepth(flags["clearwing-depth"]),
    clearwingBudget: parseOptionalNumber(flags["clearwing-budget"], "clearwing-budget"),
    clearwingTimeout: flags["clearwing-timeout"],
    clearwingAckRisk: flags["clearwing-ack-risk"] === "true",
    ollamaHost: flags["ollama-host"],
    ollamaModel: flags["ollama-model"],
  };
}

export function toScanRequest(options: CliRunOptions): ScanRequest {
  validateOptions(options);

  return {
    repo: options.repo,
    path: options.path,
    tools: options.tools,
    format: options.format,
    output: options.output,
    artifactsDir: options.artifactsDir ?? defaultArtifactsDir(options.output),
    failOnSeverity: options.failOnSeverity,
    githubToken: readEnv("GITHUB_TOKEN"),
    sbom: options.sbom,
    clearwing: {
      depth: options.clearwingDepth,
      budget: options.clearwingBudget,
      timeout: options.clearwingTimeout,
      ackRisk: options.clearwingAckRisk,
      provider: parseClearwingProvider(readEnv("CLEARWING_PROVIDER")),
      ollamaHost: options.ollamaHost ?? readEnv("OLLAMA_HOST"),
      ollamaModel: options.ollamaModel ?? readEnv("OLLAMA_MODEL"),
      openaiApiKey: readEnv("OPENAI_API_KEY"),
      openaiModel: readEnv("OPENAI_MODEL"),
    },
  };
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    const raw = arg.slice(2);
    const equalsIndex = raw.indexOf("=");
    if (equalsIndex >= 0) {
      const key = raw.slice(0, equalsIndex);
      const value = raw.slice(equalsIndex + 1);
      flags[key] = value;
      continue;
    }

    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      flags[raw] = "true";
      continue;
    }

    flags[raw] = next;
    index += 1;
  }

  return flags;
}

function parseTools(value: string): ToolName[] {
  const rawTools = value.split(",").map((tool) => tool.trim()).filter(Boolean);
  const expanded = rawTools.includes("all") ? ["gitleaks", "trivy", "dependabot"] : rawTools;

  const tools: ToolName[] = [];
  for (const tool of expanded) {
    if (!supportedTools.includes(tool as ToolName)) {
      throw new Error(`Unsupported tool: ${tool}`);
    }
    tools.push(tool as ToolName);
  }

  return [...new Set(tools)];
}

function parseFormat(value: string): OutputFormat {
  if (value === "json" || value === "markdown") return value;
  throw new Error(`Unsupported format: ${value}`);
}

function parseSeverity(value: string): Severity {
  if (
    value === "critical" ||
    value === "high" ||
    value === "medium" ||
    value === "low" ||
    value === "info" ||
    value === "unknown"
  ) {
    return value;
  }
  throw new Error(`Unsupported severity threshold: ${value}`);
}

function parseClearwingDepth(value?: string): "priority" | "standard" | "verbose" | undefined {
  if (value === undefined) return undefined;
  if (value === "priority" || value === "standard" || value === "verbose") return value;
  throw new Error(`Unsupported clearwing depth: ${value}`);
}

function parseOptionalNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric option --${name}: ${value}`);
  }
  return parsed;
}

function validateOptions(options: CliRunOptions): void {
  const processTools = options.tools.filter((tool) =>
    tool === "gitleaks" || tool === "trivy" || tool === "trufflehog" || tool === "clearwing"
  );

  if (processTools.length > 0 && !options.path) {
    throw new Error(`--path is required when using process tools: ${processTools.join(",")}`);
  }

  if (options.tools.includes("dependabot") && !options.repo) {
    throw new Error("--repo owner/name is required when using dependabot");
  }

  if (options.tools.includes("clearwing")) {
    if (!options.clearwingAckRisk) {
      throw new Error("--clearwing-ack-risk is required when using clearwing");
    }
    if (options.clearwingDepth === "verbose") {
      throw new Error("Clearwing depth 'verbose' is not allowed in the default CLI flow");
    }
  }
}

function parseClearwingProvider(value: string | undefined): "openai" | "ollama" | undefined {
  if (value === "openai" || value === "ollama") return value;
  return undefined;
}

function readEnv(name: string): string | undefined {
  try {
    const value = Deno.env.get(name);
    return value && value.trim().length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
