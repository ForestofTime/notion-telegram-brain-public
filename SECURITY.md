# Security Policy

## Sensitive Data Handling

This repository is a public, sanitized edition.

Do not commit the following data:

- Real `TELEGRAM_BOT_TOKEN`
- Real `NOTION_TOKEN`
- Production `.env` files
- Runtime knowledge index files generated from private Notion content
- Logs containing request payloads, stack traces, or private links

## Safe Usage

1. Copy `.env.example` to `.env` locally.
2. Fill your own secrets only in local `.env`.
3. Keep runtime index in untracked paths such as `./data/notion-index.json`.
4. Run `npm run security:scan` before every commit.

## Reporting

If you discover a secret exposure risk, open a private security report instead of creating a public issue.
