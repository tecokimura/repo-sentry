export type ToolName =
  | "gitleaks"
  | "trivy"
  | "dependabot"
  | "trufflehog"
  | "clearwing";

export type Severity = "critical" | "high" | "medium" | "low" | "info" | "unknown";

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
  fixedVersion?: string;
  clearwingRisk?: string;
  clearwingIncidents?: string;
  clearwingMemo?: string;
  confidence?: Confidence;
  evidenceLevel?: EvidenceLevel;
  rawReportPath?: string;
  raw?: unknown;
}

export interface SeveritySummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
  unknown: number;
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
  repository?: string;
  path?: string;
  scannedAt: string;
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

export const severityOrder: Record<Severity, number> = {
  unknown: 0,
  info: 1,
  low: 2,
  medium: 3,
  high: 4,
  critical: 5,
};

export const allSummary = (): SeveritySummary => ({
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  info: 0,
  unknown: 0,
});
