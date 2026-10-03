#!/bin/sh
# Установка agent-kit в проект (Linux, macOS, WSL, Git Bash).
#   ./install.sh <каталог-проекта> [параметры]   справка: ./install.sh --help
# Вся логика находится в lib/kit.py; здесь только поиск Python 3.

KIT_DIR=$(cd "$(dirname "$0")" && pwd)
for py in python3 python; do
  if command -v "$py" >/dev/null 2>&1 && "$py" -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null; then
    exec "$py" "$KIT_DIR/lib/kit.py" install "$@"
  fi
done
echo "ошибка: не найден Python 3.9+ (для окружения Mempalace нужен 3.12+)" >&2
exit 1
