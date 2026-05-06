import "dotenv/config";

const must = (value: string | undefined, key: string): string => {
  if (!value || !value.trim()) {
    throw new Error(`缺少环境变量: ${key}`);
  }
  return value.trim();
};

const toInt = (value: string | undefined, fallback: number): number => {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const toFloat = (value: string | undefined, fallback: number): number => {
  const n = Number.parseFloat(value ?? "");
  return Number.isFinite(n) ? n : fallback;
};

const allowedUsers = (process.env.TELEGRAM_ALLOWED_USERS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number.parseInt(s, 10))
  .filter((n) => Number.isFinite(n));

if (allowedUsers.length === 0) {
  throw new Error("TELEGRAM_ALLOWED_USERS 不能为空，至少配置一个 Telegram 用户 ID");
}

export const config = {
  telegramBotToken: must(process.env.TELEGRAM_BOT_TOKEN, "TELEGRAM_BOT_TOKEN"),
  notionToken: must(process.env.NOTION_TOKEN, "NOTION_TOKEN"),
  allowedUsers,
  syncIntervalMinutes: toInt(process.env.SYNC_INTERVAL_MINUTES, 30),
  dataFile: (process.env.DATA_FILE ?? "./data/notion-index.json").trim(),
  sqliteFile: (process.env.SQLITE_FILE ?? "./data/notion-brain.db").trim(),
  resultsPerPage: toInt(process.env.RESULTS_PER_PAGE, 5),
  telegramMode: ((process.env.TELEGRAM_MODE ?? "auto").trim().toLowerCase() as
    | "auto"
    | "polling"
    | "sync-only"),
  llmProvider: ((process.env.LLM_PROVIDER ?? "deepseek").trim().toLowerCase() as "deepseek"),
  deepseekApiKey: process.env.DEEPSEEK_API_KEY?.trim() ?? "",
  deepseekModel: (process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash").trim(),
  llmRoute: ((process.env.LLM_ROUTE ?? "hybrid").trim().toLowerCase() as "legacy" | "hybrid" | "llm_first"),
  llmTimeoutMs: toInt(process.env.LLM_TIMEOUT_MS, 25000),
  llmMaxRetries: toInt(process.env.LLM_MAX_RETRIES, 3),
  llmTemperature: toFloat(process.env.LLM_TEMPERATURE, 0.2),
  retrievalTopN: toInt(process.env.RETRIEVAL_TOP_N, 8)
};
