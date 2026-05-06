import Database from "better-sqlite3";
import path from "node:path";
import { embedText, cosine } from "./embeddings.js";
import type { EmbeddingProvider } from "./embedding-provider.js";
import type { Citation, NotionDoc } from "./types.js";

export type RetrievedChunk = {
  chunkId: string;
  docId: string;
  title: string;
  url: string;
  content: string;
  score: number;
  source: "bm25" | "vector" | "merged";
};

const normalize = (s: string): string => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

const splitChunks = (text: string, size = 350, overlap = 70): string[] => {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const chunks: string[] = [];
  let i = 0;
  while (i < clean.length) {
    chunks.push(clean.slice(i, i + size));
    if (i + size >= clean.length) break;
    i += size - overlap;
  }
  return chunks.slice(0, 80);
};

export class BrainDB {
  private readonly db: Database.Database;

  constructor(file: string) {
    const abs = path.resolve(file);
    this.db = new Database(abs);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  close(): void {
    this.db.close();
  }

  private init(): void {
    this.db.exec(`
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  last_edited_time TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  content TEXT NOT NULL,
  FOREIGN KEY(doc_id) REFERENCES docs(id)
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(chunk_id, content, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id TEXT PRIMARY KEY,
  vector_json TEXT NOT NULL,
  FOREIGN KEY(chunk_id) REFERENCES chunks(id)
);
CREATE TABLE IF NOT EXISTS chunk_embeddings_v2 (
  chunk_id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  vector_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(chunk_id) REFERENCES chunks(id)
);
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  turn_role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS qa_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  feedback_type TEXT NOT NULL,
  query TEXT NOT NULL,
  correction TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON chunks(doc_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id);
CREATE INDEX IF NOT EXISTS idx_feedback_user_id ON qa_feedback(user_id);
`);
  }

  upsertDocs(docs: NotionDoc[]): void {
    const upDoc = this.db.prepare(
      `INSERT INTO docs (id,title,url,kind,content,last_edited_time)
       VALUES (@id,@title,@url,@kind,@content,@last_edited_time)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title,
         url=excluded.url,
         kind=excluded.kind,
         content=excluded.content,
         last_edited_time=excluded.last_edited_time`
    );
    const delChunks = this.db.prepare("DELETE FROM chunks WHERE doc_id = ?");
    const delFts = this.db.prepare("DELETE FROM chunks_fts WHERE chunk_id = ?");
    const delEmbByChunk = this.db.prepare("DELETE FROM chunk_embeddings WHERE chunk_id = ?");
    const delEmbV2ByChunk = this.db.prepare("DELETE FROM chunk_embeddings_v2 WHERE chunk_id = ?");
    const selectChunkIds = this.db.prepare("SELECT id FROM chunks WHERE doc_id = ?");

    const insChunk = this.db.prepare("INSERT INTO chunks (id,doc_id,ord,content) VALUES (?,?,?,?)");
    const insFts = this.db.prepare("INSERT INTO chunks_fts (chunk_id,content) VALUES (?,?)");
    const insEmb = this.db.prepare(
      "INSERT INTO chunk_embeddings (chunk_id,vector_json) VALUES (?,?) ON CONFLICT(chunk_id) DO UPDATE SET vector_json=excluded.vector_json"
    );

    const tx = this.db.transaction((rows: NotionDoc[]) => {
      for (const d of rows) {
        const content = [d.title, d.distilled, d.contentText, d.preview, d.markdown].filter(Boolean).join("\n");
        upDoc.run({
          id: d.id,
          title: d.title,
          url: d.url,
          kind: d.kind,
          content,
          last_edited_time: d.lastEditedTime
        });

        const oldIds = selectChunkIds.all(d.id) as Array<{ id: string }>;
        for (const r of oldIds) {
          delFts.run(r.id);
          delEmbByChunk.run(r.id);
          delEmbV2ByChunk.run(r.id);
        }
        delChunks.run(d.id);

        const chunks = splitChunks(content);
        chunks.forEach((c, idx) => {
          const cid = `${d.id}#${idx}`;
          insChunk.run(cid, d.id, idx, c);
          insFts.run(cid, c);
          insEmb.run(cid, JSON.stringify(embedText(c)));
        });
      }
    });

    tx(docs);
  }

  async reembedChunks(provider: EmbeddingProvider, limit = 300): Promise<{ scanned: number; updated: number; modelId: string }> {
    const rows = this.db
      .prepare(
        `SELECT c.id as chunk_id, c.content
         FROM chunks c
         LEFT JOIN chunk_embeddings_v2 e ON e.chunk_id = c.id AND e.model_id = ?
         WHERE e.chunk_id IS NULL
         LIMIT ?`
      )
      .all(provider.modelId, limit) as Array<{ chunk_id: string; content: string }>;

    if (rows.length === 0) {
      return { scanned: 0, updated: 0, modelId: provider.modelId };
    }

    const vecs = await provider.embedMany(rows.map((r) => r.content));
    const up = this.db.prepare(
      `INSERT INTO chunk_embeddings_v2 (chunk_id,model_id,vector_json,updated_at)
       VALUES (?,?,?,?)
       ON CONFLICT(chunk_id) DO UPDATE SET
         model_id=excluded.model_id,
         vector_json=excluded.vector_json,
         updated_at=excluded.updated_at`
    );

    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      rows.forEach((r, i) => up.run(r.chunk_id, provider.modelId, JSON.stringify(vecs[i]), now));
    });
    tx();
    return { scanned: rows.length, updated: rows.length, modelId: provider.modelId };
  }

  hybridRetrieveAdvanced(query: string, queryVec: number[] | null, topN = 8): RetrievedChunk[] {
    const q = normalize(query);
    if (!q) return [];

    const bm25Rows = this.db
      .prepare(
        `SELECT c.id as chunk_id, c.doc_id, c.content, d.title, d.url, d.last_edited_time, bm25(chunks_fts) as s
         FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.chunk_id
         JOIN docs d ON d.id = c.doc_id
         WHERE chunks_fts MATCH ?
         ORDER BY s LIMIT 30`
      )
      .all(q.replace(/\s+/g, " OR ")) as Array<{
      chunk_id: string;
      doc_id: string;
      content: string;
      title: string;
      url: string;
      last_edited_time: string;
      s: number;
    }>;

    const embRows = this.db
      .prepare(
        `SELECT e.chunk_id, e.vector_json, c.doc_id, c.content, d.title, d.url, d.last_edited_time
         FROM chunk_embeddings_v2 e
         JOIN chunks c ON c.id = e.chunk_id
         JOIN docs d ON d.id = c.doc_id
         ORDER BY e.updated_at DESC
         LIMIT 5000`
      )
      .all() as Array<{
      chunk_id: string;
      vector_json: string;
      doc_id: string;
      content: string;
      title: string;
      url: string;
      last_edited_time: string;
    }>;

    const qv = queryVec ?? embedText(query);
    const vectorRows = embRows
      .map((r) => ({ ...r, sim: cosine(qv, JSON.parse(r.vector_json) as number[]) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 30);

    const feedback = this.db
      .prepare(`SELECT query, correction FROM qa_feedback ORDER BY id DESC LIMIT 200`)
      .all() as Array<{ query: string; correction: string }>;

    const merged = new Map<string, RetrievedChunk>();
    const addRrf = (id: string, base: Omit<RetrievedChunk, "score" | "source">, rank: number, source: "bm25" | "vector", freshness = 0) => {
      const rrf = 1 / (60 + rank);
      const current = merged.get(id);
      const score = rrf + freshness;
      if (!current) {
        merged.set(id, { ...base, score, source });
      } else {
        current.score += score;
        current.source = "merged";
      }
    };

    const now = Date.now();
    const freshBonus = (iso: string): number => {
      const t = Date.parse(iso);
      if (!Number.isFinite(t)) return 0;
      const days = Math.max(0, (now - t) / 86400000);
      return days <= 7 ? 0.03 : days <= 30 ? 0.015 : 0;
    };

    bm25Rows.forEach((r, i) => addRrf(r.chunk_id, { chunkId: r.chunk_id, docId: r.doc_id, title: r.title, url: r.url, content: r.content }, i + 1, "bm25", freshBonus(r.last_edited_time)));
    vectorRows.forEach((r, i) => addRrf(r.chunk_id, { chunkId: r.chunk_id, docId: r.doc_id, title: r.title, url: r.url, content: r.content }, i + 1, "vector", freshBonus(r.last_edited_time)));

    const qn = normalize(query);
    for (const v of merged.values()) {
      const hn = normalize(`${v.title} ${v.content}`);
      for (const f of feedback) {
        if (!f.query) continue;
        if (qn.includes(normalize(f.query)) && hn.includes(normalize(f.correction).slice(0, 20))) {
          v.score += 0.05;
        }
      }
    }

    return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, topN);
  }

  hybridRetrieve(query: string, topN = 8): RetrievedChunk[] {
    const q = normalize(query);
    if (!q) return [];

    const bm25Rows = this.db
      .prepare(
        `SELECT c.id as chunk_id, c.doc_id, c.content, d.title, d.url, bm25(chunks_fts) as s
         FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.chunk_id
         JOIN docs d ON d.id = c.doc_id
         WHERE chunks_fts MATCH ?
         ORDER BY s LIMIT 20`
      )
      .all(q.replace(/\s+/g, " OR ")) as Array<{
      chunk_id: string;
      doc_id: string;
      content: string;
      title: string;
      url: string;
      s: number;
    }>;

    const qVec = embedText(query);
    const embRows = this.db
      .prepare(
        `SELECT e.chunk_id, e.vector_json, c.doc_id, c.content, d.title, d.url
         FROM chunk_embeddings e
         JOIN chunks c ON c.id = e.chunk_id
         JOIN docs d ON d.id = c.doc_id`
      )
      .all() as Array<{
      chunk_id: string;
      vector_json: string;
      doc_id: string;
      content: string;
      title: string;
      url: string;
    }>;

    const vectorRows = embRows
      .map((r) => ({ ...r, sim: cosine(qVec, JSON.parse(r.vector_json) as number[]) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 20);

    const merged = new Map<string, RetrievedChunk>();
    const addRrf = (id: string, base: Omit<RetrievedChunk, "score" | "source">, rank: number, source: "bm25" | "vector") => {
      const rrf = 1 / (60 + rank);
      const current = merged.get(id);
      if (!current) {
        merged.set(id, { ...base, score: rrf, source });
      } else {
        current.score += rrf;
        current.source = "merged";
      }
    };

    bm25Rows.forEach((r, i) =>
      addRrf(
        r.chunk_id,
        { chunkId: r.chunk_id, docId: r.doc_id, title: r.title, url: r.url, content: r.content },
        i + 1,
        "bm25"
      )
    );

    vectorRows.forEach((r, i) =>
      addRrf(
        r.chunk_id,
        { chunkId: r.chunk_id, docId: r.doc_id, title: r.title, url: r.url, content: r.content },
        i + 1,
        "vector"
      )
    );

    return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, topN);
  }

  addSessionTurn(userId: number, role: "user" | "assistant", content: string): void {
    this.db
      .prepare("INSERT INTO sessions (user_id,turn_role,content,created_at) VALUES (?,?,?,?)")
      .run(userId, role, content, new Date().toISOString());
  }

  getRecentSession(userId: number, limit = 8): Array<{ role: "user" | "assistant"; content: string }> {
    const rows = this.db
      .prepare("SELECT turn_role, content FROM sessions WHERE user_id = ? ORDER BY id DESC LIMIT ?")
      .all(userId, limit) as Array<{ turn_role: "user" | "assistant"; content: string }>;
    return rows.reverse().map((r) => ({ role: r.turn_role, content: r.content }));
  }

  addMemory(userId: number, key: string, value: string, confidence: "high" | "medium" | "low", scope = "long"): void {
    this.db
      .prepare("INSERT INTO memories (user_id,scope,key,value,confidence,created_at) VALUES (?,?,?,?,?,?)")
      .run(userId, scope, key, value, confidence, new Date().toISOString());
  }

  getMemorySummary(userId: number, limit = 10): string {
    const rows = this.db
      .prepare("SELECT key,value,confidence FROM memories WHERE user_id = ? ORDER BY id DESC LIMIT ?")
      .all(userId, limit) as Array<{ key: string; value: string; confidence: string }>;
    if (rows.length === 0) return "暂无长期记忆";
    return rows.map((r) => `- [${r.confidence}] ${r.key}: ${r.value}`).join("\n");
  }


  setGoal(userId: number, goal: string): void {
    this.addMemory(userId, "goal", goal.trim(), "high", "long");
  }

  getGoals(userId: number, limit = 5): string[] {
    const rows = this.db
      .prepare("SELECT value FROM memories WHERE user_id = ? AND key = 'goal' ORDER BY id DESC LIMIT ?")
      .all(userId, limit) as Array<{ value: string }>;
    return rows.map((r) => r.value);
  }

  addFeedback(userId: number, feedbackType: string, query: string, correction: string): void {
    this.db
      .prepare("INSERT INTO qa_feedback (user_id,feedback_type,query,correction,created_at) VALUES (?,?,?,?,?)")
      .run(userId, feedbackType, query, correction, new Date().toISOString());
  }

  getFeedbackHints(userId: number, query: string, limit = 5): string[] {
    const rows = this.db
      .prepare(
        "SELECT correction FROM qa_feedback WHERE user_id = ? AND (query LIKE ? OR correction LIKE ?) ORDER BY id DESC LIMIT ?"
      )
      .all(userId, `%${query}%`, `%${query}%`, limit) as Array<{ correction: string }>;
    return rows.map((r) => r.correction);
  }

  toCitations(chunks: RetrievedChunk[], query: string): Citation[] {
    const toks = normalize(query).split(/\s+/).filter(Boolean).slice(0, 8);
    return chunks.map((c) => {
      const highlights = toks.filter((t) => normalize(c.content).includes(t));
      return {
        title: c.title,
        url: c.url,
        excerpt: c.content.slice(0, 260),
        highlights
      };
    });
  }
}
