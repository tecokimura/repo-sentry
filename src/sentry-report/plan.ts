export const REPORT_PLAN_VERSION = "1" as const;

export interface PlanAction {
  findingId?: string;
  title: string;
  reason: string;
  notes?: string;
}

export interface PlanDeferral {
  findingId?: string;
  title: string;
  deferReason: string;
}

export interface NotableRisk {
  title: string;
  description: string;
}

export interface ReportPlan {
  planVersion: typeof REPORT_PLAN_VERSION;
  overallRisk: "critical" | "high" | "medium" | "low";
  executiveSummary: string;
  immediateActions: PlanAction[];
  plannedActions: PlanAction[];
  deferredItems: PlanDeferral[];
  notableRisks: NotableRisk[];
}
