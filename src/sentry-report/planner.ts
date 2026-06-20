import type { ReportInput, ReportFinding } from "./types.ts";
import type { ReportPlan } from "./plan.ts";
import { REPORT_PLAN_VERSION } from "./plan.ts";
import { safeErrorMessage } from "../shared/utils.ts";

const DEFAULT_OLLAMA_HOST = "http://host.docker.internal:11434";
const DEFAULT_OLLAMA_MODEL = "llama3.2";
const DEFAULT_OPENAI_HOST = "https://api.openai.com";
export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

export interface PlannerConfig {
  provider?: "openai" | "ollama";
  ollamaHost?: string;
  ollamaModel?: string;
  openaiApiKey?: string;
  openaiModel?: string;
}

export async function generateReportPlan(
  input: ReportInput,
  config: PlannerConfig,
): Promise<ReportPlan> {
  const provider = config.provider ?? (config.openaiApiKey ? "openai" : "ollama");
  const host = provider === "openai"
    ? DEFAULT_OPENAI_HOST
    : (config.ollamaHost ?? DEFAULT_OLLAMA_HOST);
  const model = provider === "openai"
    ? (config.openaiModel ?? DEFAULT_OPENAI_MODEL)
    : (config.ollamaModel ?? DEFAULT_OLLAMA_MODEL);

  if (provider === "openai" && !config.openaiApiKey) {
    throw new Error("OPENAI_API_KEY が設定されていません");
  }

  const systemPrompt = await loadSystemPrompt();
  const userPrompt = buildUserPrompt(input);

  console.error(`[sentry-report] provider: ${provider}, model: ${model}`);

  const raw = await callChatCompletion(host, model, systemPrompt, userPrompt, config.openaiApiKey);
  return parseReportPlan(raw);
}

async function loadSystemPrompt(): Promise<string> {
  const url = new URL("./prompts/report-plan.md", import.meta.url);
  return await Deno.readTextFile(url);
}

function buildUserPrompt(input: ReportInput): string {
  const compact = {
    repository: input.repository,
    scannedAt: input.scannedAt,
    summary: input.summary,
    findings: input.findings.map(compactFinding),
  };
  return `以下のスキャン結果を分析して ReportPlan JSON を生成してください。\n\n${
    JSON.stringify(compact, null, 2)
  }`;
}

function compactFinding(f: ReportFinding): Record<string, unknown> {
  return {
    findingId: f.findingId,
    category: f.category,
    package: f.package
      ? { name: f.package.name, version: f.package.version, ecosystem: f.package.ecosystem }
      : undefined,
    riskSignals: {
      severity: f.riskSignals.severity,
      epss: f.riskSignals.epss,
      kev: f.riskSignals.kev,
      hasFixedVersion: f.riskSignals.hasFixedVersion,
      priorityScore: f.riskSignals.priorityScore,
    },
    urgency: f.recommendedAction.urgency,
    context: {
      title: f.context.title,
      attackCategory: f.context.attackCategory,
      impact: f.context.impact,
      affectedFeatures: f.context.affectedFeatures,
      osvAliases: f.context.osvAliases,
    },
  };
}

async function callChatCompletion(
  host: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  apiKey?: string,
): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(`${host}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      stream: false,
      temperature: 0.3,
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(180000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AI API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

function parseReportPlan(raw: string): ReportPlan {
  // モデルが ```json ... ``` でラップする場合に対応
  const stripped = raw.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();

  let parsed: ReportPlan;
  try {
    parsed = JSON.parse(stripped) as ReportPlan;
  } catch (e) {
    throw new Error(`ReportPlan の JSON パースに失敗: ${safeErrorMessage(e)}\nraw:\n${raw.slice(0, 300)}`);
  }

  // 必須フィールドの補完（AI が省略した場合のフォールバック）
  parsed.planVersion = REPORT_PLAN_VERSION;
  parsed.overallRisk ??= "medium";
  parsed.executiveSummary ??= "";
  parsed.immediateActions ??= [];
  parsed.plannedActions ??= [];
  parsed.deferredItems ??= [];
  parsed.notableRisks ??= [];

  return parsed;
}
