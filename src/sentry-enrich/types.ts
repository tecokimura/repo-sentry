import type { Finding, ScanReport, SeveritySummary } from "../sentry-scan/types.ts";

export type DependencyType = "direct" | "transitive" | "unknown";

export interface OsvAdvisory {
  id: string;
  aliases?: string[];
  summary?: string;
  severity?: string;
  publishedAt?: string;
  modifiedAt?: string;
}

export interface KevEntry {
  cveId: string;
  vendorProject?: string;
  product?: string;
  dateAdded?: string;
  requiredAction?: string;
  dueDate?: string;
}

export interface EpssScore {
  cve: string;
  epss: number;
  percentile: number;
  date: string;
}

export interface EnrichedFinding extends Finding {
  dependencyType?: DependencyType;
  osv?: OsvAdvisory;
  kev?: KevEntry;
  epss?: EpssScore;
}

export interface EnrichedReport {
  scanId: string;
  enrichId: string;
  profile: string;
  repository?: string;
  path?: string;
  gitBranch?: string;
  gitCommit?: string;
  scannedAt: string;
  enrichedAt: string;
  toolVersions?: Record<string, string>;
  summary: SeveritySummary;
  collectorStatuses: ScanReport["collectorStatuses"];
  findings: EnrichedFinding[];
}

export interface EnrichRequest {
  input: string;
  output?: string;
  sbomPath?: string;
}
