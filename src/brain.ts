import { config } from "./config.js";
import { buildEmbeddingProvider } from "./embedding-provider.js";
import { BrainDB } from "./db.js";
import { DeepSeekProvider } from "./llm.js";
import { answerWithKnowledge, highlightEvidence, type QAResult } from "./qa.js";
import { humanizeAnswerWithProfile, type SelfProfile } from "./self-store.js";
import type { Citation, DecisionMode, NotionDoc } from "./types.js";

const modeFromQuestion = (q: string): DecisionMode => {
  if (/风险|合规|财务|审批|权限|合同/i.test(q)) return "conservative";
  if (/紧急|马上|快速|立刻/i.test(q)) return "aggressive";
  return "balanced";
};

const baseSystemPrompt = `你是企业知识助理。请严格遵循：\n1) 先结论\n2) 给证据\n3) 给风险边界\n4) 给下一步动作。\n不能脱离证据编造。`;

const citationsToSources = (citations: Citation[]): Array<{ title: string; url: string }> => {
  const uniq = new Map<string, { title: string; url: string }>();
  for (const c of citations) {
    if (!uniq.has(c.url)) uniq.set(c.url, { title: c.title, url: c.url });
  }
  return [...uniq.values()].slice(0, 3);
};

export class BrainService {
  private readonly llm = new DeepSeekProvider();
  private readonly embedding = buildEmbeddingProvider();

  constructor(private readonly db: BrainDB) {}

  async answer(params: {
    userId: number;
    question: string;
    docs: NotionDoc[];
    profile: SelfProfile | null;
    forcePlus?: boolean;
  }): Promise<QAResult> {
    const decisionMode = modeFromQuestion(params.question);
    const legacy = answerWithKnowledge(params.question, params.docs);
    if ((config.llmRoute === "legacy" || !config.deepseekApiKey) && !params.forcePlus) {
      return {
        ...legacy,
        confidence: "medium",
        decisionMode,
        citations: legacy.evidences.slice(0, 3).map((e) => ({
          title: e.title,
          url: e.url,
          excerpt: highlightEvidence(params.question, e.excerpt),
          highlights: []
        })),
        riskBoundary: "若涉及权限、审批口径变更，请负责人复核。",
        nextActions: ["如需更精确结论，请补充组织与单据类型"]
      };
    }

    try {
      let qvec = null as number[] | null;
      try {
        qvec = await this.embedding.embedOne(params.question);
      } catch {}
      const retrieved = this.db.hybridRetrieveAdvanced(params.question, qvec, config.retrievalTopN);
      const citations = this.db.toCitations(retrieved, params.question).map((c) => ({
        ...c,
        excerpt: highlightEvidence(params.question, c.excerpt)
      }));

      const history = this.db.getRecentSession(params.userId, 8);
      const feedbackHints = this.db.getFeedbackHints(params.userId, params.question, 5);
      const memorySummary = this.db.getMemorySummary(params.userId, 8);

      const out = await this.llm.answer({
        question: params.question,
        system: baseSystemPrompt,
        history,
        citations,
        personaProfile: params.profile,
        memorySummary,
        feedbackHints,
        decisionMode
      });

      let answer = out.answer;
      if (params.profile) {
        answer = humanizeAnswerWithProfile(`结论：${out.answer}`, params.profile);
      }

      this.db.addSessionTurn(params.userId, "user", params.question);
      this.db.addSessionTurn(params.userId, "assistant", out.answer);

      if (out.confidence === "high") {
        this.db.addMemory(params.userId, "recent_decision", out.answer.slice(0, 180), "high");
      }

      return {
        answer,
        evidences: legacy.evidences,
        conclusion: out.answer,
        supplement: out.nextActions.join("；"),
        sources: citationsToSources(citations),
        confidence: out.confidence,
        citations,
        decisionMode: out.decisionMode,
        riskBoundary: out.riskBoundary,
        nextActions: out.nextActions
      };
    } catch (err) {
      if (config.llmRoute === "llm_first" || params.forcePlus) {
        throw err;
      }
      const fallback = answerWithKnowledge(params.question, params.docs);
      return {
        ...fallback,
        confidence: "low",
        decisionMode,
        citations: fallback.evidences.slice(0, 3).map((e) => ({
          title: e.title,
          url: e.url,
          excerpt: highlightEvidence(params.question, e.excerpt),
          highlights: []
        })),
        riskBoundary: `LLM 暂时不可用，已降级规则引擎。`,
        nextActions: ["稍后可重试 /ask_plus 获取更深推理"]
      };
    }
  }


  async reembed(limit = 300): Promise<{ scanned: number; updated: number; modelId: string }> {
    return this.db.reembedChunks(this.embedding, limit);
  }

  async distill(docs: NotionDoc[], profile: SelfProfile | null): Promise<{ knowledgeDigest: string; selfDigest: string }> {
    if (!config.deepseekApiKey) {
      const plain = docs
        .slice(0, 20)
        .map((d) => `- ${d.title}: ${(d.distilled || d.preview || "").slice(0, 180)}`)
        .join("\n");
      return {
        knowledgeDigest: `# 知识蒸馏\n\n${plain}`,
        selfDigest: `# 工作体蒸馏\n\n- 人格: ${profile?.name ?? "未激活"}`
      };
    }

    const content = await this.llm.distillKnowledge(docs, profile);
    const selfDigest = [
      "# 工作体蒸馏",
      `- 当前人格: ${profile?.name ?? "未激活"}`,
      `- 风格提示: ${profile?.styleHint ?? "直接、简洁"}`,
      `- 规则条目: ${profile?.personaRules.length ?? 0}`,
      `- 纠正条目: ${profile?.corrections.length ?? 0}`
    ].join("\n");

    return { knowledgeDigest: content, selfDigest };
  }
}
