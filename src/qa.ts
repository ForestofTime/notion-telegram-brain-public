import { searchDocs } from "./search.js";
import type { NotionDoc } from "./types.js";

type Evidence = {
  title: string;
  url: string;
  excerpt: string;
  score: number;
};

export type QAResult = {
  answer: string;
  evidences: Evidence[];
  conclusion: string;
  supplement?: string;
  sources: Array<{ title: string; url: string }>;
  codeBlock?: string;
  codeLang?: string;
};

const normalize = (s: string | undefined | null): string => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

const QUESTION_STOP_WORDS = [
  "是什么",
  "什么",
  "怎么",
  "如何",
  "怎样",
  "吗",
  "么",
  "呢",
  "请问",
  "一下",
  "下",
  "有吗",
  "可以吗",
  "是否",
  "请",
  "告诉我",
  "有哪些",
  "有什么",
  "哪些",
  "列表",
  "清单",
  "都有什么",
  "包括"
];

const tokenize = (s: string): string[] => {
  const norm = normalize(s);
  const base = norm.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const cleaned = base
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !QUESTION_STOP_WORDS.includes(x))
    .filter((x) => x.length >= 2);

  const chineseText = norm.replace(/[^\p{Script=Han}]/gu, "");
  const hanBigrams: string[] = [];
  for (let i = 0; i < chineseText.length - 1; i += 1) {
    hanBigrams.push(chineseText.slice(i, i + 2));
  }

  const all = [...cleaned, ...hanBigrams].filter((x) => x.length >= 2);
  return [...new Set(all)];
};

const splitChunks = (text: string): string[] => {
  if (!text) return [];
  const raw = text
    .split(/\n{2,}|(?<=[。！？.!?；;])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const out: string[] = [];
  for (const block of raw) {
    if (block.length <= 260) {
      out.push(block);
    } else {
      for (let i = 0; i < block.length; i += 220) {
        out.push(block.slice(i, i + 220));
      }
    }
  }
  return out.slice(0, 40);
};

const keywordizeQuestion = (question: string): string[] => {
  const norm = normalize(question);
  const parts = norm
    .split(/[，,。；;：:\s/\\|]+/g)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !QUESTION_STOP_WORDS.includes(x))
    .filter((x) => x.length >= 2);

  const tokens = tokenize(question).filter((x) => x.length >= 2);
  const merged = [...parts, ...tokens].filter((x) => x.length >= 2);
  return [...new Set(merged)].slice(0, 16);
};

const isListQuestion = (q: string): boolean => /有哪些|有什么|哪些|清单|列表|都有什么|包括|列出/i.test(q);

const extractQuestionCore = (question: string): string => {
  const q = question.trim();
  const m = q.match(/^(.+?)(有哪些|有什么|哪些|清单|列表|都有什么|包括|列出)/);
  if (m?.[1]) return m[1].trim();
  return q;
};

const extractTopicKeywords = (question: string): string[] => {
  const generic = new Set([
    "有哪些",
    "有什么",
    "哪些",
    "清单",
    "列表",
    "都有什么",
    "包括",
    "列出",
    "怎么",
    "如何",
    "代码",
    "脚本",
    "查询",
    "获取",
    "实现"
  ]);
  const core = extractQuestionCore(question);
  return tokenize(core)
    .filter((k) => k.length >= 2)
    .filter((k) => !generic.has(k))
    .slice(0, 8);
};

const hasCoreHit = (doc: NotionDoc, core: string): boolean => {
  const c = normalize(core);
  if (!c) return false;
  const title = normalize(doc.title);
  const body = normalize(`${doc.markdown}\n${doc.contentText}\n${doc.distilled}\n${doc.preview}`);
  if (title.includes(c)) return true;
  if (body.includes(c)) return true;
  return false;
};

const docText = (d: NotionDoc): string => normalize(`${d.title}\n${d.distilled}\n${d.contentText}\n${d.preview}\n${d.markdown}`);

