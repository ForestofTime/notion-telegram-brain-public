export type NotionDoc = {
  id: string;
  title: string;
  url: string;
  lastEditedTime: string;
  createdTime?: string;
  kind: "page" | "database";
  parentType?: string;
  markdown: string;
  contentText: string;
  distilled: string;
  preview: string;
};

export type IndexStore = {
  lastSyncAt: string | null;
  docs: NotionDoc[];
};

export type Citation = {
  title: string;
  url: string;
  excerpt: string;
  highlights: string[];
};

export type DecisionMode = "conservative" | "balanced" | "aggressive";
