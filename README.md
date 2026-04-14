# Notion Telegram Brain (Public Sanitized Edition)

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
![Node](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![Telegram Bot](https://img.shields.io/badge/Telegram-Bot-26A5E4?logo=telegram&logoColor=white)
![Notion](https://img.shields.io/badge/Notion-Integration-000000?logo=notion&logoColor=white)

> Production secrets removed. This repository is safe for public sharing.

## 中文说明

一个基于 Telegram + Notion 的知识机器人项目，支持同步、检索、问答与知识蒸馏。

### 主要功能

- `/sync` 增量同步 Notion 内容
- `/sync full` 全量同步
- `/sync_status` 查看后台同步状态
- `/notion <关键词>` 模糊搜索页面
- `/ask <问题>` 基于知识库问答
- `/learn 标题 | 内容` 手工补充知识
- `/digest` 生成知识蒸馏文档
- `/ping` 健康检查
- `/help` 查看命令说明

### 快速开始

1. 安装依赖

```bash
npm install
```

2. 配置环境变量

```bash
cp .env.example .env
```

3. 编辑 `.env`

- `TELEGRAM_BOT_TOKEN`
- `NOTION_TOKEN`
- `TELEGRAM_ALLOWED_USERS`
- `TELEGRAM_MODE=auto`

4. 构建并启动

```bash
npm run build
npm start
```

### 目录说明

- `src/` 主业务代码
- `prompts/` 提示词与人格层模板
- `selves/` 数字工作体配置样例
- `data/example-index.json` 脱敏示例数据
- `docs/sanitization.md` 脱敏发布说明

### 安全说明

公开发布前执行：

```bash
npm run security:scan
```

更多信息见 [SECURITY.md](./SECURITY.md)。

## English

A Telegram + Notion knowledge bot for sync, retrieval, Q&A, and distilled summaries.

### Features

- `/sync` incremental sync from Notion
- `/sync full` full re-index
- `/sync_status` background sync status
- `/notion <keyword>` fuzzy page search
- `/ask <question>` knowledge-grounded answer
- `/learn title | content` add manual knowledge
- `/digest` generate distilled notes
- `/ping` health check
- `/help` command guide

### Quick Start

1. Install dependencies

```bash
npm install
```

2. Setup environment

```bash
cp .env.example .env
```

3. Fill `.env`

- `TELEGRAM_BOT_TOKEN`
- `NOTION_TOKEN`
- `TELEGRAM_ALLOWED_USERS`
- `TELEGRAM_MODE=auto`

4. Build and run

```bash
npm run build
npm start
```

### Security

Before publishing or sharing, run:

```bash
npm run security:scan
```

Read [SECURITY.md](./SECURITY.md) for details.
