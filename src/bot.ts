import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Markup, Telegraf } from "telegraf";
import type { Context } from "telegraf";
import { config } from "./config.js";
import { answerWithKnowledge, buildDigestMarkdown, type QAResult } from "./qa.js";
import { searchDocs } from "./search.js";
import type { JsonStore } from "./store.js";
import type { NotionSyncService } from "./notion-sync.js";
import type { NotionDoc } from "./types.js";
import { humanizeAnswerWithProfile, SelfStore } from "./self-store.js";

type Session = {
  id: string;
  query: string;
  page: number;
  resultIds: string[];
  createdAt: number;
};

type AskTurn = {
  q: string;
  a: string;
  ts: number;
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
  { command: "help", description: "查看全部命令说明" },
  { command: "ping", description: "健康检查" },
  { command: "ask", description: "提问业务问题" },
  { command: "notion", description: "关键词检索 Notion" },
  { command: "sync", description: "执行增量同步（可加 full 全量）" },
  { command: "sync_status", description: "查看同步状态" },
  { command: "create_yourself", description: "创建数字工作体" },
  { command: "list_selves", description: "列出所有工作体" },
  { command: "use_self", description: "切换当前工作体" },
  { command: "show_self", description: "查看工作体详情" },
  { command: "update_yourself", description: "追加工作体记忆" },
  { command: "update_persona", description: "追加人格规则" },
  { command: "correct_yourself", description: "写入纠正并立即生效" },
  { command: "learn", description: "手工补充知识" },
  { command: "digest", description: "输出知识蒸馏文档" },
  { command: "reset_context", description: "清空追问上下文" }
];

