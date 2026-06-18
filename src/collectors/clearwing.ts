import { completeCollector, failCollector, startCollector } from "./common.ts";
import type { CollectorStatus, Finding, ScanRequest } from "../types.ts";
import { safeErrorMessage } from "../utils.ts";

const DEFAULT_OLLAMA_HOST = "http://host.docker.internal:11434";
const DEFAULT_MODEL = "llama3.2";

export interface ClearwingResult {
  status: CollectorStatus;
  enriched: Finding[];
}

export async function enrichWithClearwing(
  request: ScanRequest,
  findings: Finding[],
): Promise<ClearwingResult> {
  const timing = startCollector();

  const host = request.clearwing?.ollamaHost ?? DEFAULT_OLLAMA_HOST;
  const model = request.clearwing?.ollamaModel ?? DEFAULT_MODEL;
  const depth = request.clearwing?.depth ?? "standard";
  const targets = filterByDepth(findings, depth);

  if (targets.length === 0) {
    const status = completeCollector("clearwing", timing, 0, {
      notes: ["分析対象の検出なし"],
    });
    return { status, enriched: findings };
  }

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

  const targetSet = new Set(targets);
  const enrichedFindings: Finding[] = [];
  let enrichedCount = 0;
  let failedCount = 0;

  for (const finding of findings) {
    if (!targetSet.has(finding)) {
      enrichedFindings.push(finding);
      continue;
    }

    try {
      const sections = await analyzeOnce(host, model, finding);
      enrichedFindings.push({ ...finding, ...sections });
      enrichedCount++;
    } catch {
      enrichedFindings.push(finding);
      failedCount++;
    }
  }

  const notes: string[] = [`${enrichedCount}件を分析 (depth: ${depth})`];
  if (failedCount > 0) notes.push(`${failedCount}件は失敗`);

  const status = completeCollector("clearwing", timing, enrichedCount, { notes });
  return { status, enriched: enrichedFindings };
}

function filterByDepth(findings: Finding[], depth: "quick" | "standard" | "deep"): Finding[] {
  return findings.filter((f) => {
    if (f.category === "scanner-diagnostic") return false;
    switch (depth) {
      case "quick":
        return f.severity === "critical" || f.severity === "high";
      case "standard":
        return f.severity === "critical" || f.severity === "high" || f.severity === "medium";
      case "deep":
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
): Promise<{ clearwingRisk?: string; clearwingIncidents?: string; clearwingMemo?: string }> {
  const prompt = buildPrompt(finding);
  const raw = await callOllama(host, model, prompt);
  return parseSections(raw);
}

function buildPrompt(finding: Finding): string {
  const pkg = finding.packageName
    ? `${finding.packageName} v${finding.packageVersion ?? "不明"}`
    : finding.location ?? "不明";

  return `セキュリティ脆弱性を分析してください。

脆弱性名: ${finding.title}
パッケージ/場所: ${pkg}
深刻度: ${finding.severity.toUpperCase()}

以下の3項目を必ずこの形式で回答してください:

【リスク】
攻撃者がこの脆弱性を悪用した場合のビジネスへの影響を2〜3文で説明。

【類似インシデント】
この種の脆弱性に関連する実際の攻撃事例を1件。不明な場合は「確認されていません」と書く。

【対応判断メモ】
- 影響範囲: （影響する機能・条件を1文で）
- 対応コスト: （パッケージ更新の作業量を1文で）
- 放置した場合: （最悪シナリオを1文で）`;
}

async function callOllama(host: string, model: string, prompt: string): Promise<string> {
  const res = await fetch(`${host}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
    clearwingIncidents: extract("【類似インシデント】"),
    clearwingMemo: extract("【対応判断メモ】"),
  };
}
