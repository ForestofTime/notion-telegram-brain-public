import { config } from "./config.js";
import type { Citation, DecisionMode, NotionDoc } from "./types.js";
import type { SelfProfile } from "./self-store.js";

export type LLMAnswerInput = {
  question: string;
  system: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  citations: Citation[];
  personaProfile: SelfProfile | null;
  memorySummary: string;
  feedbackHints: string[];
  decisionMode: DecisionMode;
};

export type LLMAnswerOutput = {
  answer: string;
  confidence: "high" | "medium" | "low";
  citations: Citation[];
  decisionMode: DecisionMode;
  riskBoundary: string;
  nextActions: string[];
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const safeJsonParse = <T>(s: string, fallback: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

const buildSystem = (base: string, persona: SelfProfile | null, decisionMode: DecisionMode): string => {
  const personaBlock = persona
    ? [
        `人格名称: ${persona.name}`,
        `风格: ${persona.styleHint}`,
        `关键规则:\n${persona.personaRules.slice(0, 8).map((x) => `- ${x}`).join("\n") || "- 无"}`,
        `纠正记录:\n${persona.corrections.slice(0, 5).map((x) => `- ${x}`).join("\n") || "- 无"}`
      ].join("\n")
    : "未激活人格";

  return [
    base,
    "你是企业知识机器人，必须基于证据回答，不要编造。",
    `决策模式: ${decisionMode}`,
    personaBlock,
    "输出必须是 JSON，字段: answer,confidence,riskBoundary,nextActions",
    "confidence 只能是 high|medium|low",
    "nextActions 为字符串数组，最多3条"
  ].join("\n\n");
};

export class DeepSeekProvider {
  private readonly endpoint = "https://api.deepseek.com/chat/completions";

  async answer(input: LLMAnswerInput): Promise<LLMAnswerOutput> {
    if (!config.deepseekApiKey) {
      throw new Error("DEEPSEEK_API_KEY 未配置");
    }

    const evidenceBlock = input.citations
      .slice(0, 8)
      .map((c, i) => `#${i + 1} ${c.title}\n${c.excerpt}\nurl=${c.url}`)
      .join("\n\n");

    const feedback = input.feedbackHints.length > 0 ? input.feedbackHints.map((x) => `- ${x}`).join("\n") : "- 无";
    const userPrompt = [
      `问题: ${input.question}`,
      "证据:",
      evidenceBlock || "无",
      "历史纠正偏好:",
      feedback,
      "长期记忆摘要:",
      input.memorySummary || "暂无"
    ].join("\n\n");

    const messages = [
      { role: "system", content: buildSystem(input.system, input.personaProfile, input.decisionMode) },
      ...input.history.slice(-6).map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: userPrompt }
    ];

    let lastErr: unknown;
    for (let i = 1; i <= config.llmMaxRetries; i += 1) {
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), config.llmTimeoutMs);
        const res = await fetch(this.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.deepseekApiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: config.deepseekModel,
            temperature: config.llmTemperature,
            response_format: { type: "json_object" },
            messages
          }),
          signal: ac.signal
        });
        clearTimeout(timer);

        if (!res.ok) {
          throw new Error(`DeepSeek HTTP ${res.status}: ${await res.text()}`);
        }

        const payload = (await res.json()) as any;
        const content = payload?.choices?.[0]?.message?.content ?? "{}";
        const parsed = safeJsonParse<any>(content, {});

        const output: LLMAnswerOutput = {
          answer: String(parsed.answer ?? "当前证据不足，我需要你补充上下文后再判断。"),
          confidence: ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "medium",
          citations: input.citations,
          decisionMode: input.decisionMode,
          riskBoundary: String(parsed.riskBoundary ?? "若涉及权限/财务口径变更，需责任人复核。"),
          nextActions: Array.isArray(parsed.nextActions)
            ? parsed.nextActions.map((x: unknown) => String(x)).slice(0, 3)
            : ["补充关键约束后再问一轮"]
        };
        return output;
      } catch (err) {
        lastErr = err;
        if (i < config.llmMaxRetries) await sleep(500 * i);
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error("DeepSeek 调用失败");
  }

  async distillKnowledge(docs: NotionDoc[], personaProfile: SelfProfile | null): Promise<string> {
    const brief = docs
      .slice(0, 24)
      .map((d, i) => `#${i + 1} ${d.title}\n${(d.distilled || d.preview || "").slice(0, 240)}`)
      .join("\n\n");

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.llmTimeoutMs);
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.deepseekApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.deepseekModel,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "请输出中文 Markdown，结构为：1) 知识蒸馏 2) 决策规则卡片 3) 例外条件卡片 4) 待补充信息。内容要短、可执行。"
          },
          {
            role: "user",
            content: [
              `当前人格: ${personaProfile?.name ?? "未激活"}`,
              `人格风格: ${personaProfile?.styleHint ?? "直接、简洁"}`,
              "知识材料:",
              brief || "无"
            ].join("\n\n")
          }
        ]
      }),
      signal: ac.signal
    });
    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`DeepSeek distill HTTP ${res.status}`);
    }
    const payload = (await res.json()) as any;
    return String(payload?.choices?.[0]?.message?.content ?? "").trim();
  }
}
