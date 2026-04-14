import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import type { JsonStore } from "./store.js";
import type { NotionDoc } from "./types.js";

type SyncOptions = {
  forceFull?: boolean;
};

export class NotionSyncService {
  private readonly notion: Client;
  private readonly n2m: NotionToMarkdown;
  private readonly store: JsonStore;

  constructor(notionToken: string, store: JsonStore) {
    this.notion = new Client({ auth: notionToken });
    this.n2m = new NotionToMarkdown({ notionClient: this.notion });
    this.store = store;
  }

  async sync(options: SyncOptions = {}): Promise<{ scanned: number; indexed: number; lastSyncAt: string }> {
    const current = await this.store.read();
    const lastSyncAt = options.forceFull ? null : current.lastSyncAt;

    let hasMore = true;
    let nextCursor: string | undefined;
    let scanned = 0;
    const docs: NotionDoc[] = [];

    while (hasMore) {
      const result = await this.withRetry("notion.search", async () =>
        this.notion.search({
          sort: {
            direction: "descending",
            timestamp: "last_edited_time"
          },
          start_cursor: nextCursor,
          page_size: 100
        })
      );

      for (const item of result.results) {
        if (item.object !== "page" && item.object !== "database") {
          continue;
        }
        if (!("last_edited_time" in item)) {
          continue;
        }

        scanned += 1;

        const edited = item.last_edited_time;
        if (lastSyncAt && edited <= lastSyncAt) {
          hasMore = false;
          break;
        }

        const doc = await this.toDoc(item);
        docs.push(doc);
      }

      hasMore = hasMore && result.has_more;
      nextCursor = result.next_cursor ?? undefined;
    }

    const syncedAt = new Date().toISOString();
    const merged = await this.store.upsertDocs(docs, syncedAt);
    return { scanned, indexed: merged.docs.length, lastSyncAt: syncedAt };
  }

  private async toDoc(item: any): Promise<NotionDoc> {
    const kind = item.object as "page" | "database";
    const title = this.extractTitle(item);
    const url = item.url ?? "";

    let markdown = "";
    let contentText = "";
    let distilled = "";
    if (kind === "page") {
      markdown = await this.safePageMarkdown(item.id);
      contentText = await this.safePagePlainText(item.id);
      distilled = this.distillText(title, contentText || markdown);
    }

    return {
      id: item.id,
      title,
      url,
      lastEditedTime: item.last_edited_time,
      createdTime: item.created_time,
      kind,
      parentType: item.parent?.type,
      markdown,
      contentText,
      distilled,
      preview: this.makePreview(contentText || markdown)
    };
  }

  private extractTitle(item: any): string {
    if (item.object === "page") {
      const titleProp = Object.values(item.properties ?? {}).find(
        (p: any) => p?.type === "title" && Array.isArray(p?.title)
      ) as any;
      const plain = (titleProp?.title ?? []).map((t: any) => t?.plain_text ?? "").join("").trim();
      return plain || "Untitled";
    }

    const dbTitle = (item.title ?? []).map((t: any) => t?.plain_text ?? "").join("").trim();
    return dbTitle || "Untitled Database";
  }

  private async safePageMarkdown(pageId: string): Promise<string> {
    try {
      const mdBlocks = await this.withRetry("n2m.pageToMarkdown", async () => this.n2m.pageToMarkdown(pageId));
      const md = this.n2m.toMarkdownString(mdBlocks).parent;
      return typeof md === "string" ? md : "";
    } catch {
      return "";
    }
  }

  private async safePagePlainText(pageId: string): Promise<string> {
    try {
      const parts: string[] = [];
      await this.walkBlocksToPlainText(pageId, parts, 0);
      return parts.join(" ").replace(/\s+/g, " ").trim();
    } catch {
      return "";
    }
  }

  private async walkBlocksToPlainText(blockId: string, parts: string[], depth: number): Promise<void> {
    // 防止极深递归导致同步卡死
    if (depth > 8 || parts.length > 3000) {
      return;
    }

    let hasMore = true;
    let cursor: string | undefined;
    while (hasMore) {
      const resp = await this.withRetry("notion.blocks.children.list", async () =>
        this.notion.blocks.children.list({
          block_id: blockId,
          start_cursor: cursor,
          page_size: 100
        })
      );

      for (const block of resp.results) {
        const b = block as any;
        const type = b.type;
        const container = type ? b[type] : null;
        const richTexts = Array.isArray(container?.rich_text) ? container.rich_text : [];
        if (richTexts.length > 0) {
          const text = richTexts.map((t: any) => t.plain_text ?? "").join("").trim();
          if (text) {
            parts.push(text);
          }
        }

        if (b.has_children && b.id) {
          await this.walkBlocksToPlainText(b.id, parts, depth + 1);
        }
      }

      hasMore = resp.has_more;
      cursor = resp.next_cursor ?? undefined;
    }
  }

  private makePreview(text: string): string {
    const cleaned = text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/[#>*_`\-\[\]()]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return cleaned.slice(0, 240);
  }

  private distillText(title: string, text: string): string {
    const cleaned = text.replace(/\s+/g, " ").trim();
    if (!cleaned) return "";

    // 轻量蒸馏：标题 + 前 2 段关键信息，避免超长上下文污染检索
    const sentences = cleaned
      .split(/(?<=[。！？.!?；;])\s+|\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const top = sentences.slice(0, 4).join(" ");
    return `${title}：${top}`.slice(0, 500);
  }

  private async withRetry<T>(label: string, fn: () => Promise<T>, maxAttempts = 5): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const retriable = this.isRetriable(err);
        if (!retriable || attempt >= maxAttempts) {
          throw err;
        }
        const sleepMs = this.backoffMs(attempt);
        console.warn(`[retry] ${label} attempt ${attempt} failed, retry in ${sleepMs}ms: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, sleepMs));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
  }

  private isRetriable(err: unknown): boolean {
    const msg = ((err as Error)?.message ?? "").toLowerCase();
    if (
      msg.includes("client network socket disconnected before secure tls connection was established") ||
      msg.includes("econnreset") ||
      msg.includes("etimedout") ||
      msg.includes("eai_again") ||
      msg.includes("fetch failed") ||
      msg.includes("network socket") ||
      msg.includes("socket hang up")
    ) {
      return true;
    }
    const status = (err as any)?.status ?? (err as any)?.response?.status;
    if (typeof status === "number" && (status === 429 || status >= 500)) {
      return true;
    }
    return false;
  }

  private backoffMs(attempt: number): number {
    const base = 400 * 2 ** (attempt - 1);
    const jitter = Math.floor(Math.random() * 200);
    return Math.min(5000, base + jitter);
  }
}
