const DIM = 128;

const normalize = (s: string): string => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

const tokenize = (s: string): string[] => {
  const norm = normalize(s);
  const words = norm.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const han = norm.replace(/[^\p{Script=Han}]/gu, "");
  const bigrams: string[] = [];
  for (let i = 0; i < han.length - 1; i += 1) {
    bigrams.push(han.slice(i, i + 2));
  }
  return [...words, ...bigrams].filter((x) => x.length >= 2);
};

const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0);
};

export const embedText = (text: string): number[] => {
  const vec = new Array<number>(DIM).fill(0);
  const toks = tokenize(text);
  if (toks.length === 0) return vec;

  for (const t of toks) {
    const idx = hash(t) % DIM;
    vec[idx] += 1;
  }

  let l2 = 0;
  for (const v of vec) l2 += v * v;
  l2 = Math.sqrt(l2) || 1;
  return vec.map((v) => v / l2);
};

export const cosine = (a: number[], b: number[]): number => {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i += 1) dot += a[i] * b[i];
  return dot;
};
