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
