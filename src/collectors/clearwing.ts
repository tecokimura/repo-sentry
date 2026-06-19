import { completeCollector, failCollector, startCollector } from "./common.ts";
import type { CollectorStatus, Finding, ScanRequest } from "../types.ts";
import { safeErrorMessage } from "../utils.ts";

const DEFAULT_OLLAMA_HOST = "http://host.docker.internal:11434";
const DEFAULT_OLLAMA_MODEL = "llama3.2";
const DEFAULT_OPENAI_HOST = "https://api.openai.com";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

export interface ClearwingResult {
  status: CollectorStatus;
  enriched: Finding[];
}

export async function enrichWithClearwing(
  request: ScanRequest,
  findings: Finding[],
): Promise<ClearwingResult> {
  const timing = startCollector();

  const openaiApiKey = request.clearwing?.openaiApiKey;
  const provider = request.clearwing?.provider
    ?? (openaiApiKey ? "openai" : "ollama");
  const host = provider === "openai"
    ? DEFAULT_OPENAI_HOST
    : (request.clearwing?.ollamaHost ?? DEFAULT_OLLAMA_HOST);
  const model = provider === "openai"
    ? (request.clearwing?.openaiModel ?? DEFAULT_OPENAI_MODEL)
    : (request.clearwing?.ollamaModel ?? DEFAULT_OLLAMA_MODEL);
  const depth = request.clearwing?.depth ?? "standard";  // priority / standard / verbose
  const targets = filterByDepth(findings, depth);

  if (targets.length === 0) {
    const status = completeCollector("clearwing", timing, 0, {
      notes: ["分析対象の検出なし"],
    });
    return { status, enriched: findings };
  }

  if (provider === "openai" && !openaiApiKey) {
    const { status } = failCollector(
      "clearwing",
      timing,
      "OPENAI_API_KEY が設定されていません",
    );
    return { status, enriched: findings };
  }

  if (provider === "ollama") {
    try {
      await checkOllama(host, model);
    } catch (error) {
      const { status } = failCollector(
        "clearwing",
        timing,
        `Ollamaに接続できません: ${safeErrorMessage(error)}`,
      );
      return { status, enriched: findings };
    }
  }

  console.error(`[clearwing] provider: ${provider}, model: ${model}`);

  const targetSet = new Set(targets);
  const enrichedFindings: Finding[] = [];
  let enrichedCount = 0;
  let failedCount = 0;
  const total = targets.length;
  for (const finding of findings) {
    if (!targetSet.has(finding)) {
      enrichedFindings.push(finding);
      continue;
    }

    const current = enrichedCount + failedCount + 1;
    const label = finding.id ?? finding.title.slice(0, 50);
    const severity = finding.severity.toUpperCase();
    console.error(`[clearwing] <SCAN> (${current}/${total}): ${label} [${severity}]`);
    const findingStart = Date.now();

    try {
      const sections = await analyzeOnce(host, model, finding, openaiApiKey);
      enrichedFindings.push({ ...finding, ...sections });
      enrichedCount++;
      console.error(`[clearwing] <DONE> (${current}/${total}): ${label} [${severity}] (${formatDuration(Math.floor((Date.now() - findingStart) / 1000))})`);
    } catch {
      enrichedFindings.push(finding);
      failedCount++;
      console.error(`[clearwing] <FAIL> (${current}/${total}): ${label} [${severity}] (${formatDuration(Math.floor((Date.now() - findingStart) / 1000))})`);
    }
  }

  const notes: string[] = [`${enrichedCount}件を分析 (depth: ${depth})`];
  if (failedCount > 0) notes.push(`${failedCount}件は失敗`);

  const status = completeCollector("clearwing", timing, enrichedCount, { notes });
  return { status, enriched: enrichedFindings };
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h${String(m).padStart(2, "0")}m${String(secs % 60).padStart(2, "0")}s`;
}

function filterByDepth(findings: Finding[], depth: "priority" | "standard" | "verbose"): Finding[] {
  return findings.filter((f) => {
    if (f.category === "scanner-diagnostic") return false;
    switch (depth) {
      case "priority":
        return f.severity === "critical" || f.severity === "high";
      case "standard":
        return f.severity === "critical" || f.severity === "high" || f.severity === "medium";
      case "verbose":
        return f.severity !== "info" && f.severity !== "unknown";
    }
  });
}

async function checkOllama(host: string, model: string): Promise<void> {
  const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as { models?: Array<{ name: string }> };
  const modelPrefix = model.split(":")[0];
  const found = (data.models ?? []).some((m) => m.name.startsWith(modelPrefix));
  if (!found) {
    throw new Error(
      `モデル "${model}" が見つかりません。ollama pull ${model} を実行してください`,
    );
  }
}

async function analyzeOnce(
  host: string,
  model: string,
  finding: Finding,
  apiKey?: string,
): Promise<{ clearwingRisk?: string; clearwingIncidents?: string; clearwingMemo?: string }> {
  const prompt = buildPrompt(finding);
  const raw = await callChatCompletion(host, model, prompt, apiKey);
  return parseSections(raw);
}

function buildPrompt(finding: Finding): string {
  const pkg = finding.packageName
    ? `${finding.packageName} v${finding.packageVersion ?? "不明"}`
    : finding.location ?? "不明";

  const description = finding.description ? `説明: ${finding.description}\n` : "";

  return `あなたはセキュリティ脆弱性の分析担当です。以下の脆弱性情報をもとに、日本語のみで簡潔に分析してください。

制約:
* 同じ内容を繰り返さないこと
* 不明な点は推測せず「判断不可」と書くこと
* 一般論ではなく、対象パッケージと深刻度に基づいて書くこと
* 各項目は指定された見出しのみを使うこと

脆弱性名: ${finding.title}
パッケージ/場所: ${pkg}
深刻度: ${finding.severity.toUpperCase()}
${description}
以下の3項目を必ずこの形式で回答してください:

【リスク】
この脆弱性により起こり得る被害と、悪用された場合のビジネス影響を2〜3文で説明する。

【悪用シナリオ】
この種の脆弱性が悪用される典型的な流れを1文で説明する。

【対応判断メモ】
- 影響範囲: このアプリケーションで影響を受ける可能性がある機能・設定・条件を1文で。不明な場合は「判断不可」と書く。`;
}

async function callChatCompletion(
  host: string,
  model: string,
  prompt: string,
  apiKey?: string,
): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(`${host}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      temperature: 0.2,
      max_tokens: 400,
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

function parseSections(
  raw: string,
): { clearwingRisk?: string; clearwingIncidents?: string; clearwingMemo?: string } {
  const extract = (marker: string): string | undefined => {
    const start = raw.indexOf(marker);
    if (start === -1) return undefined;
    const after = raw.slice(start + marker.length);
    const nextMarker = after.search(/【[^】]+】/);
    const section = nextMarker >= 0 ? after.slice(0, nextMarker) : after;
    const cleaned = section.trim();
    return cleaned.length > 0 ? cleaned : undefined;
  };

  return {
    clearwingRisk: extract("【リスク】"),
    clearwingIncidents: extract("【悪用シナリオ】"),
    clearwingMemo: extract("【対応判断メモ】"),
  };
}
