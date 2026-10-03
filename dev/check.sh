#!/bin/sh
# Проверка шаблона Jev перед сборкой комплекта: типы TypeScript и тесты без сети.
# Нужны Node 22.18+ и npm; зависимости ставятся в dev/node_modules (в архив не входят).
set -eu
DEV=$(cd "$(dirname "$0")" && pwd)
cd "$DEV"
[ -d node_modules/typescript ] || npm install --silent --no-audit --no-fund --no-save \
  typescript@6 @types/node@24 @opencode-ai/plugin@1.18.31 >/dev/null
node node_modules/typescript/bin/tsc -p tsconfig.json
node --test ../template/jev/managed/.opencode/jev/jev.test.ts
