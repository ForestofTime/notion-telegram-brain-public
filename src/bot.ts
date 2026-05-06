import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Markup, Telegraf } from "telegraf";
import type { Context } from "telegraf";
import { BrainService } from "./brain.js";
import { config } from "./config.js";
import { BrainDB } from "./db.js";
import type { NotionSyncService } from "./notion-sync.js";
import { searchDocs } from "./search.js";
import { SelfStore } from "./self-store.js";
import type { JsonStore } from "./store.js";
import type { QAResult } from "./qa.js";

type Session = {
  id: string;
  query: string;
  page: number;
  resultIds: string[];
  createdAt: number;
};

type SyncState = {
  running: boolean;
  forceFull: boolean;
  startedAt?: string;
  finishedAt?: string;
  scanned?: number;
  indexed?: number;
  error?: string;
};

const SESSION_TTL_MS = 30 * 60 * 1000;

const BOT_COMMANDS: Array<{ command: string; description: string }> = [
  { command: "help", description: "查看全部命令" },
  { command: "ping", description: "健康检查" },
  { command: "ask", description: "提问（按路由）" },
  { command: "ask_plus", description: "强制 LLM 混合链路" },
  { command: "feedback", description: "纠正上一轮答案" },
  { command: "memory_status", description: "查看记忆摘要" },
  { command: "goal", description: "设置/查看当前协作目标" },
  { command: "notion", description: "关键词检索" },
  { command: "sync", description: "增量/全量同步" },
  { command: "sync_status", description: "查看同步状态" },
  { command: "create_yourself", description: "创建数字工作体" },
  { command: "list_selves", description: "列出工作体" },
  { command: "use_self", description: "切换工作体" },
  { command: "show_self", description: "查看工作体详情" },
  { command: "update_yourself", description: "追加记忆" },
  { command: "update_persona", description: "追加人格规则" },
  { command: "correct_yourself", description: "追加纠正" },
  { command: "learn", description: "手工补充知识" },
  { command: "digest", description: "输出双层蒸馏文档" },
  { command: "reset_context", description: "清空会话上下文" }
];

const escapeHtml = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const parseTail = (text: string | undefined, command: string): string => {
  if (!text) return "";
  const re = new RegExp(`^\\/${command}(?:@\\w+)?\\s*`, "i");
  return text.replace(re, "").trim();
};

const isAllowed = (ctx: Context): boolean => {
  const uid = ctx.from?.id;
  return typeof uid === "number" && config.allowedUsers.includes(uid);
};

const parseSync = (text: string | undefined): { forceFull: boolean } => {
  const t = text ?? "";
  return { forceFull: /all|full|force|全量/i.test(t) };
};

const parseLearn = (text: string | undefined): { title: string; body: string } => {
  const raw = (text ?? "").replace(/^\/learn(?:@\w+)?\s*/i, "").trim();
  if (!raw) return { title: "", body: "" };
  const parts = raw.split("|");
  if (parts.length === 1) {
    return { title: `手工知识 ${new Date().toISOString()}`, body: parts[0].trim() };
  }
  return { title: parts[0].trim(), body: parts.slice(1).join("|").trim() };
};

const parseCreateYourself = (
  text: string | undefined
): { name: string; basicInfo: string; selfPortrait: string; styleHint: string } => {
  const raw = (text ?? "").replace(/^\/create_yourself(?:@\w+)?\s*/i, "").trim();
  const [name = "", basicInfo = "", selfPortrait = "", styleHint = ""] = raw.split("|").map((x) => x.trim());
  return { name, basicInfo, selfPortrait, styleHint };
};

const parseSlugAndContent = (text: string | undefined, command: string): { slug: string; content: string } => {
  const raw = parseTail(text, command);
  const [slug = "", ...rest] = raw.split("|");
  return { slug: slug.trim(), content: rest.join("|").trim() };
};

