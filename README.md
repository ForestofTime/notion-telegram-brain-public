# Notion Telegram Brain (Public Sanitized Edition)

> Production secrets removed. This repository is safe for public sharing.

一个基于 Telegram + Notion 的知识机器人项目，支持同步、检索、问答与知识蒸馏。

## 功能概览

- `/sync` 增量同步 Notion 内容
- `/sync full` 全量同步
- `/sync_status` 查看后台同步状态
- `/notion <关键词>` 模糊搜索页面
- `/ask <问题>` 基于知识库问答
- `/learn 标题 | 内容` 手工补充知识
- `/digest` 生成知识蒸馏文档
- `/ping` 健康检查
- `/help` 查看命令说明

## 技术栈

- Node.js + TypeScript
- Telegraf
- Notion SDK
- notion-to-md
- 本地 JSON 索引

## 快速开始

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

## 目录说明

- `src/` 主业务代码
- `prompts/` 提示词与人格层模板
- `selves/` 数字工作体配置样例
- `data/example-index.json` 脱敏示例数据
- `docs/sanitization.md` 脱敏发布说明

## 安全与发布

公开发布前请执行：

```bash
npm run security:scan
```

更多说明见 [SECURITY.md](./SECURITY.md)。
