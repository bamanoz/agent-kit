# agent-kit

Переносимая агентская обвязка, выделенная из проекта digital-rouble:

- **OMO**: плагин `oh-my-openagent` в `opencode.json` проекта (модели и
  категории берутся из общего `~/.omo/omo.jsonc`);
- **Mempalace** 3.9.0: локальный MCP-сервер, палата `.mempalace/palace`
  (chroma, эмбеддинги `embeddinggemma`, автосохранение и телеметрия
  выключены), отдельное крыло на проект;
- **project-memory**: чистый каркас с baseline, реестрами, протоколом сессии,
  ADR-0001, CHG-0001 и шаблонами `ARCH`/`ADR`/`CHG`/`OQ`;
- **правила агентов**: управляемый блок `AGENTS.md` (память, согласованность,
  надежность и изоляция субагентов), `scripts/agent-worktree`, команды
  OpenCode `/memory-checkpoint` и `/memory-change`.

Доменные части digital-rouble (KB, ТП, стенды, C#-правила, скиллы) в комплект
не входят.

## Платформы

| Платформа | Статус |
| --- | --- |
| Linux, WSL2 | Проверено |
| Windows 10/11 x64 (cmd, PowerShell) | Поддерживается; проверены разрешимость пакетов и логика установщика, живой запуск на Windows не выполнялся |
| macOS | Должно работать (те же sh-скрипты), не проверялось |
| Windows ARM64 | Не поддерживается: для chromadb нет сборок |

Проект, созданный в одной ОС, работает в другой: в `scripts/` лежат пары
`mempalace-mcp` / `mempalace-mcp.cmd`, а `opencode.json` ссылается на
`scripts/mempalace-mcp` — OpenCode в Windows сам выбирает `.cmd`. Окружение
Mempalace (`.venv-mempalace`) и палата платформенно-зависимы и в Git не
попадают: на другой машине выполните установщик повторно.

## Требования

- Python 3.12+ для окружения Mempalace (установщик ищет `python3.12+`, в
  Windows — `py -3.14…-3.12`; можно указать `--python`). Сам установщик
  запускается на Python 3.9+.
- В Linux: пакет `python3.X-venv`. В Windows: Python с python.org вместе с
  py-launcher.
- `git`, OpenCode.
- Сеть при первой установке: PyPI (~430 МБ пакетов) и Hugging Face (модель
  эмбеддингов ~300 МБ). Для офлайн-установки см. ниже.

## Установка с вопросами

Распакуйте архив и запустите мастер:

| Система | Файл | Как запустить |
| --- | --- | --- |
| Linux, macOS, WSL | `setup.sh` | `./setup.sh` в терминале или двойной щелчок (откроется терминал) |
| Windows | `setup.cmd` | двойной щелчок или `setup.cmd` в cmd/PowerShell |

Мастер спрашивает путь к каталогу проекта (можно перетащить папку в окно),
имя проекта, крыло Mempalace, версию OMO и вид окружения, показывает итог и
после подтверждения разворачивает обвязку. Если в проекте уже есть
`.agent-kit.json`, мастер предлагает обновление с прежним крылом. Если рядом
с мастером лежит каталог `wheels/` (офлайн-архив), пакеты берутся из него.

## Установка без вопросов

Linux, macOS, WSL:

```bash
tar xzf agent-kit-1.1.0.tar.gz
agent-kit-1.1.0/install.sh ~/work/new-project
agent-kit-1.1.0/install.sh ~/work/new-project --dry-run   # только показать
```

Windows (cmd или PowerShell), архив `agent-kit-1.1.0.zip`:

```bat
agent-kit-1.1.0\install.cmd C:\work\new-project
```

Параметры: `--name`, `--wing`, `--omo <spec|none>`, `--venv shared|local`,
`--venv-dir`, `--python`, `--wheelhouse <каталог>`, `--no-mempalace`,
`--skip-probe`, `--dry-run`. Справка: `install.sh --help` / `install.cmd --help`.

## Что происходит при установке

| Объект | Поведение |
| --- | --- |
| `project-memory/`, `.omo/rules/` | Создаются, если файла нет; существующие не трогаются |
| `scripts/*`, `.opencode/commands/memory-*.md` | Управляются комплектом: обновляются с резервной копией |
| `AGENTS.md`, `.gitignore`, `.gitattributes` | Вставляется или обновляется блок между маркерами `agent-kit`; остальной текст, BOM и переводы строк сохраняются |
| `opencode.json` | Добавляются отсутствующие `mcp.mempalace` и плагин OMO; ручные настройки не меняются, запуск из версии 1.0.0 переводится на `scripts/mempalace-mcp` |
| `.venv-mempalace` | Ссылка на общее окружение (Linux: `~/.local/share/agent-kit/venvs/mempalace-3.9.0`, Windows: `%LOCALAPPDATA%\agent-kit\venvs\mempalace-3.9.0`; в Windows при отсутствии прав на symlink создается junction) или локальное окружение при `--venv local` |
| `.mempalace/palace`, `mempalace.yaml` | Создаются при первой установке; в палату пишется первая запись в комнату `implementation-overview`. Глобальный `~/.mempalace/known_entities.json` не изменяется |
| `.agent-kit.json` | Имя проекта, крыло и версии; повторная установка берет крыло отсюда |

После установки скрипт запускает MCP-сервер так же, как OpenCode, и
проверяет `tools/list`, запись и поиск в крыле проекта.

## Изоляция данных

Записи, граф знаний и события каждого проекта хранятся в его
`.mempalace/palace`. Общими остаются `~/.mempalace/` (журнал операций без
текста записей, реестр сущностей, настройки по умолчанию), окружение
Mempalace и кэш модели эмбеддингов.

## Офлайн-установка

```bash
./build.sh --with-wheels windows   # или linux; Python 3.12, x64
```

Архив `agent-kit-1.1.0-offline-<платформа>-py312` содержит каталог `wheels/`:

```bat
agent-kit-1.1.0\install.cmd C:\work\project --wheelhouse agent-kit-1.1.0\wheels --python "C:\Program Files\Python312\python.exe"
```

Модель `onnx-community/embeddinggemma-300m-ONNX` скачивается в кэш Hugging
Face при первом обращении; для машины без сети скопируйте каталог кэша
(`~/.cache/huggingface` или `%USERPROFILE%\.cache\huggingface`) заранее.

## Обновление проекта

Запустите установщик новой версии для того же каталога. Проектные файлы и
палата сохраняются, управляемые блоки и скрипты обновляются с резервными
копиями `*.bak-<время>` (исключены из Git).