export class NotionTelegramBot {
  private readonly bot: Telegraf;
  private readonly selfStore = new SelfStore();
  private readonly brain: BrainService;
  private readonly sessions = new Map<string, Session>();
  private syncState: SyncState = { running: false, forceFull: false };

  constructor(
    private readonly store: JsonStore,
    private readonly syncService: NotionSyncService,
    private readonly db: BrainDB
  ) {
    this.bot = new Telegraf(config.telegramBotToken);
    this.brain = new BrainService(db);
    this.registerHandlers();
  }

  async launch(): Promise<void> {
    try {
      await this.bot.telegram.setMyCommands(BOT_COMMANDS);
    } catch (err) {
      console.warn("[bot] setMyCommands failed:", (err as Error).message);
    }
    await this.bot.launch();
  }

  async stop(signal = "SIGTERM"): Promise<void> {
    this.bot.stop(signal);
  }

  private registerHandlers(): void {
    this.bot.use(async (ctx, next) => {
      if (!isAllowed(ctx)) {
        if (ctx.chat?.type === "private") await ctx.reply("无权限使用此机器人。");
        return;
      }
      await next();
    });

    this.bot.start(async (ctx) => ctx.reply("机器人已启动，输入 /help 查看命令。"));
    this.bot.command("help", async (ctx) => ctx.reply(this.helpText()));
    this.bot.command("ping", async (ctx) => ctx.reply(`pong\nroute=${config.llmRoute}\nmodel=${config.deepseekModel}`));

    this.bot.command("create_yourself", async (ctx) => {
      const uid = ctx.from?.id;
      if (typeof uid !== "number") return ctx.reply("无法识别用户。");
      const args = parseCreateYourself(ctx.message?.text);
      if (!args.name) return ctx.reply("用法: /create_yourself 名字|基本信息|自我画像|说话风格");
      const profile = await this.selfStore.createProfile(args);
      await this.selfStore.setActiveForUser(uid, profile.slug);
      await ctx.reply(`已创建并激活工作体: ${profile.name} (${profile.slug}) v${profile.version}`);
    });

    this.bot.command("list_selves", async (ctx) => {
      const list = await this.selfStore.listProfiles();
      if (list.length === 0) return ctx.reply("还没有工作体。先用 /create_yourself 创建。");
      await ctx.reply(["工作体列表:", ...list.map((p, i) => `${i + 1}. ${p.name} (${p.slug}) v${p.version}`)].join("\n"));
    });

    this.bot.command("use_self", async (ctx) => {
      const uid = ctx.from?.id;
      if (typeof uid !== "number") return ctx.reply("无法识别用户。");
      const slug = parseTail(ctx.message?.text, "use_self");
      if (!slug) return ctx.reply("用法: /use_self <slug>");
      const ok = await this.selfStore.setActiveForUser(uid, slug);
      await ctx.reply(ok ? `已切换到 ${slug}` : `未找到 ${slug}`);
    });

    this.bot.command("show_self", async (ctx) => {
      const uid = ctx.from?.id;
      if (typeof uid !== "number") return ctx.reply("无法识别用户。");
      const slug = parseTail(ctx.message?.text, "show_self");
      const profile = slug ? await this.selfStore.getProfile(slug) : await this.selfStore.getActiveForUser(uid);
      if (!profile) return ctx.reply("未找到工作体。");
      await ctx.reply(
        [
          `名称: ${profile.name}`,
          `slug: ${profile.slug}`,
          `版本: v${profile.version}`,
          `风格: ${profile.styleHint || "未设置"}`,
          `记忆: ${profile.selfMemory.length}`,
          `规则: ${profile.personaRules.length}`,
          `纠正: ${profile.corrections.length}`
        ].join("\n")
      );
    });

    this.bot.command("update_yourself", async (ctx) => {
      const { slug, content } = parseSlugAndContent(ctx.message?.text, "update_yourself");
      if (!slug || !content) return ctx.reply("用法: /update_yourself <slug>|增量记忆");
      const p = await this.selfStore.appendSelfMemory(slug, content);
      if (!p) return ctx.reply(`未找到 ${slug}`);
      await ctx.reply(`已更新 Self Memory，v${p.version}`);
    });

    this.bot.command("update_persona", async (ctx) => {
      const { slug, content } = parseSlugAndContent(ctx.message?.text, "update_persona");
      if (!slug || !content) return ctx.reply("用法: /update_persona <slug>|人格规则");
      const p = await this.selfStore.appendPersonaRule(slug, content);
      if (!p) return ctx.reply(`未找到 ${slug}`);
      await ctx.reply(`已更新 Persona，v${p.version}`);
    });

    this.bot.command("correct_yourself", async (ctx) => {
      const { slug, content } = parseSlugAndContent(ctx.message?.text, "correct_yourself");
      if (!slug || !content) return ctx.reply("用法: /correct_yourself <slug>|纠正说明");
      const p = await this.selfStore.appendCorrection(slug, content);
      if (!p) return ctx.reply(`未找到 ${slug}`);
      this.db.addFeedback(ctx.from?.id ?? 0, "persona", slug, content);
      await ctx.reply(`纠正已记录并生效，v${p.version}`);
    });

    this.bot.command("sync", async (ctx) => {
      const { forceFull } = parseSync(ctx.message?.text);
      if (this.syncState.running) return ctx.reply("已有同步任务在运行，请稍后 /sync_status 查看。");
      this.syncState = { running: true, forceFull, startedAt: new Date().toISOString() };
      await ctx.reply(forceFull ? "开始全量同步，请稍候..." : "开始增量同步，请稍候...");
      try {
        const result = await this.syncService.sync({ forceFull });
        this.db.upsertDocs(result.changedDocs);
        this.syncState = {
          running: false,
          forceFull,
          startedAt: this.syncState.startedAt,
          finishedAt: result.lastSyncAt,
          scanned: result.scanned,
          indexed: result.indexed
        };
        await ctx.reply(`同步完成\n扫描: ${result.scanned}\n索引总量: ${result.indexed}`);
      } catch (err) {
        this.syncState = {
          running: false,
          forceFull,
          startedAt: this.syncState.startedAt,
          finishedAt: new Date().toISOString(),
          error: (err as Error).message
        };
        await ctx.reply(`同步失败: ${(err as Error).message}`);
      }
    });

    this.bot.command("sync_status", async (ctx) => {
      if (this.syncState.running) {
        return ctx.reply(`同步中\n开始: ${this.syncState.startedAt}\n模式: ${this.syncState.forceFull ? "full" : "incremental"}`);
      }
      if (!this.syncState.finishedAt) return ctx.reply("尚未执行同步");
      await ctx.reply(
        [
          `状态: 空闲`,
          `上次结束: ${this.syncState.finishedAt}`,
          `模式: ${this.syncState.forceFull ? "full" : "incremental"}`,
          this.syncState.error ? `结果: 失败\n原因: ${this.syncState.error}` : "结果: 成功",
          `扫描: ${this.syncState.scanned ?? 0}`,
          `索引总量: ${this.syncState.indexed ?? 0}`
        ].join("\n")
      );
    });

    this.bot.command("notion", async (ctx) => {
      const query = parseTail(ctx.message?.text, "notion");
      if (!query) return ctx.reply("用法: /notion <关键词>");
      const index = await this.store.read();
      if (index.docs.length === 0) return ctx.reply("知识库为空，请先 /sync");

      const results = searchDocs(index.docs, query);
      if (results.length === 0) return ctx.reply(`未找到与“${query}”相关内容。`);

      const session: Session = { id: randomUUID().slice(0, 8), query, page: 0, resultIds: results.map((d) => d.id), createdAt: Date.now() };
      this.sessions.set(session.id, session);
      this.gcSessions();
      await this.replySearchPage(ctx, session);
    });

    this.bot.command("ask", async (ctx) => {
      const question = parseTail(ctx.message?.text, "ask");
      if (!question) return ctx.reply("用法: /ask 你的问题");
      await this.handleAsk(ctx, question, false);
    });

    this.bot.command("ask_plus", async (ctx) => {
      const question = parseTail(ctx.message?.text, "ask_plus");
      if (!question) return ctx.reply("用法: /ask_plus 你的问题");
      await this.handleAsk(ctx, question, true);
    });

    this.bot.command("feedback", async (ctx) => {
      const raw = parseTail(ctx.message?.text, "feedback");
      if (!raw) return ctx.reply("用法: /feedback 事实|你的纠正内容");
      const [feedbackType = "事实", ...rest] = raw.split("|");
      const correction = rest.join("|").trim() || feedbackType;
      const uid = ctx.from?.id;
      if (typeof uid !== "number") return ctx.reply("无法识别用户。");
      this.db.addFeedback(uid, feedbackType.trim(), "manual", correction);
      await ctx.reply("已写入纠正反馈，后续问答会优先参考。", { link_preview_options: { is_disabled: true } });
    });

    this.bot.command("memory_status", async (ctx) => {
      const uid = ctx.from?.id;
      if (typeof uid !== "number") return ctx.reply("无法识别用户。");
      const summary = this.db.getMemorySummary(uid, 10);
      const session = this.db.getRecentSession(uid, 8);
      await ctx.reply(["长期记忆:", summary, "", "最近会话:", ...session.map((s) => `- ${s.role}: ${s.content.slice(0, 120)}`)].join("\n"));
    });

    this.bot.command("goal", async (ctx) => {
      const uid = ctx.from?.id;
      if (typeof uid !== "number") return ctx.reply("无法识别用户。");
      const g = parseTail(ctx.message?.text, "goal");
      if (!g) {
        const goals = this.db.getGoals(uid, 5);
        if (goals.length === 0) return ctx.reply("当前还没有设置目标。用法: /goal 你的目标");
        return ctx.reply(["当前目标:", ...goals.map((x, i) => `${i + 1}. ${x}`)].join("\n"));
      }
      this.db.setGoal(uid, g);
      await ctx.reply(`已记录目标: ${g}`);
    });

    this.bot.command("reembed", async (ctx) => {
      const count = Number.parseInt(parseTail(ctx.message?.text, "reembed") || "300", 10);
      const r = await this.brain.reembed(Number.isFinite(count) ? Math.max(1, Math.min(count, 2000)) : 300);
      await ctx.reply(`向量重算完成 model=${r.modelId} scanned=${r.scanned} updated=${r.updated}`);
    });

    this.bot.command("reset_context", async (ctx) => {
      const uid = ctx.from?.id;
      if (typeof uid !== "number") return ctx.reply("无法识别用户。");
      this.db.addMemory(uid, "session_reset", "user reset context", "medium", "short");
      await ctx.reply("已记录上下文重置。新的提问将按新上下文处理。");
    });

    this.bot.command("learn", async (ctx) => {
      const { title, body } = parseLearn(ctx.message?.text);
      if (!body) return ctx.reply("用法: /learn 标题|内容");
      const now = new Date().toISOString();
      const store = await this.store.read();
      const doc = {
        id: `manual-${Date.now()}`,
        title: title || `手工知识 ${now}`,
        url: "local://manual",
        lastEditedTime: now,
        createdTime: now,
        kind: "page" as const,
        parentType: "manual",
        markdown: body,
        contentText: body,
        distilled: `${title}：${body}`.slice(0, 500),
        preview: body.slice(0, 240)
      };
      await this.store.upsertDocs([doc], now);
      this.db.upsertDocs([doc]);
      await ctx.reply(`已写入知识：${doc.title}`);
    });

    this.bot.command("digest", async (ctx) => {
      const uid = ctx.from?.id;
      if (typeof uid !== "number") return ctx.reply("无法识别用户。");
      const store = await this.store.read();
      if (store.docs.length === 0) return ctx.reply("知识库为空，请先 /sync");
      const profile = await this.selfStore.getActiveForUser(uid);
      const distill = await this.brain.distill(store.docs, profile);
      const digestPath = path.resolve("./data/knowledge-digest.md");
      const selfDigestPath = path.resolve("./data/self-digest.md");
      await fs.mkdir(path.dirname(digestPath), { recursive: true });
      await fs.writeFile(digestPath, distill.knowledgeDigest, "utf8");
      await fs.writeFile(selfDigestPath, distill.selfDigest, "utf8");
      await ctx.reply(`蒸馏完成:\n- ${digestPath}\n- ${selfDigestPath}`);
    });

    this.bot.on("callback_query", async (ctx) => {
      const data = "data" in ctx.callbackQuery ? ctx.callbackQuery.data : "";
      if (typeof data !== "string") return ctx.answerCbQuery();
      const parts = data.split(":");
      if (parts.length !== 3) return ctx.answerCbQuery();
      const [action, sid, arg] = parts;
      const session = this.sessions.get(sid);
      if (!session) return ctx.answerCbQuery("会话过期，请重新检索");

      if (action === "view") {
        const idx = Number.parseInt(arg, 10);
        const store = await this.store.read();
        const id = session.resultIds[idx];
        const doc = store.docs.find((d) => d.id === id);
        if (!doc) return ctx.answerCbQuery("结果不存在");

        await ctx.reply(
          [
            `<b>${escapeHtml(doc.title)}</b>`,
            `类型: ${doc.kind}`,
            `更新时间: ${escapeHtml(doc.lastEditedTime)}`,
            "",
            escapeHtml((doc.preview || doc.markdown || "无预览内容").slice(0, 420)),
            "",
            `<a href=\"${doc.url}\">打开 Notion 原文</a>`
          ].join("\n"),
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
        );
        return ctx.answerCbQuery("已发送详情");
      }

      if (action === "page") {
        session.page = Number.parseInt(arg, 10) || 0;
        await this.editSearchPage(ctx, session);
      }
      return ctx.answerCbQuery();
    });
  }

