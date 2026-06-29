export type Urgency = "immediate" | "planned" | "deferred";

export type ChangeType = "kev_added" | "urgency_upgraded" | "epss_risen" | "osv_updated";

export interface WatchSnapshot {
  urgency: Urgency;
  kev: boolean;
  epss?: number;
  osvModifiedAt?: string;
}

export interface WatchChange {
  findingId: string;
  package?: { name: string; version: string };
  changeTypes: ChangeType[];
  before: WatchSnapshot;
  after: WatchSnapshot;
}

export interface WatchDiff {
  watchVersion: "1";
  baseline: {
    enrichedFile: string;
    scannedAt: string;
  };
  checkedAt: string;
  newEnrichedFile: string;
  summary: {
    totalFindings: number;
    changed: number;
    kevAdded: number;
    urgencyUpgraded: number;
    epssRisen: number;
    osvUpdated: number;
  };
  changes: WatchChange[];
}