const escapeHtml = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}...` : s);

const isAllowed = (ctx: Context): boolean => {
  const uid = ctx.from?.id;
  return typeof uid === "number" && config.allowedUsers.includes(uid);
};

const parseQuery = (text: string | undefined): string => {
  if (!text) return "";
  return text.replace(/^\/notion(?:@\w+)?\s*/i, "").trim();
};

const parseSync = (text: string | undefined): { forceFull: boolean } => {
  const t = text ?? "";
  return { forceFull: /all|full|force|全量/i.test(t) };
};

const parseAsk = (text: string | undefined): string => {
  if (!text) return "";
  return text.replace(/^\/ask(?:@\w+)?\s*/i, "").trim();
};

const parseLearn = (text: string | undefined): { title: string; body: string } => {
  const raw = (text ?? "").replace(/^\/learn(?:@\w+)?\s*/i, "").trim();
  if (!raw) return { title: "", body: "" };
  const parts = raw.split("|");
  if (parts.length === 1) {
    return { title: `手工知识 ${new Date().toISOString()}`, body: parts[0].trim() };
  }
  const title = parts[0].trim() || `手工知识 ${new Date().toISOString()}`;
  const body = parts.slice(1).join("|").trim();
  return { title, body };
};

const parseCreateYourself = (
  text: string | undefined
): { name: string; basicInfo: string; selfPortrait: string; styleHint: string } => {
  const raw = (text ?? "").replace(/^\/create_yourself(?:@\w+)?\s*/i, "").trim();
  if (!raw) return { name: "", basicInfo: "", selfPortrait: "", styleHint: "" };
  const [name = "", basicInfo = "", selfPortrait = "", styleHint = ""] = raw.split("|").map((x) => x.trim());
  return { name, basicInfo, selfPortrait, styleHint };
};

const parseTail = (text: string | undefined, command: string): string => {
  if (!text) return "";
  const re = new RegExp(`^\\/${command}(?:@\\w+)?\\s*`, "i");
  return text.replace(re, "").trim();
};

const parseSlugAndContent = (
  text: string | undefined,
  command: string
): { slug: string; content: string } => {
  const raw = parseTail(text, command);
  if (!raw) return { slug: "", content: "" };
  const [slug = "", ...rest] = raw.split("|");
  return { slug: slug.trim(), content: rest.join("|").trim() };
};

const shouldUseContext = (question: string): boolean => {
  const q = question.trim();
  if (!q) return false;
  return /^(那|这个|这个问题|这个规则|那这个|那么|然后|再|继续|补充|它|该单据|该规则)/.test(q);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const execFileAsync = promisify(execFile);

const isTransientNetworkError = (err: unknown): boolean => {
  const msg = ((err as Error)?.message ?? "").toLowerCase();
  return (
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("enotfound") ||
    msg.includes("client network socket disconnected") ||
    msg.includes("tls connection was established")
  );
};

const toPlainText = (s: string): string =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/```[\s\S]*?```/g, "[代码块已省略，请重试该问题获取代码]")
    .replace(/\[[^\]]+\]\(([^)]+)\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export class NotionTelegramBot {
  private readonly bot: Telegraf;
  private readonly store: JsonStore;
  private readonly syncService: NotionSyncService;
  private readonly sessions = new Map<string, Session>();
  private readonly askMemories = new Map<number, AskTurn[]>();
  private readonly selfStore = new SelfStore();
  private syncState: SyncState = { running: false, forceFull: false };

  constructor(store: JsonStore, syncService: NotionSyncService) {
    this.bot = new Telegraf(config.telegramBotToken);
    this.store = store;
    this.syncService = syncService;
    this.attachTelegramApiRetry();
    this.registerHandlers();
    this.bot.catch((err) => {
      console.error("[bot] update 处理异常:", err);
    });
  }

  async launch(): Promise<void> {
    try {
      await this.bot.telegram.setMyCommands(BOT_COMMANDS);
    } catch (err) {
      console.warn("[bot] 设置命令菜单失败:", (err as Error).message);
    }
    await this.bot.launch();
  }

  async stop(signal = "SIGTERM"): Promise<void> {
    this.bot.stop(signal);
  }

  private registerHandlers(): void {
    this.bot.use(async (ctx, next) => {
      const originalReply = (ctx.reply as any)?.bind(ctx);
      if (typeof originalReply === "function") {
        (ctx as any).reply = async (...args: any[]) => {
          try {
            return await originalReply(...args);
          } catch (err) {
            const text = args[0];
            const extra = args[1] ?? {};
            if (typeof text === "string" && typeof ctx.chat?.id === "number") {
              console.warn("[bot] ctx.reply 失败，走 curl 兜底发送");
              try {
                return await this.sendMessageByCurl({
                  chat_id: ctx.chat.id,
                  text,
                  parse_mode: extra?.parse_mode,
                  disable_web_page_preview: extra?.link_preview_options?.is_disabled ?? true
                });
              } catch (fallbackErr) {
                console.warn("[bot] ctx.reply 兜底格式发送失败，降级纯文本发送");
                return await this.sendMessageByCurl({
                  chat_id: ctx.chat.id,
                  text: toPlainText(text),
                  disable_web_page_preview: true
                });
              }
            }
            throw err;
          }
        };
      }

      const text = "text" in (ctx.message ?? {}) ? (ctx.message as any).text : "";
      if (typeof text === "string" && text.startsWith("/")) {
        console.log(`[bot] recv command uid=${ctx.from?.id ?? "unknown"} cmd=${text.split(/\s+/)[0]}`);
      }
      if (!isAllowed(ctx)) {
        if (ctx.chat?.type === "private") {
          await ctx.reply("无权限使用此机器人。");
        }
        return;
      }
      await next();
    });

    this.bot.start(async (ctx) => {
      await ctx.reply(
        [
          "Notion 第二大脑机器人已启动。",
          "请输入 /help 查看完整命令说明。"
        ].join("\n")
      );
    });

    this.bot.command("help", async (ctx) => {
      await ctx.reply(this.helpText());
    });

    this.bot.command("ping", async (ctx) => {
      const uptimeSec = Math.floor(process.uptime());
      await ctx.reply(`pong\n状态: online\n运行时长: ${uptimeSec}s`);
    });

    this.bot.command("create_yourself", async (ctx) => {
      const uid = ctx.from?.id;
      if (typeof uid !== "number") {
        await ctx.reply("无法识别用户。");
        return;
      }
      const args = parseCreateYourself(ctx.message?.text);
      if (!args.name) {
        await ctx.reply("用法: /create_yourself 名字|基本信息|自我画像|说话风格");
        return;
      }
      const profile = await this.selfStore.createProfile(args);
      await this.selfStore.setActiveForUser(uid, profile.slug);
      await ctx.reply(
        [
          `已创建数字工作体：${profile.name}`,
          `slug: ${profile.slug}`,
          `版本: v${profile.version}`,
          "已自动设为当前会话人格。"
        ].join("\n")
      );
    });

    this.bot.command("list_selves", async (ctx) => {
      const list = await this.selfStore.listProfiles();
      if (list.length === 0) {
        await ctx.reply("还没有人格档案。先用 /create_yourself 创建。");
        return;
      }
      await ctx.reply(
        ["已创建的人格档案：", ...list.slice(0, 20).map((p, i) => `${i + 1}. ${p.name} (${p.slug}) v${p.version}`)].join("\n")
      );
    });

    this.bot.command("use_self", async (ctx) => {
      const uid = ctx.from?.id;
      if (typeof uid !== "number") {
        await ctx.reply("无法识别用户。");
        return;
      }
      const slug = parseTail(ctx.message?.text, "use_self");
      if (!slug) {
        await ctx.reply("用法: /use_self <slug>");
        return;
      }
      const ok = await this.selfStore.setActiveForUser(uid, slug);
      if (!ok) {
        await ctx.reply(`未找到 slug=${slug}，先用 /list_selves 查看。`);
        return;
      }
      await ctx.reply(`已切换当前人格为 ${slug}`);
    });

    this.bot.command("show_self", async (ctx) => {
      const uid = ctx.from?.id;
      if (typeof uid !== "number") {
        await ctx.reply("无法识别用户。");
        return;
      }
      const slug = parseTail(ctx.message?.text, "show_self");
      const profile = slug ? await this.selfStore.getProfile(slug) : await this.selfStore.getActiveForUser(uid);
      if (!profile) {
        await ctx.reply("未找到档案。用 /list_selves 查看可用项。");
        return;
      }
      await ctx.reply(
        [
          `名称: ${profile.name}`,
          `slug: ${profile.slug}`,
          `版本: v${profile.version}`,
          `基本信息: ${profile.basicInfo || "未填写"}`,
          `自我画像: ${profile.selfPortrait || "未填写"}`,
          `风格提示: ${profile.styleHint || "未填写"}`,
          `记忆条目: ${profile.selfMemory.length}`,
          `人格规则: ${profile.personaRules.length}`,
          `纠正记录: ${profile.corrections.length}`
        ].join("\n")
      );
    });

    this.bot.command("update_yourself", async (ctx) => {
      const { slug, content } = parseSlugAndContent(ctx.message?.text, "update_yourself");
      if (!slug || !content) {
        await ctx.reply("用法: /update_yourself <slug>|增量记忆");
        return;
      }
      const updated = await this.selfStore.appendSelfMemory(slug, content);
      if (!updated) {
        await ctx.reply(`未找到 slug=${slug}`);
        return;
      }
      await ctx.reply(`已更新 Self Memory: ${slug} (v${updated.version})`);
    });

    this.bot.command("update_persona", async (ctx) => {
      const { slug, content } = parseSlugAndContent(ctx.message?.text, "update_persona");
      if (!slug || !content) {
        await ctx.reply("用法: /update_persona <slug>|人格规则");
        return;
      }
      const updated = await this.selfStore.appendPersonaRule(slug, content);
      if (!updated) {
        await ctx.reply(`未找到 slug=${slug}`);
        return;
      }
      await ctx.reply(`已更新 Persona: ${slug} (v${updated.version})`);
    });

    this.bot.command("correct_yourself", async (ctx) => {
      const { slug, content } = parseSlugAndContent(ctx.message?.text, "correct_yourself");
      if (!slug || !content) {
        await ctx.reply("用法: /correct_yourself <slug>|纠正说明");
        return;
      }
      const updated = await this.selfStore.appendCorrection(slug, content);
      if (!updated) {
        await ctx.reply(`未找到 slug=${slug}`);
        return;
      }
      await ctx.reply(`纠正已记录并生效: ${slug} (v${updated.version})`);
    });

    this.bot.command("sync", async (ctx) => {
      const { forceFull } = parseSync(ctx.message?.text);
      if (this.syncState.running) {
        await ctx.reply(
          `已有同步任务在运行中\n开始时间: ${this.syncState.startedAt}\n模式: ${
            this.syncState.forceFull ? "full" : "incremental"
          }\n可用 /sync_status 查看状态`
        );
        return;
      }

      this.syncState = {
        running: true,
        forceFull,
        startedAt: new Date().toISOString()
      };
      await ctx.reply(forceFull ? "开始全量同步（后台执行）" : "开始增量同步（后台执行）");

      void (async () => {
        try {
          const result = await this.syncService.sync({ forceFull });
          this.syncState = {
            running: false,
            forceFull,
            startedAt: this.syncState.startedAt,
            finishedAt: result.lastSyncAt,
            scanned: result.scanned,
            indexed: result.indexed
          };
          await ctx.reply(
            `同步完成\n扫描: ${result.scanned}\n索引总量: ${result.indexed}\n时间: ${result.lastSyncAt}`
          );
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
      })();
    });

    this.bot.command("sync_status", async (ctx) => {
      if (this.syncState.running) {
        await ctx.reply(
          `同步状态: 运行中\n开始时间: ${this.syncState.startedAt}\n模式: ${
            this.syncState.forceFull ? "full" : "incremental"
          }`
        );
        return;
      }
      if (this.syncState.finishedAt) {
        const statusLine = this.syncState.error ? `结果: 失败\n原因: ${this.syncState.error}` : "结果: 成功";
        await ctx.reply(
          `同步状态: 空闲\n上次结束: ${this.syncState.finishedAt}\n模式: ${
            this.syncState.forceFull ? "full" : "incremental"
          }\n${statusLine}\n扫描: ${this.syncState.scanned ?? 0}\n索引总量: ${this.syncState.indexed ?? 0}`
        );
        return;
      }
      await ctx.reply("尚未执行过同步任务。");
    });

    this.bot.command("notion", async (ctx) => {
      const query = parseQuery(ctx.message?.text);
      if (!query) {
        await ctx.reply("用法: /notion <关键词>");
        return;
      }

      const index = await this.store.read();
      if (index.docs.length === 0) {
        await ctx.reply("本地索引为空，请先执行 /sync");
        return;
      }

      const results = searchDocs(index.docs, query);
      if (results.length === 0) {
        await ctx.reply(`未找到与“${query}”相关的内容。`);
        return;
      }

      const session: Session = {
        id: randomUUID().slice(0, 8),
        query,
        page: 0,
        resultIds: results.map((d) => d.id),
        createdAt: Date.now()
      };
      this.sessions.set(session.id, session);
      this.gcSessions();

      await this.replySearchPage(ctx, session);
    });

    this.bot.command("ask", async (ctx) => {
      const question = parseAsk(ctx.message?.text);
      if (!question) {
        await ctx.reply("用法: /ask 你的工作问题");
        return;
      }
      await this.handleAsk(ctx, question);
    });

    this.bot.hears(/^\/发送ask(?:\s+([\s\S]+))?$/i, async (ctx) => {
      const m = (ctx as unknown as { match?: RegExpMatchArray }).match;
      const question = (m?.[1] ?? "").trim();
      if (!question) {
        await ctx.reply("用法: /发送ask 你的问题（或直接用 /ask）");
        return;
      }
      await this.handleAsk(ctx, question);
    });

    this.bot.command("reset_context", async (ctx) => {
      const uid = ctx.from?.id;
      if (typeof uid !== "number") {
        await ctx.reply("无法识别用户。");
        return;
      }
      this.askMemories.delete(uid);
      await ctx.reply("追问上下文已清空。");
    });

    this.bot.command("learn", async (ctx) => {
      const { title, body } = parseLearn(ctx.message?.text);
      if (!body) {
        await ctx.reply("用法: /learn 标题 | 内容");
        return;
      }

      const now = new Date().toISOString();
      const store = await this.store.read();
      const doc: NotionDoc = {
        id: `manual-${Date.now()}`,
        title,
        url: "local://manual",
        lastEditedTime: now,
        createdTime: now,
        kind: "page",
        parentType: "manual",
        markdown: body,
        contentText: body,
        distilled: `${title}：${body}`.slice(0, 500),
        preview: body.slice(0, 240)
      };
      await this.store.upsertDocs([doc], now);
      await ctx.reply(`已写入知识：${title}`);
    });

    this.bot.command("digest", async (ctx) => {
      const store = await this.store.read();
      if (store.docs.length === 0) {
        await ctx.reply("知识库为空，请先 /sync");
        return;
      }
      const md = buildDigestMarkdown(store.docs);
      const digestPath = path.resolve("./data/knowledge-digest.md");
      await fs.mkdir(path.dirname(digestPath), { recursive: true });
      await fs.writeFile(digestPath, md, "utf8");
      await ctx.reply(`蒸馏完成，已输出：${digestPath}`);
    });

    this.bot.on("callback_query", async (ctx) => {
      const data = "data" in ctx.callbackQuery ? ctx.callbackQuery.data : "";
      if (typeof data !== "string") {
        await ctx.answerCbQuery();
        return;
      }

      const parts = data.split(":");
      if (parts.length !== 3) {
        await ctx.answerCbQuery();
        return;
      }

      const [action, sid, arg] = parts;
      const session = this.sessions.get(sid);
      if (!session) {
        await ctx.answerCbQuery("会话已过期，请重新搜索");
        return;
      }

      if (action === "view") {
        const index = Number.parseInt(arg, 10);
        if (!Number.isFinite(index)) {
          await ctx.answerCbQuery();
          return;
        }

        const store = await this.store.read();
        const id = session.resultIds[index];
        const doc = store.docs.find((d) => d.id === id);
        if (!doc) {
          await ctx.answerCbQuery("结果不存在");
          return;
        }

        const lines = [
          `<b>${escapeHtml(doc.title)}</b>`,
          `类型: ${doc.kind}`,
          `更新时间: ${escapeHtml(doc.lastEditedTime)}`,
          "",
          escapeHtml(truncate(doc.preview || doc.markdown || "无预览内容", 400)),
          "",
          `<a href=\"${doc.url}\">打开 Notion 原文</a>`
        ];

        await ctx.reply(lines.join("\n"), {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true }
        });

        await ctx.answerCbQuery("已发送详情");
        return;
      }

      if (action === "page") {
        const nextPage = Number.parseInt(arg, 10);
        if (!Number.isFinite(nextPage)) {
          await ctx.answerCbQuery();
          return;
        }
        session.page = nextPage;
        await this.editSearchPage(ctx, session);
        await ctx.answerCbQuery();
        return;
      }

      await ctx.answerCbQuery();
    });
  }

  private async replySearchPage(ctx: Context, session: Session): Promise<void> {
    const { text, keyboard } = await this.buildPageView(session);
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: keyboard.reply_markup,
      link_preview_options: { is_disabled: true }
    });
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
    const docs = session.resultIds
      .map((id) => store.docs.find((d) => d.id === id))
      .filter((d): d is NonNullable<typeof d> => Boolean(d));

    const pageSize = config.resultsPerPage;
    const totalPages = Math.max(1, Math.ceil(docs.length / pageSize));
    if (session.page < 0) session.page = 0;
    if (session.page >= totalPages) session.page = totalPages - 1;

    const start = session.page * pageSize;
    const pageDocs = docs.slice(start, start + pageSize);

    const lines = [
      `<b>检索:</b> ${escapeHtml(session.query)}`,
      `<b>结果:</b> ${docs.length} 条，当前第 ${session.page + 1}/${totalPages} 页`,
      ""
    ];

    pageDocs.forEach((doc, i) => {
      lines.push(`${start + i + 1}. ${escapeHtml(doc.title)} (${doc.kind})`);
    });

    const buttons = pageDocs.map((doc, i) => {
      const globalIndex = start + i;
      return [Markup.button.callback(`查看 ${start + i + 1}. ${truncate(doc.title, 18)}`, `view:${session.id}:${globalIndex}`)];
    });

    const nav: ReturnType<typeof Markup.button.callback>[] = [];
    if (session.page > 0) nav.push(Markup.button.callback("上一页", `page:${session.id}:${session.page - 1}`));
    if (session.page < totalPages - 1) nav.push(Markup.button.callback("下一页", `page:${session.id}:${session.page + 1}`));
    if (nav.length) buttons.push(nav);

    return {
      text: lines.join("\n"),
      keyboard: Markup.inlineKeyboard(buttons)
    };
  }

  private gcSessions(): void {
    const now = Date.now();
    for (const [sid, s] of this.sessions.entries()) {
      if (now - s.createdAt > SESSION_TTL_MS) {
        this.sessions.delete(sid);
      }
    }
  }

  private clipMessage(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen - 20)}\n\n[内容过长已截断]`;
  }

  private async handleAsk(ctx: Context, question: string): Promise<void> {
    const uid = ctx.from?.id;
    if (typeof uid !== "number") {
      await ctx.reply("无法识别用户。");
      return;
    }
    const store = await this.store.read();
    if (store.docs.length === 0) {
      await ctx.reply("知识库为空，请先 /sync 或 /sync full");
      return;
    }

    const history = this.askMemories.get(uid) ?? [];
    const recentQ = history.slice(-2).map((t) => t.q);
    const effectiveQuestion =
      shouldUseContext(question) && recentQ.length > 0 ? `${recentQ.join(" ; ")} ; ${question}` : question;

    const qa = answerWithKnowledge(effectiveQuestion, store.docs);
    const profile = await this.selfStore.getActiveForUser(uid);
    const rendered = qa.codeBlock ? this.renderHtmlAnswer(qa, null) : this.renderHtmlAnswer(qa, profile);
    const finalAnswer = this.clipMessage(rendered, 3800);
    await ctx.reply(finalAnswer, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });

    const next = [...history, { q: question, a: qa.answer, ts: Date.now() }];
    this.askMemories.set(uid, next.slice(-8));
  }

  private helpText(): string {
    return [
      "命令说明：",
      "/help 查看命令说明",
      "/ping 健康检查，确认机器人在线",
      "/ask <问题> 直接提问业务问题",
      "/notion <关键词> 检索 Notion 页面内容",
      "/sync 执行增量同步",
      "/sync full 执行全量同步",
      "/sync_status 查看同步任务状态",
      "/learn 标题 | 内容 手工写入知识",
      "/digest 生成知识蒸馏文档",
      "/reset_context 清空追问上下文",
      "/create_yourself 名字|基本信息|自我画像|说话风格 创建工作体",
      "/list_selves 列出工作体",
      "/use_self <slug> 切换当前工作体",
      "/show_self [slug] 查看工作体详情",
      "/update_yourself <slug>|增量记忆 更新 Self Memory",
      "/update_persona <slug>|人格规则 更新 Persona",
      "/correct_yourself <slug>|纠正说明 记录纠正并生效"
    ].join("\n");
  }

  private renderHtmlAnswer(qa: QAResult, profile: Awaited<ReturnType<SelfStore["getActiveForUser"]>>): string {
    const baseConclusion = profile ? humanizeAnswerWithProfile(qa.answer, profile).split("\n")[0] : `结论：${qa.conclusion}`;
    const lines: string[] = [];
    lines.push("<b>结论</b>");
    lines.push(escapeHtml(baseConclusion.replace(/^先说重点，?/, "").replace(/^结论：/, "").trim()));

    if (qa.supplement) {
      lines.push("");
      lines.push("<b>补充</b>");
      lines.push(escapeHtml(qa.supplement));
    }

    if (qa.codeBlock) {
      lines.push("");
      lines.push("<b>代码</b>");
      lines.push(`<pre><code>${escapeHtml(qa.codeBlock)}</code></pre>`);
    }

    if (qa.sources.length > 0) {
      lines.push("");
      lines.push("<b>来源</b>");
      for (const s of qa.sources.slice(0, 2)) {
        lines.push(`- <a href="${s.url}">${escapeHtml(s.title)}</a>`);
      }
    }

    return lines.join("\n");
  }

  private attachTelegramApiRetry(): void {
    const telegramAny = this.bot.telegram as any;
    const origin = telegramAny.callApi.bind(telegramAny);
    telegramAny.callApi = async (method: any, payload: any, options?: any): Promise<any> => {
      const maxAttempts = 5;
      for (let i = 1; i <= maxAttempts; i += 1) {
        try {
          return await origin(method, payload, options);
        } catch (err) {
          if (!isTransientNetworkError(err) || i === maxAttempts) {
            if (method === "sendMessage") {
              try {
                const res = await this.sendMessageByCurl(payload);
                console.warn("[bot] sendMessage 走 curl 兜底成功");
                return res;
              } catch (fallbackErr) {
                console.error("[bot] sendMessage curl 兜底失败:", (fallbackErr as Error).message);
              }
            }
            throw err;
          }
          const delay = 500 * 2 ** (i - 1);
          console.warn(`[bot] callApi ${method} 失败，第 ${i}/${maxAttempts} 次重试，${delay}ms 后重试`);
          await sleep(delay);
        }
      }
      throw new Error(`callApi ${method} failed`);
    };
  }

  private async sendMessageByCurl(payload: any): Promise<any> {
    const endpoint = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
    const body = JSON.stringify(payload ?? {});
    const { stdout } = await execFileAsync("curl", [
      "-sS",
      "--connect-timeout",
      "8",
      "--max-time",
      "15",
      "-H",
      "Content-Type: application/json",
      "-X",
      "POST",
      "-d",
      body,
      endpoint
    ]);
    const parsed = JSON.parse(stdout || "{}");
    if (!parsed?.ok) {
      throw new Error(`curl sendMessage failed: ${parsed?.description ?? "unknown"}`);
    }
    return parsed.result;
  }
}
