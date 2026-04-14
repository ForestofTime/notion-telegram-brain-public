import { config } from "./config.js";
import { NotionSyncService } from "./notion-sync.js";
import { JsonStore } from "./store.js";

const run = async (): Promise<void> => {
  const store = new JsonStore(config.dataFile);
  const service = new NotionSyncService(config.notionToken, store);
  const result = await service.sync({ forceFull: true });
  console.log(`FULL_SYNC_OK scanned=${result.scanned} indexed=${result.indexed} at=${result.lastSyncAt}`);
};

void run();
