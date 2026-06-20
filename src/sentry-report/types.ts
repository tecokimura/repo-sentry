export const REPORT_INPUT_VERSION = "1" as const;

export type ReportAction = "upgrade" | "mitigate" | "monitor" | "accept";
export type ReportUrgency = "immediate" | "planned" | "deferred";

export interface ReportPackage {
  ecosystem: string;
  name: string;
  version: string;
  purl: string;
  dependencyType?: "direct" | "transitive";
}

export interface RiskSignals {
  severity: "critical" | "high" | "medium" | "low" | "info" | "unknown";
  epss?: number;
  epssPercentile?: number;
  kev: boolean;
  hasFixedVersion: boolean;
  priorityScore: number;
}

export interface RecommendedAction {
  action: ReportAction;
  urgency: ReportUrgency;
  fixAvailable: boolean;
  fixedVersions?: string[];
  recommendedVersion?: string;
  fixCommand?: string;
  command?: string;
}

export interface FindingContext {
  title: string;
  description?: string;
  location?: string;
  cweIds?: string[];
  url?: string;
  osvSummary?: string;
  osvAliases?: string[];
  kevDateAdded?: string;
  kevRequiredAction?: string;
  attackCategory?: string;
  impact?: string[];
  affectedFeatures?: string[];
  analysisSource?: "clearwing";
}

export interface ReportFinding {
  findingId?: string;
  tool: string;
  category: string;
  package?: ReportPackage;
  riskSignals: RiskSignals;
  recommendedAction: RecommendedAction;
  context: FindingContext;
}

export interface ReportSummary {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  immediate: number;
  kevCount: number;
  epssHighCount: number;
}

export interface ReportInput {
  reportInputVersion: typeof REPORT_INPUT_VERSION;
  scanId: string;
  enrichId?: string;
  profile: string;
  repository?: string;
  scannedAt: string;
  summary: ReportSummary;
  findings: ReportFinding[];
}