const scoreDocFocus = (doc: NotionDoc, question: string, core: string, topicKeywords: string[]): number => {
  const title = normalize(doc.title);
  const text = docText(doc);
  const q = normalize(question);
  const c = normalize(core);
  let score = 0;

  if (c && title.includes(c)) score += 3;
  if (c && text.includes(c)) score += 1.4;
  if (c && normalize(doc.markdown).includes(`# ${c}`)) score += 1.2;
  if (c && normalize(doc.markdown).includes(`## ${c}`)) score += 1.2;
  if (q && title.includes(q)) score += 2;

  const cov = topicKeywords.length
    ? topicKeywords.filter((k) => text.includes(normalize(k))).length / topicKeywords.length
    : 0;
  score += cov * 2.2;
  score += overlapScore(question, `${doc.title}\n${doc.distilled}\n${doc.preview}`) * 1.6;

  // 惩罚低覆盖候选，减少“主题不相关”的页面被选中
  if (topicKeywords.length >= 2 && cov < 0.34) score -= 1.6;
  return score;
};

const gatherQaCandidates = (docs: NotionDoc[], question: string): NotionDoc[] => {
  const core = extractQuestionCore(question);
  const topicKeywords = extractTopicKeywords(question);
  const variants = [question, ...keywordizeQuestion(question)];
  const merged = new Map<string, NotionDoc>();

  for (const v of variants) {
    const hits = searchDocs(docs, v).slice(0, 20);
    for (const h of hits) {
      if (!merged.has(h.id)) merged.set(h.id, h);
    }
  }

  if (merged.size === 0) {
    const keywords = keywordizeQuestion(question).filter((k) => k.length >= 2);
    for (const d of docs) {
      const hay = normalize(`${d.title}\n${d.distilled}\n${d.contentText || ""}\n${d.preview}`);
      if (keywords.some((k) => hay.includes(k))) {
        merged.set(d.id, d);
        if (merged.size >= 30) break;
      }
    }
  }

  let list = [...merged.values()];

  // 若存在标题直接命中 core 的文档，优先锁定到同主题范围
  const directTitleHits = list.filter((d) => normalize(d.title).includes(normalize(core)));
  if (core && directTitleHits.length > 0) {
    list = directTitleHits;
  }

  list = list
    .map((d) => ({ d, s: scoreDocFocus(d, question, core, topicKeywords) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.d)
    .slice(0, 30);

  return list;
};

const overlapScore = (query: string, text: string): number => {
  const q = tokenize(query).slice(0, 16);
  if (q.length === 0) return 0;
  const t = normalize(text);
  let hit = 0;
  for (const w of q) {
    if (t.includes(w)) hit += 1;
  }
  const phraseBonus = t.includes(normalize(query)) ? 0.35 : 0;
  return hit / q.length + phraseBonus;
};

const isCodeQuestion = (q: string): boolean => /代码|脚本|sql|js|java|python|函数|怎么写|示例/i.test(q);

const extractCodeBlocks = (markdown: string): Array<{ lang: string; code: string }> => {
  const out: Array<{ lang: string; code: string }> = [];
  const re = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null = re.exec(markdown);
  while (m) {
    out.push({ lang: (m[1] || "").trim(), code: (m[2] || "").trim() });
    m = re.exec(markdown);
  }
  return out;
};

const extractQuestionKeywords = (question: string): string[] => {
  const generic = new Set([
    "代码",
    "脚本",
    "查询",
    "工作流",
    "怎么写",
    "获取",
    "实现",
    "示例",
    "中",
    "里",
    "的"
  ]);
  return tokenize(question)
    .filter((k) => k.length >= 2)
    .filter((k) => !generic.has(k))
    .slice(0, 10);
};

const iterCodeBlocksWithContext = (markdown: string): Array<{ lang: string; code: string; context: string }> => {
  const out: Array<{ lang: string; code: string; context: string }> = [];
  const re = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null = re.exec(markdown);
  while (m) {
    const lang = (m[1] || "").trim();
    const code = (m[2] || "").trim();
    const start = Math.max(0, m.index - 220);
    const context = markdown.slice(start, m.index).trim();
    out.push({ lang, code, context });
    m = re.exec(markdown);
  }
  return out;
};

const pickCodeFromCandidates = (question: string, candidates: NotionDoc[]): { code?: string; lang?: string } => {
  const codeHints = /(codingrule|javaimporter|getboscontext|getparamasobjectvalue|getlocalinstancenumber|setresult|getnumber|编码|单据|sql|select)/i;
  const qKeywords = extractQuestionKeywords(question);
  const rankedDocs = [...candidates]
    .map((d) => ({
      doc: d,
      score: overlapScore(question, d.title) * 1.5 + overlapScore(question, `${d.distilled}\n${d.preview}`)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((x) => x.doc);

  let best: { code?: string; lang?: string; score: number } = { score: -1 };
  for (const doc of rankedDocs) {
    const blocks = iterCodeBlocksWithContext(doc.markdown || "");
    for (const b of blocks) {
      const merged = `${doc.title}\n${doc.distilled}\n${b.context}\n${b.code}`;
      const keywordHit = qKeywords.filter((k) => normalize(merged).includes(normalize(k)));
      // 若问题里有明确业务词（如“省区长”），优先要求在代码或邻近上下文命中
      if (qKeywords.length > 0 && keywordHit.length === 0) continue;

      let score =
        overlapScore(question, b.code) * 2.2 +
        overlapScore(question, `${doc.title}\n${doc.distilled}`) * 1.3 +
        overlapScore(question, b.context) * 1.8 +
        keywordHit.length * 0.8;
      if (codeHints.test(b.code)) score += 0.4;
      if (b.code.length >= 60) score += 0.05;
      if (score > best.score) {
        best = { code: b.code, lang: b.lang || "javascript", score };
      }
    }
  }
  // 如果严格命中一个都没有，退化到旧逻辑兜底
  if (!best.code) {
    for (const doc of rankedDocs) {
      const blocks = extractCodeBlocks(doc.markdown || "");
      for (const b of blocks) {
        const score = overlapScore(question, b.code) * 1.5 + overlapScore(question, doc.title) + overlapScore(question, doc.distilled);
        if (score > best.score) {
          best = { code: b.code, lang: b.lang || "javascript", score };
        }
      }
    }
  }
  return best.code ? { code: best.code, lang: best.lang } : {};
};

const extractListItemsFromDoc = (doc: NotionDoc): string[] => {
  const src = (doc.markdown && doc.markdown.length > 0 ? doc.markdown : doc.contentText) || "";
  if (!src) return [];
  const out: string[] = [];

  const lineRe = /(?:^|\n)\s*(?:[-*]|[0-9]{1,2}[.)、])\s*([^\n]{2,180})/g;
  let m: RegExpExecArray | null = lineRe.exec(src);
  while (m) {
    const item = m[1].trim();
    if (item && !out.includes(item)) out.push(item);
    m = lineRe.exec(src);
    if (out.length >= 20) break;
  }

  if (out.length === 0) {
    const seqRe = /(?:^|[。；;\n])\s*([0-9]{1,2}[.)、][^。；;\n]{2,120})/g;
    let s: RegExpExecArray | null = seqRe.exec(src);
    while (s) {
      const item = s[1].replace(/^[0-9]{1,2}[.)、]\s*/, "").trim();
      if (item && !out.includes(item)) out.push(item);
      s = seqRe.exec(src);
      if (out.length >= 20) break;
    }
  }
  return out;
};

const extractSectionText = (doc: NotionDoc, core: string): string => {
  const src = (doc.markdown && doc.markdown.length > 0 ? doc.markdown : doc.contentText) || "";
  if (!src || !core) return "";
  const lines = src.split("\n");
  const hitIdx = lines.findIndex((line) => normalize(line).includes(normalize(core)));
  if (hitIdx < 0) return "";
  let endIdx = lines.length;
  for (let i = hitIdx + 1; i < lines.length; i += 1) {
    if (/^\s*#{1,6}\s+/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(hitIdx, endIdx).join("\n").trim();
};

const extractListItemsFromSection = (doc: NotionDoc, core: string): string[] => {
  const src = (doc.markdown && doc.markdown.length > 0 ? doc.markdown : doc.contentText) || "";
  if (!src || !core) return [];
  const lines = src.split("\n");
  const coreIdx = lines.findIndex((line) => normalize(line).includes(normalize(core)));
  if (coreIdx < 0) return [];

  // 优先在核心词附近固定窗口取列表，降低跨章节污染
  const near = lines.slice(coreIdx, Math.min(lines.length, coreIdx + 45)).join("\n").trim();
  const nearDoc: NotionDoc = { ...doc, markdown: near, contentText: near };
  const nearItems = extractListItemsFromDoc(nearDoc);
  if (nearItems.length > 0) return nearItems;

  const section = extractSectionText(doc, core);
  if (!section) return [];
  const tempDoc: NotionDoc = {
    ...doc,
    markdown: section,
    contentText: section
  };
  return extractListItemsFromDoc(tempDoc);
};

export const answerWithKnowledge = (question: string, docs: NotionDoc[]): QAResult => {
  const q = question.trim();
  if (!q) {
    return {
      answer: "问题为空。请使用 /ask 你的问题",
      evidences: [],
      conclusion: "问题为空",
      sources: []
    };
  }

  const candidates = gatherQaCandidates(docs, q);
  const core = extractQuestionCore(q);
  const topicKeywords = extractTopicKeywords(q);
  const evidences: Evidence[] = [];

  for (const doc of candidates) {
    const chunks = splitChunks(`${doc.distilled ?? ""}\n${doc.contentText || doc.preview || ""}`);
    for (const c of chunks) {
      const score = overlapScore(q, c);
      if (score > 0) {
        evidences.push({
          title: doc.title,
          url: doc.url,
          excerpt: c,
          score
        });
      }
    }
  }

  evidences.sort((a, b) => b.score - a.score);
  let top = dedupeEvidences(evidences).slice(0, 4);

  if (top.length === 0 && candidates.length > 0) {
    const fallback: Evidence[] = [];
    for (const doc of candidates.slice(0, 5)) {
      const chunks = splitChunks(`${doc.distilled ?? ""}\n${doc.contentText || doc.preview || ""}`);
      if (chunks.length === 0) continue;
      fallback.push({
        title: doc.title,
        url: doc.url,
        excerpt: chunks[0],
        score: 0.01
      });
    }
    top = fallback;
  }

  if (top.length === 0) {
    const answer = [
      "工作体判断：当前知识证据不足，无法给出可靠结论。",
      "",
      "建议动作：",
      "1. 先执行 /sync full 重建索引。",
      "2. 或用 /learn 补充这类问题的规则与案例。",
      "3. 再次提问时补充组织、单据类型、触发条件。"
    ].join("\n");
    return { answer, evidences: [], conclusion: "证据不足", sources: [] };
  }

  // 列表问题优先返回“目标页面中的条目”，减少拼接无关段落
  if (isListQuestion(q) && candidates.length > 0) {
    const strictCoreDocs = core ? candidates.filter((d) => hasCoreHit(d, core)) : [];
    const baseDocs = strictCoreDocs.length > 0 ? strictCoreDocs : candidates;
    const focusedDocs = baseDocs
      .filter((d) => {
        const t = docText(d);
        if (core && hasCoreHit(d, core)) return true;
        if (topicKeywords.length === 0) return true;
        const cov = topicKeywords.filter((k) => t.includes(normalize(k))).length / topicKeywords.length;
        return cov >= 0.34;
      })
      .slice(0, 3);
    const bestDoc = focusedDocs[0] ?? candidates[0];
    const sectionItems = core ? extractListItemsFromSection(bestDoc, core) : [];
    const items = (sectionItems.length > 0 ? sectionItems : extractListItemsFromDoc(bestDoc)).slice(0, 12);
    if (items.length > 0) {
      const listText = items.map((x, i) => `${i + 1}. ${x}`).join("\n");
      const topicLabel = core || bestDoc.title;
      const answer = [`结论：${topicLabel} 当前可提取到以下条目。`, "", `补充：\n${listText}`, "", "来源：", `- ${bestDoc.title}: ${bestDoc.url}`].join("\n");
      return {
        answer,
        evidences: top,
        conclusion: `${topicLabel} 当前可提取到以下条目。`,
        supplement: listText,
        sources: [{ title: bestDoc.title, url: bestDoc.url }]
      };
    }
  }

  top = diversifyByUrl(top, 3);

  const focused = top.map((e) => normalizeAnswerLine(pickFocusedLine(q, e.excerpt))).filter(Boolean);
  const uniqueFocused = [...new Set(focused)].slice(0, 2);
  const conciseConclusion = uniqueFocused[0] ?? top[0].excerpt;
  const actions = uniqueFocused
    .slice(1, 2)
    .filter((line) => !isNearDuplicate(line, conciseConclusion));
  const sourceEvidences = uniqueByUrl(top).slice(0, 2);
  const sourceLines = sourceEvidences.map((e) => `- ${e.title}: ${e.url}`).join("\n");
  const sources = sourceEvidences.map((e) => ({ title: e.title, url: e.url }));
  const needsCode = isCodeQuestion(q);
  const code = needsCode ? pickCodeFromCandidates(q, candidates) : {};
  const finalConclusion = code.code ? "以下是知识库命中的代码实现，可直接参考。" : conciseConclusion;

  const finalSupplement = code.code ? undefined : actions[0];

  const answer = [
    `结论：${finalConclusion}`,
    "",
    finalSupplement ? `补充：${finalSupplement}` : "",
    "",
    code.code ? "代码：" : "",
    code.code ? `\`\`\`${code.lang || ""}\n${code.code}\n\`\`\`` : "",
    "",
    "来源：",
    sourceLines,
    ""
  ]
    .filter(Boolean)
    .join("\n");

  return {
    answer,
    evidences: top,
    conclusion: finalConclusion,
    supplement: finalSupplement,
    sources,
    codeBlock: code.code,
    codeLang: code.lang
  };
};

export const highlightEvidence = (question: string, excerpt: string): string => {
  const words = [...new Set(tokenize(question))]
    .filter((w) => w.length >= 2)
    .sort((a, b) => b.length - a.length)
    .slice(0, 8);
  if (words.length === 0) return excerpt;

  let out = excerpt;
  for (const w of words) {
    const re = new RegExp(`(${escapeRegExp(w)})`, "gi");
    out = out.replace(re, "【$1】");
  }
  return out;
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const dedupeEvidences = (input: Evidence[]): Evidence[] => {
  const out: Evidence[] = [];
  const seen = new Set<string>();
  for (const e of input) {
    const key = `${e.url}::${normalize(e.excerpt).slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
    if (out.length >= 12) break;
  }
  return out;
};

const diversifyByUrl = (input: Evidence[], limit: number): Evidence[] => {
  const out: Evidence[] = [];
  const seenUrl = new Set<string>();
  for (const e of input) {
    if (seenUrl.has(e.url)) continue;
    seenUrl.add(e.url);
    out.push(e);
    if (out.length >= limit) return out;
  }
  for (const e of input) {
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
};

const uniqueByUrl = (input: Evidence[]): Evidence[] => {
  const out: Evidence[] = [];
  const seen = new Set<string>();
  for (const e of input) {
    if (seen.has(e.url)) continue;
    seen.add(e.url);
    out.push(e);
  }
  return out;
};

const normalizeAnswerLine = (line: string): string => {
  return line
    .replace(/^[（(]?\d+[）).、\s]*/u, "")
    .replace(/\s+/g, " ")
    .trim();
};

const isNearDuplicate = (a: string, b: string): boolean => {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ta = new Set(tokenize(na));
  const tb = new Set(tokenize(nb));
  if (ta.size === 0 || tb.size === 0) return false;
  let inter = 0;
  for (const x of ta) {
    if (tb.has(x)) inter += 1;
  }
  const jaccard = inter / (ta.size + tb.size - inter);
  return jaccard >= 0.7;
};

const pickFocusedLine = (question: string, excerpt: string): string => {
  const keys = tokenize(question).filter((k) => k.length >= 2).slice(0, 8);
  const lines = excerpt
    .split(/[。！？!?；;\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  for (const line of lines) {
    const t = normalize(line);
    if (keys.some((k) => t.includes(k))) {
      return line.length > 180 ? `${line.slice(0, 180)}...` : line;
    }
  }
  const first = lines[0] ?? excerpt.trim();
  return first.length > 180 ? `${first.slice(0, 180)}...` : first;
};

export const buildDigestMarkdown = (docs: NotionDoc[], limit = 60): string => {
  const sorted = [...docs]
    .sort((a, b) => b.lastEditedTime.localeCompare(a.lastEditedTime))
    .slice(0, limit);

  const lines: string[] = [];
  lines.push("# Notion 数字工作体知识蒸馏");
  lines.push("");
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push(`文档数量：${sorted.length}`);
  lines.push("");

  for (const d of sorted) {
    lines.push(`## ${d.title}`);
    lines.push(`- 更新时间：${d.lastEditedTime}`);
    lines.push(`- 链接：${d.url}`);
    lines.push(`- 蒸馏：${d.distilled || d.preview || "无"}`);
    lines.push("");
  }

  return lines.join("\n");
};
