import { config } from "./config.js";
import { NotionSyncService } from "./notion-sync.js";
import { NotionTelegramBot } from "./bot.js";
import { JsonStore } from "./store.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isTelegramTransientError = (err: unknown): boolean => {
  const msg = ((err as Error)?.message ?? "").toLowerCase();
  return (
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("enotfound") ||
    msg.includes("tls connection was established") ||
    msg.includes("client network socket disconnected")
  );
};

const launchBotWithRetry = async (bot: NotionTelegramBot, maxAttempts = 8): Promise<void> => {
  for (let i = 1; i <= maxAttempts; i += 1) {
    try {
      await bot.launch();
      return;
    } catch (err) {
      if (!isTelegramTransientError(err) || i === maxAttempts) {
        throw err;
      }
      const delay = Math.min(20_000, 1000 * 2 ** (i - 1));
      console.warn(`[bot] 启动失败（网络抖动），第 ${i}/${maxAttempts} 次重试，${delay}ms 后重试`);
      await sleep(delay);
    }
  }
};

const main = async (): Promise<void> => {
  const store = new JsonStore(config.dataFile);
  const syncService = new NotionSyncService(config.notionToken, store);
  const bot = new NotionTelegramBot(store, syncService);
  let botRunning = false;

  if (config.telegramMode === "sync-only") {
    console.log("[bot] TELEGRAM_MODE=sync-only，跳过 Telegram 轮询，仅运行同步任务");
  } else {
    let attempt = 0;
    while (!botRunning) {
      attempt += 1;
      try {
        await launchBotWithRetry(bot);
        botRunning = true;
        console.log(`[bot] Telegram Bot 已启动（attempt=${attempt}）`);
      } catch (err) {
        const msg = (err as Error).message ?? "";
        const isConflict = msg.includes("409") || msg.includes("terminated by other getUpdates request");
        const isTransient = isTelegramTransientError(err);
        if (isConflict || isTransient) {
          const waitMs = Math.min(20_000, 1_000 * 2 ** Math.min(attempt, 4));
          console.warn(`[bot] 启动失败（冲突或网络），${waitMs}ms 后重试，原因: ${msg}`);
          await sleep(waitMs);
          continue;
        }
        throw err;
      }
    }
  }

  // 启动后异步同步，避免首轮同步阻塞机器人可用性
  const bootTimer = setTimeout(async () => {
    console.log("[boot] 启动后执行一次同步...");
    try {
      const r = await syncService.sync({ forceFull: false });
      console.log(`[sync] 扫描 ${r.scanned}, 索引 ${r.indexed}`);
    } catch (err) {
      console.error("[sync] 启动同步失败:", (err as Error).message);
    }
  }, 0);
  if (botRunning) {
    bootTimer.unref();
  }

  const intervalMs = config.syncIntervalMinutes * 60 * 1000;
  const periodicTimer = setInterval(async () => {
    try {
      const r = await syncService.sync({ forceFull: false });
      console.log(`[sync] 增量完成 扫描 ${r.scanned}, 索引 ${r.indexed}, 时间 ${r.lastSyncAt}`);
    } catch (err) {
      console.error("[sync] 定时同步失败:", (err as Error).message);
    }
  }, intervalMs);
  if (botRunning) {
    periodicTimer.unref();
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[bot] 收到 ${signal}，准备退出`);
    if (botRunning) {
      await bot.stop(signal);
    }
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
};

process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandledRejection:", reason);
});

void main();
