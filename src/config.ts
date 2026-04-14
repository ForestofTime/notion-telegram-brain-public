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
  resultsPerPage: toInt(process.env.RESULTS_PER_PAGE, 5),
  telegramMode: ((process.env.TELEGRAM_MODE ?? "auto").trim().toLowerCase() as
    | "auto"
    | "polling"
    | "sync-only")
};