  private gcSessions(): void {
    const now = Date.now();
    for (const [sid, s] of this.sessions.entries()) {
      if (now - s.createdAt > SESSION_TTL_MS) this.sessions.delete(sid);
    }
  }

  private async replySearchPage(ctx: Context, session: Session): Promise<void> {
    const { text, keyboard } = await this.buildPageView(session);
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard.reply_markup, link_preview_options: { is_disabled: true } });
  }

  private async editSearchPage(ctx: Context, session: Session): Promise<void> {
    const { text, keyboard } = await this.buildPageView(session);
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: keyboard.reply_markup,
      link_preview_options: { is_disabled: true }
    });
  }

  private async buildPageView(session: Session): Promise<{ text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> }> {
    const store = await this.store.read();
    const docs = session.resultIds.map((id) => store.docs.find((d) => d.id === id)).filter((d): d is NonNullable<typeof d> => Boolean(d));

    const pageSize = config.resultsPerPage;
    const totalPages = Math.max(1, Math.ceil(docs.length / pageSize));
    if (session.page < 0) session.page = 0;
    if (session.page >= totalPages) session.page = totalPages - 1;

    const start = session.page * pageSize;
    const pageDocs = docs.slice(start, start + pageSize);

    const lines = [`<b>检索:</b> ${escapeHtml(session.query)}`, `<b>结果:</b> ${docs.length} 条，页 ${session.page + 1}/${totalPages}`, ""];
    pageDocs.forEach((doc, i) => lines.push(`${start + i + 1}. ${escapeHtml(doc.title)} (${doc.kind})`));

    const buttons = pageDocs.map((doc, i) => [Markup.button.callback(`查看 ${start + i + 1}. ${doc.title.slice(0, 18)}`, `view:${session.id}:${start + i}`)]);
    const nav: ReturnType<typeof Markup.button.callback>[] = [];
    if (session.page > 0) nav.push(Markup.button.callback("上一页", `page:${session.id}:${session.page - 1}`));
    if (session.page < totalPages - 1) nav.push(Markup.button.callback("下一页", `page:${session.id}:${session.page + 1}`));
    if (nav.length) buttons.push(nav);

    return { text: lines.join("\n"), keyboard: Markup.inlineKeyboard(buttons) };
  }

  private async handleAsk(ctx: Context, question: string, forcePlus: boolean): Promise<void> {
    const uid = ctx.from?.id;
    if (typeof uid !== "number") return void (await ctx.reply("无法识别用户。"));
    const store = await this.store.read();
    if (store.docs.length === 0) return void (await ctx.reply("知识库为空，请先 /sync 或 /sync full"));

    const profile = await this.selfStore.getActiveForUser(uid);
    const qa = await this.brain.answer({ userId: uid, question, docs: store.docs, profile, forcePlus });
    await ctx.reply(this.renderHtmlAnswer(qa), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  }

  private renderHtmlAnswer(qa: QAResult): string {
    const lines: string[] = [];
    lines.push("<b>结论</b>");
    lines.push(escapeHtml((qa.conclusion || qa.answer || "").trim()));

    if (qa.confidence) {
      lines.push("");
      lines.push(`<b>置信度</b> ${escapeHtml(qa.confidence)}`);
    }
    if (qa.decisionMode) {
      lines.push(`<b>决策模式</b> ${escapeHtml(qa.decisionMode)}`);
    }

    if (qa.riskBoundary) {
      lines.push("");
      lines.push("<b>风险边界</b>");
      lines.push(escapeHtml(qa.riskBoundary));
    }

    if (qa.nextActions && qa.nextActions.length > 0) {
      lines.push("");
      lines.push("<b>下一步行动建议</b>");
      qa.nextActions.slice(0, 3).forEach((x, i) => lines.push(`${i + 1}. ${escapeHtml(x)}`));
    }

    if (qa.codeBlock) {
      lines.push("");
      lines.push("<b>代码</b>");
      lines.push(`<pre><code>${escapeHtml(qa.codeBlock)}</code></pre>`);
    }

    const cites = qa.citations ?? [];
    if (cites.length > 0) {
      lines.push("");
      lines.push("<b>证据片段</b>");
      cites.slice(0, 3).forEach((c, idx) => {
        lines.push(`${idx + 1}) <a href=\"${c.url}\">${escapeHtml(c.title)}</a>`);
        lines.push(escapeHtml(c.excerpt));
        if (c.highlights.length > 0) lines.push(`高亮词: ${escapeHtml(c.highlights.join(", "))}`);
      });
    } else if (qa.sources.length > 0) {
      lines.push("");
      lines.push("<b>来源</b>");
      qa.sources.slice(0, 3).forEach((s) => lines.push(`- <a href=\"${s.url}\">${escapeHtml(s.title)}</a>`));
    }

    return lines.join("\n");
  }

  private helpText(): string {
    return [
      "命令说明：",
      "/help 查看命令",
      "/ping 健康检查",
      "/ask <问题> 提问（按 LLM_ROUTE 路由）",
      "/ask_plus <问题> 强制走 LLM 混合链路",
      "/feedback <类型>|<纠正内容> 写入纠正反馈",
      "/memory_status 查看记忆摘要",
      "/goal [内容] 设置或查看当前目标",
      "/reembed [数量] 触发真实向量重算",
      "/notion <关键词> 检索 Notion",
      "/sync 增量同步",
      "/sync full 全量同步",
      "/sync_status 查看同步状态",
      "/learn 标题|内容 手工补充知识",
      "/digest 输出知识蒸馏 + 工作体蒸馏",
      "/create_yourself 名字|基本信息|自我画像|说话风格",
      "/list_selves 列出工作体",
      "/use_self <slug> 切换工作体",
      "/show_self [slug] 查看工作体详情",
      "/update_yourself <slug>|增量记忆",
      "/update_persona <slug>|人格规则",
      "/correct_yourself <slug>|纠正说明",
      "/reset_context 记录上下文重置"
    ].join("\n");
  }
}
