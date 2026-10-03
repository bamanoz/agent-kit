#!/bin/sh
# Пошаговая установка agent-kit (Linux, macOS, WSL): спрашивает путь проекта
# и параметры, затем разворачивает OMO, Mempalace и project-memory.
# Запуск: ./setup.sh или двойной щелчок в файловом менеджере.
# Для установки без вопросов используйте install.sh.

KIT_DIR=$(cd "$(dirname "$0")" && pwd)

# Запуск без терминала (двойной щелчок): открываем эмулятор терминала.
# Ввод через конвейер из терминала сюда не попадает: stdout остается терминалом.
if [ ! -t 0 ] && [ ! -t 1 ] && [ -z "${AGENT_KIT_IN_TERMINAL:-}" ]; then
  export AGENT_KIT_IN_TERMINAL=1
  for term in x-terminal-emulator gnome-terminal konsole xfce4-terminal xterm; do
    if command -v "$term" >/dev/null 2>&1; then
      case "$term" in
        gnome-terminal) exec "$term" -- "$0" "$@" ;;
        *) exec "$term" -e "$0" "$@" ;;
      esac
    fi
  done
  echo "ошибка: запустите setup.sh из терминала" >&2
  exit 1
fi

pause() {
  # Окно, открытое двойным щелчком, не закрывается до нажатия Enter.
  if [ -n "${AGENT_KIT_IN_TERMINAL:-}" ]; then
    printf '\nНажмите Enter, чтобы закрыть окно...'
    read -r _
  fi
}

for py in python3 python; do
  if command -v "$py" >/dev/null 2>&1 && "$py" -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null; then
    "$py" "$KIT_DIR/lib/kit.py" wizard
    rc=$?
    [ "$rc" -eq 0 ] || printf '\nУстановка завершилась с ошибкой (код %s).\n' "$rc"
    pause
    exit "$rc"
  fi
done
echo "ошибка: не найден Python 3.9+ (для окружения Mempalace нужен 3.12+)" >&2
pause
exit 1
