import { promises as fs } from "node:fs";
import path from "node:path";
import type { IndexStore, NotionDoc } from "./types.js";

const emptyStore = (): IndexStore => ({
  lastSyncAt: null,
  docs: []
});

export class JsonStore {
  private readonly absPath: string;

  constructor(filePath: string) {
    this.absPath = path.resolve(filePath);
  }

  async read(): Promise<IndexStore> {
    try {
      const raw = await fs.readFile(this.absPath, "utf8");
      const parsed = JSON.parse(raw) as IndexStore;
      const docs = Array.isArray(parsed.docs)
        ? parsed.docs.map((d: any) => ({
            ...d,
            markdown: typeof d?.markdown === "string" ? d.markdown : "",
            contentText: typeof d?.contentText === "string" ? d.contentText : "",
            distilled: typeof d?.distilled === "string" ? d.distilled : "",
            preview: typeof d?.preview === "string" ? d.preview : ""
          }))
        : [];
      return {
        lastSyncAt: parsed.lastSyncAt ?? null,
        docs
      };
    } catch {
      await this.write(emptyStore());
      return emptyStore();
    }
  }

  async write(store: IndexStore): Promise<void> {
    await fs.mkdir(path.dirname(this.absPath), { recursive: true });
    await fs.writeFile(this.absPath, JSON.stringify(store, null, 2), "utf8");
  }

  async upsertDocs(docs: NotionDoc[], lastSyncAt: string): Promise<IndexStore> {
    const current = await this.read();
    const map = new Map<string, NotionDoc>(current.docs.map((d) => [d.id, d]));

    for (const doc of docs) {
      map.set(doc.id, doc);
    }

    const merged: IndexStore = {
      lastSyncAt,
      docs: [...map.values()].sort((a, b) => {
        return b.lastEditedTime.localeCompare(a.lastEditedTime);
      })
    };

    await this.write(merged);
    return merged;
  }
}
