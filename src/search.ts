import Fuse from "fuse.js";
import type { NotionDoc } from "./types.js";

export const searchDocs = (docs: NotionDoc[], query: string): NotionDoc[] => {
  const q = query.trim();
  if (!q) {
    return docs;
  }

  const norm = (s: string): string => s.toLowerCase();
  const qNorm = norm(q);

  const fuse = new Fuse(docs, {
    includeScore: true,
    threshold: 0.3,
    minMatchCharLength: 1,
    keys: [
      { name: "title", weight: 0.35 },
      { name: "distilled", weight: 0.2 },
      { name: "contentText", weight: 0.45 },
      { name: "preview", weight: 0.05 },
      { name: "markdown", weight: 0.05 }
    ]
  });
  const fuseResults = fuse.search(q);
  const fuseDocs = fuseResults.map((r) => r.item);

  // 兜底：即便 Fuse 失配，也能通过正文 contains 命中
  const containsDocs = docs.filter((d) => {
    const hay = `${d.title} ${d.distilled} ${d.contentText} ${d.preview} ${d.markdown}`;
    return norm(hay).includes(qNorm);
  });

  // 合并去重，标题命中优先，其次正文命中
  const titleHit = containsDocs.filter((d) => norm(d.title).includes(qNorm));
  const contentHit = containsDocs.filter((d) => !norm(d.title).includes(qNorm));

  const merged = [...titleHit, ...fuseDocs, ...contentHit];
  const uniq = new Map<string, NotionDoc>();
  for (const d of merged) {
    if (!uniq.has(d.id)) {
      uniq.set(d.id, d);
    }
  }
  return [...uniq.values()];
};
