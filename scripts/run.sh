#!/bin/zsh
cd /Users/huangyinan/Documents/notion/notion-telegram-brain || exit 1
exec node --enable-source-maps dist/index.js
