export type Urgency = "immediate" | "planned" | "deferred";

export type ChangeType =
  | "kev_added"
  | "urgency_upgraded"
  | "epss_risen"
  | "osv_updated"
  | "new_finding"
  | "removed_finding";

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
  /** undefined for new_finding (no baseline) */
  before?: WatchSnapshot;
  /** undefined for removed_finding (not in new report) */
  after?: WatchSnapshot;
}

export interface WatchDiff {
  watchVersion: "1";
  baseline: {
    enrichedFile: string;
    /** ベーススキャンの scan_*.json パス（--baseline-scan 指定時のみ） */
    scanFile?: string;
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
    newFindings: number;
    removedFindings: number;
  };
  changes: WatchChange[];
}
