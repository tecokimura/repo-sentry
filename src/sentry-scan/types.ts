export type { Severity, SeveritySummary } from "../shared/types.ts";
export { allSummary, severityOrder } from "../shared/types.ts";

export type ToolName =
  | "gitleaks"
  | "trivy"
  | "dependabot"
  | "trufflehog"
  | "clearwing";

export type FindingCategory =
  | "secret"
  | "dependency-vulnerability"
  | "container-vulnerability"
  | "iac-misconfiguration"
  | "code-vulnerability"
  | "scanner-diagnostic";

export type FindingStatus = "open" | "fixed" | "dismissed" | "needs_review" | "unknown";

export type CollectorRunStatus = "completed" | "skipped" | "failed";

export type DependabotSourceStatus =
  | "enabled_with_alerts"
  | "enabled_no_alerts"
  | "disabled"
  | "permission_missing"
  | "repo_archived"
  | "unknown";

export type Confidence = "high" | "medium" | "low" | "unknown";

export type EvidenceLevel =
  | "suspicion"
  | "static_corroboration"
  | "crash_reproduced"
  | "root_cause_explained"
  | "unknown";

export type OutputFormat = "json" | "markdown";

import type { Severity, SeveritySummary } from "../shared/types.ts"; // used by interfaces below

export interface Finding {
  id?: string;
  tool: ToolName;
  category: FindingCategory;
  severity: Severity;
  title: string;
  description?: string;
  location?: string;
  status: FindingStatus;
  url?: string;
  identifiers?: string[];
  packageName?: string;
  packageVersion?: string;
  ecosystem?: string;
  purl?: string;
  fixedVersions?: string[];
  cweIds?: string[];
  clearwingRisk?: string;
  clearwingIncidents?: string;
  clearwingMemo?: string;
  confidence?: Confidence;
  evidenceLevel?: EvidenceLevel;
  rawReportPath?: string;
  raw?: unknown;
}

export interface CollectorStatus {
  tool: ToolName;
  status: CollectorRunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  findingsCount: number;
  sourceStatus?: DependabotSourceStatus;
  rawReportPath?: string;
  error?: string;
  notes: string[];
}

export interface ScanReport {
  scanId: string;
  profile: string;
  repository?: string;
  path?: string;
  gitBranch?: string;
  gitCommit?: string;
  scannedAt: string;
  toolVersions?: Record<string, string>;
  summary: SeveritySummary;
  collectorStatuses: CollectorStatus[];
  findings: Finding[];
}

export interface ScanRequest {
  repo?: string;
  path?: string;
  tools: ToolName[];
  format: OutputFormat;
  output?: string;
  artifactsDir: string;
  failOnSeverity: Severity;
  githubToken?: string;
  sbom?: boolean;
  clearwing?: {
    depth?: "priority" | "standard" | "verbose";
    budget?: number;
    timeout?: string;
    ackRisk: boolean;
    provider?: "openai" | "ollama";
    ollamaHost?: string;
    ollamaModel?: string;
    openaiApiKey?: string;
    openaiModel?: string;
  };
}

export interface CollectorResult {
  status: CollectorStatus;
  findings: Finding[];
}
