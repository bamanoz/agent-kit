#!/bin/sh
# Проверка шаблонов перед сборкой комплекта: типы TypeScript, профиль OMO
# и тесты runner'ов focused-spec без сети.
# Нужны Node 22.18+, npm и Python 3; зависимости ставятся в dev/node_modules (в архив не входят).
set -eu
DEV=$(cd "$(dirname "$0")" && pwd)
cd "$DEV"
FOCUSED_SPEC=$(sed -n 's/^FOCUSED_SPEC_VERSION = "\(.*\)"/\1/p' ../lib/kit.py)
[ -d node_modules/typescript ] && [ -d "node_modules/focused-spec" ] || npm install --silent --no-audit --no-fund --no-save \
  typescript@6 @types/node@24 "focused-spec@$FOCUSED_SPEC" >/dev/null
node node_modules/typescript/bin/tsc -p tsconfig.spec.json
python3 -B -m unittest discover -s "$DEV" -p 'test_kit_omo.py'

# Runner'ы проверяются в установленном виде: во временном проекте с focused-spec.
SPEC_TMP=$(mktemp -d)
trap 'rm -rf "$SPEC_TMP"' EXIT
cp -r ../template/spec/managed/. "$SPEC_TMP/"
ln -s "$DEV/node_modules" "$SPEC_TMP/node_modules"
(cd "$SPEC_TMP" && node --test ".focused-spec/runners/tests/*.test.ts")
