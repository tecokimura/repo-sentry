import type { CollectorResult, CollectorStatus, ToolName } from "../types.ts";
import { elapsedMs, nowIso, safeErrorMessage, sanitizeForLog } from "../utils.ts";

export interface CollectorTiming {
  startedAt: string;
  startedAtMs: number;
}

export function startCollector(): CollectorTiming {
  return {
    startedAt: nowIso(),
    startedAtMs: Date.now(),
  };
}

export function completeCollector(
  tool: ToolName,
  timing: CollectorTiming,
  findingsCount: number,
  options: {
    rawReportPath?: string;
    notes?: string[];
    sourceStatus?: CollectorStatus["sourceStatus"];
  } = {},
): CollectorStatus {
  return {
    tool,
    status: "completed",
    startedAt: timing.startedAt,
    finishedAt: nowIso(),
    durationMs: elapsedMs(timing.startedAtMs),
    findingsCount,
    sourceStatus: options.sourceStatus,
    rawReportPath: options.rawReportPath,
    notes: options.notes ?? [],
  };
}

export function failCollector(
  tool: ToolName,
  timing: CollectorTiming,
  error: unknown,
  options: {
    rawReportPath?: string;
    notes?: string[];
    sourceStatus?: CollectorStatus["sourceStatus"];
  } = {},
): CollectorResult {
  return {
    status: {
      tool,
      status: "failed",
      startedAt: timing.startedAt,
      finishedAt: nowIso(),
      durationMs: elapsedMs(timing.startedAtMs),
      findingsCount: 0,
      sourceStatus: options.sourceStatus,
      rawReportPath: options.rawReportPath,
      error: sanitizeForLog(safeErrorMessage(error)),
      notes: options.notes ?? [],
    },
    findings: [],
  };
}

export function skippedCollector(
  tool: ToolName,
  timing: CollectorTiming,
  note: string,
): CollectorResult {
  return {
    status: {
      tool,
      status: "skipped",
      startedAt: timing.startedAt,
      finishedAt: nowIso(),
      durationMs: elapsedMs(timing.startedAtMs),
      findingsCount: 0,
      notes: [note],
    },
    findings: [],
  };
}
