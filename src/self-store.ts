import { promises as fs } from "node:fs";
import path from "node:path";

export type SelfProfile = {
  slug: string;
  name: string;
  basicInfo: string;
  selfPortrait: string;
  styleHint: string;
  selfMemory: string[];
  personaRules: string[];
  corrections: string[];
  catchphrases: string[];
  createdAt: string;
  updatedAt: string;
  version: number;
};

type SelfState = {
  profiles: SelfProfile[];
  activeByUser: Record<string, string>;
};

const emptyState = (): SelfState => ({
  profiles: [],
  activeByUser: {}
});

const slugify = (input: string): string => {
  const ascii = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5\s_-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!ascii) return `self-${Date.now()}`;
  return ascii;
};

const nowIso = (): string => new Date().toISOString();

const parseCatchphrases = (portrait: string, styleHint: string): string[] => {
  const src = `${portrait} ${styleHint}`;
  const hits = src.match(/[“"]([^"”]{1,12})[”"]/g) ?? [];
  const mapped = hits
    .map((x) => x.replace(/[“”"]/g, "").trim())
    .filter(Boolean)
    .slice(0, 3);
  if (mapped.length > 0) return mapped;
  return ["先说重点"];
};

const extractLine = (prefix: string, text: string): string => {
  const line = text
    .split("\n")
    .map((x) => x.trim())
    .find((x) => x.startsWith(prefix));
  return line ? line.replace(prefix, "").trim() : "";
};

const extractSources = (text: string): string[] => {
  const lines = text.split("\n").map((x) => x.trim());
  const idx = lines.findIndex((x) => x === "来源：");
  if (idx < 0) return [];
  return lines
    .slice(idx + 1)
    .filter((x) => x.startsWith("- "))
    .slice(0, 2);
};

const buildSkillMarkdown = (p: SelfProfile): string => {
  const selfLines = p.selfMemory.length > 0 ? p.selfMemory.map((x) => `- ${x}`).join("\n") : "- 原材料不足";
  const personaLines = p.personaRules.length > 0 ? p.personaRules.map((x) => `- ${x}`).join("\n") : "- 原材料不足";
  const correctionLines = p.corrections.length > 0 ? p.corrections.map((x) => `- ${x}`).join("\n") : "- 暂无";

  return [
    `# ${p.name} — SKILL`,
    "",
    "## Part A — Self Memory",
    `- 基本信息：${p.basicInfo || "未填写"}`,
    `- 自我画像：${p.selfPortrait || "未填写"}`,
    selfLines,
    "",
    "## Part B — Persona",
    `- 风格提示：${p.styleHint || "直接、简洁、讲重点"}`,
    `- 口头禅：${p.catchphrases.join(" / ")}`,
    personaLines,
    "",
    "## Correction 记录",
    correctionLines
  ].join("\n");
};

export class SelfStore {
  private readonly absFile: string;
  private readonly selvesDir: string;

  constructor(filePath = "./data/selves-index.json", selvesDir = "./selves") {
    this.absFile = path.resolve(filePath);
    this.selvesDir = path.resolve(selvesDir);
  }

  async read(): Promise<SelfState> {
    try {
      const raw = await fs.readFile(this.absFile, "utf8");
      const parsed = JSON.parse(raw) as SelfState;
      return {
        profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
        activeByUser: parsed.activeByUser && typeof parsed.activeByUser === "object" ? parsed.activeByUser : {}
      };
    } catch {
      await this.write(emptyState());
      return emptyState();
    }
  }

  async write(state: SelfState): Promise<void> {
    await fs.mkdir(path.dirname(this.absFile), { recursive: true });
    await fs.writeFile(this.absFile, JSON.stringify(state, null, 2), "utf8");
  }

  async listProfiles(): Promise<SelfProfile[]> {
    const state = await this.read();
    return [...state.profiles].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getProfile(slug: string): Promise<SelfProfile | null> {
    const state = await this.read();
    return state.profiles.find((p) => p.slug === slug) ?? null;
  }

  async createProfile(input: { name: string; basicInfo?: string; selfPortrait?: string; styleHint?: string }): Promise<SelfProfile> {
    const state = await this.read();
    const slug = slugify(input.name);
    const existed = state.profiles.find((p) => p.slug === slug);
    const now = nowIso();
    const profile: SelfProfile = existed ?? {
      slug,
      name: input.name.trim(),
      basicInfo: input.basicInfo?.trim() ?? "",
      selfPortrait: input.selfPortrait?.trim() ?? "",
      styleHint: input.styleHint?.trim() ?? "直接、简洁、先结论后解释",
      selfMemory: [],
      personaRules: [],
      corrections: [],
      catchphrases: parseCatchphrases(input.selfPortrait ?? "", input.styleHint ?? ""),
      createdAt: now,
      updatedAt: now,
      version: 1
    };

    if (existed) {
      profile.name = input.name.trim() || profile.name;
      profile.basicInfo = input.basicInfo?.trim() || profile.basicInfo;
      profile.selfPortrait = input.selfPortrait?.trim() || profile.selfPortrait;
      profile.styleHint = input.styleHint?.trim() || profile.styleHint;
      profile.catchphrases = parseCatchphrases(profile.selfPortrait, profile.styleHint);
      profile.updatedAt = now;
      profile.version += 1;
    }

    const others = state.profiles.filter((p) => p.slug !== slug);
    await this.write({ ...state, profiles: [...others, profile] });
    await this.materialize(profile);
    return profile;
  }

  async setActiveForUser(userId: number, slug: string): Promise<boolean> {
    const state = await this.read();
    const exists = state.profiles.some((p) => p.slug === slug);
    if (!exists) return false;
    state.activeByUser[String(userId)] = slug;
    await this.write(state);
    return true;
  }

  async getActiveForUser(userId: number): Promise<SelfProfile | null> {
    const state = await this.read();
    const slug = state.activeByUser[String(userId)];
    if (!slug) return null;
    return state.profiles.find((p) => p.slug === slug) ?? null;
  }

  async appendSelfMemory(slug: string, note: string): Promise<SelfProfile | null> {
    return this.patch(slug, (p) => {
      p.selfMemory.unshift(note.trim());
      p.selfMemory = [...new Set(p.selfMemory)].slice(0, 50);
    });
  }

  async appendPersonaRule(slug: string, rule: string): Promise<SelfProfile | null> {
    return this.patch(slug, (p) => {
      p.personaRules.unshift(rule.trim());
      p.personaRules = [...new Set(p.personaRules)].slice(0, 50);
    });
  }

  async appendCorrection(slug: string, correction: string): Promise<SelfProfile | null> {
    return this.patch(slug, (p) => {
      p.corrections.unshift(`${nowIso()} ${correction.trim()}`);
      p.corrections = [...new Set(p.corrections)].slice(0, 50);
    });
  }

  private async patch(slug: string, updater: (p: SelfProfile) => void): Promise<SelfProfile | null> {
    const state = await this.read();
    const profile = state.profiles.find((p) => p.slug === slug);
    if (!profile) return null;
    updater(profile);
    profile.updatedAt = nowIso();
    profile.version += 1;
    await this.write(state);
    await this.materialize(profile);
    return profile;
  }

  private async materialize(profile: SelfProfile): Promise<void> {
    const dir = path.join(this.selvesDir, profile.slug);
    await fs.mkdir(dir, { recursive: true });
    const selfMd = [
      `# ${profile.name} — Self Memory`,
      "",
      `- 基本信息：${profile.basicInfo || "未填写"}`,
      `- 自我画像：${profile.selfPortrait || "未填写"}`,
      "",
      "## 记忆",
      ...(profile.selfMemory.length > 0 ? profile.selfMemory.map((x) => `- ${x}`) : ["- 原材料不足"])
    ].join("\n");
    const personaMd = [
      `# ${profile.name} — Persona`,
      "",
      `- 风格提示：${profile.styleHint || "直接、简洁、先结论后解释"}`,
      `- 口头禅：${profile.catchphrases.join(" / ")}`,
      "",
      "## 规则",
      ...(profile.personaRules.length > 0 ? profile.personaRules.map((x) => `- ${x}`) : ["- 原材料不足"]),
      "",
      "## Correction",
      ...(profile.corrections.length > 0 ? profile.corrections.map((x) => `- ${x}`) : ["- 暂无"])
    ].join("\n");
    const meta = JSON.stringify(
      {
        name: profile.name,
        slug: profile.slug,
        created_at: profile.createdAt,
        updated_at: profile.updatedAt,
        version: profile.version
      },
      null,
      2
    );
    await Promise.all([
      fs.writeFile(path.join(dir, "self.md"), selfMd, "utf8"),
      fs.writeFile(path.join(dir, "persona.md"), personaMd, "utf8"),
      fs.writeFile(path.join(dir, "meta.json"), meta, "utf8"),
      fs.writeFile(path.join(dir, "SKILL.md"), buildSkillMarkdown(profile), "utf8")
    ]);
  }
}

export const humanizeAnswerWithProfile = (rawAnswer: string, profile: SelfProfile | null): string => {
  if (!profile) return rawAnswer;

  const conclusion = extractLine("结论：", rawAnswer);
  const supplement = extractLine("补充：", rawAnswer);
  const sources = extractSources(rawAnswer);
  if (!conclusion) return rawAnswer;

  const opener = profile.catchphrases[0] ? `${profile.catchphrases[0]}，` : "";
  const lines = [
    `${opener}${conclusion}`,
    supplement ? `我再补一句：${supplement}` : "",
    sources.length > 0 ? "我参考了：" : "",
    ...sources,
    "如果你愿意，我可以继续把它拆成执行步骤。"
  ].filter(Boolean);
  return lines.join("\n");
};

