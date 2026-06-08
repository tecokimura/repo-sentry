import type { Severity, SeveritySummary } from "./types.ts";
import { allSummary } from "./types.ts";

export function nowIso(): string {
  return new Date().toISOString();
}

export function elapsedMs(startedAtMs: number): number {
  return Math.max(0, Date.now() - startedAtMs);
}

export function toSeverity(value: unknown): Severity {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized === "critical") return "critical";
  if (normalized === "high") return "high";
  if (normalized === "medium" || normalized === "moderate") return "medium";
  if (normalized === "low") return "low";
  if (normalized === "info" || normalized === "informational" || normalized === "negligible") {
    return "info";
  }
  return "unknown";
}

export function summarizeSeverities(findings: Array<{ severity: Severity }>): SeveritySummary {
  const summary = allSummary();
  for (const finding of findings) {
    summary[finding.severity] += 1;
  }
  return summary;
}

export function dirname(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  if (index < 0) return ".";
  if (index === 0) return "/";
  return normalized.slice(0, index);
}

export async function ensureParentDir(path: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
}

export async function ensureDir(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function sanitizeForLog(value: string): string {
  return value.replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[redacted-github-token]");
}

export function defaultArtifactsDir(output?: string): string {
  if (!output) return "reports/raw";
  return `${dirname(output)}/raw`;
}

export async function readJsonFile(path: string): Promise<unknown> {
  const text = await Deno.readTextFile(path);
  if (text.trim().length === 0) return [];
  return JSON.parse(text);
}

export async function writeTextFile(path: string, contents: string): Promise<void> {
  await ensureParentDir(path);
  await Deno.writeTextFile(path, contents);
}
