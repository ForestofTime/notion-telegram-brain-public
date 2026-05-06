# Changelog

## 0.2.0 - 2026-05-06

### Added
- 新增 `/goal` 命令，用于设置和查看当前工作目标。
- 新增 `/reembed` 命令，用于触发向量重算任务。
- 新增推理层与知识层模块：
  - `src/llm.ts`
  - `src/brain.ts`
  - `src/embeddings.ts`
  - `src/embedding-provider.ts`
  - `src/db.ts`

### Changed
- 检索升级为混合链路：关键词召回 + 向量召回 + RRF 重排。
- SQLite 索引能力增强，新增 `chunk_embeddings_v2` 与反馈相关权重利用。
- 启动流程新增 JSON 索引自动灌入 SQLite，避免初始空库导致问答缺失。
- `/ask` 路由与回答结构优化，支持更稳定的证据输出。
- 配置项扩展：
  - `EMBEDDING_PROVIDER`
  - `DEEPSEEK_EMBEDDING_MODEL`
  - 相关 `LLM_*` 与检索参数

### Fixed
- 修复重建 chunk 时外键约束失败问题：
  - 删除旧 chunk 前同步清理 `chunk_embeddings_v2`，避免 `FOREIGN KEY constraint failed`。
- 修复部署打包遗漏 `data/` 目录导致 Docker 构建失败的问题。

### Security
- 继续保持敏感信息仅通过环境变量注入，不提交 `.env`、真实索引和运行日志。
