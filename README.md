# agent-kit

Переносимая агентская обвязка для проектов:

- **OMO**: плагин `oh-my-openagent@4.19.4` в `opencode.json` проекта и полный
  проектный профиль `.omo/omo.jsonc`: модели 11 агентов, 8 категорий,
  резервные маршруты и runtime fallback. Глобальный `~/.omo/omo.jsonc`
  для этого профиля не нужен; [провайдеры](#провайдеры-для-omo) подключаются отдельно;
- **Mempalace** 3.9.0: локальный MCP-сервер, палата `.mempalace/palace`,
  backend `chroma`, эмбеддинги `embeddinggemma`, отдельное крыло на проект.
  Автосохранение через hooks и телеметрия по умолчанию отключены;
- **project-memory**: чистый каркас с baseline, реестрами, протоколом сессии,
  ADR-0001, CHG-0001 и шаблонами `ARCH`/`ADR`/`CHG`/`OQ`;
- **правила агентов**: управляемый блок `AGENTS.md` (память, согласованность,
  надежность и изоляция субагентов), `scripts/agent-worktree`, команды
  OpenCode `/memory-checkpoint` и `/memory-change`;
- **исполняемые спецификации** (компонент `spec`): CLI
  [focused-spec](https://github.com/bamanoz/focused-spec) 0.6.0, runner'ы
  `py-unittest` и `dotnet-xunit`, навык `focused-spec` для OpenCode, двухслойная
  схема `specs/<capability>` / `specs/changes/<change>` с архивом и дополнения
  ролей OMO (Sisyphus, Prometheus, Atlas) для работы по спецификации (SDD).

## Провайдеры для OMO

Для регистрации можно использовать реферальные ссылки автора:

| Провайдер | Регистрация | Дополнительно |
| --- | --- | --- |
| ApiClo | [apiclo.com](https://apiclo.com/r/10OEUU5avO) | |
| ExCash | [excash.org](https://excash.org/?ref=REF-H9Z4FX) | Для доступа к ИИ в личном кабинете откройте «Настройки → Инвайт-коды» и введите `INV-YYRBPE` |
| CloseRouter | [closerouter.dev](https://closerouter.dev/?ref=0f1e2dcdad28665c) | |
| Codex Sale | [codex.sale](https://codex.sale/register?ref=cocmefirst) | |
| ClaudeHub | [app.claudehub.fun](https://app.claudehub.fun/r/P93EN9) | |
| CheapVibeCode | [cheapvibecode.ru](https://cheapvibecode.ru/ref/GSP4L66MA8) | |

Регистрация не подключает провайдера автоматически: настройте его в OpenCode
и сверьте доступные модели с маршрутами в `.omo/omo.jsonc`.

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
- Для компонента `spec`: Node.js 22.18+ с npm (runner'ы на TypeScript
  запускаются без сборки), Python 3 для `py-unittest`, .NET SDK для
  `dotnet-xunit`. Без Node.js файлы устанавливаются, зависимости — нет
  (установщик предупредит).
- Сеть при первой установке: PyPI (~430 МБ пакетов) и Hugging Face (модель
  эмбеддингов ~300 МБ), npm для `focused-spec` и плагина OMO. Для работы
  моделей нужен доступ к API провайдеров. Для офлайн-установки см. ниже.

## Установка с вопросами

Распакуйте архив и запустите мастер:

| Система | Файл | Как запустить |
| --- | --- | --- |
| Linux, macOS, WSL | `setup.sh` | `./setup.sh` в терминале или двойной щелчок (откроется терминал) |
| Windows | `setup.cmd` | двойной щелчок или `setup.cmd` в cmd/PowerShell |

Мастер спрашивает путь к каталогу проекта (можно перетащить папку в окно),
имя проекта, крыло Mempalace, версию OMO, вид окружения и установку компонента
`spec`, показывает итог и после подтверждения разворачивает обвязку.
Если в проекте уже есть `.agent-kit.json`, мастер предлагает обновление с
прежним крылом. Если рядом
с мастером лежит каталог `wheels/` (офлайн-архив), пакеты берутся из него.

## Установка без вопросов

Linux, macOS, WSL:

```bash
tar xzf agent-kit-1.3.1.tar.gz
agent-kit-1.3.1/install.sh ~/work/new-project
agent-kit-1.3.1/install.sh ~/work/new-project --dry-run   # только показать
```

Windows (cmd или PowerShell), архив `agent-kit-1.3.1.zip`:

```bat
agent-kit-1.3.1\install.cmd C:\work\new-project
```

По умолчанию установщик выбирает оба компонента:

| Компонент | Состав | Как пропустить |
| --- | --- | --- |
| `base` | OMO, профиль моделей, Mempalace, project-memory и правила агентов | Выбрать другие компоненты через `--only` |
| `spec` | focused-spec, runner'ы, навык и дополнения ролей OMO | `--no-spec` |

Параметры: `--name`, `--wing`, `--omo <пакет[@версия]|none>`, `--venv shared|local`,
`--venv-dir`, `--python`, `--wheelhouse <каталог>`, `--no-mempalace`,
`--no-omo-profile`, `--no-spec`, `--only <base,spec>`,
`--skip-probe`, `--dry-run`. В `--only` передается нужный список через запятую;
он имеет приоритет над `--no-spec`. Пропуск компонента при
обновлении не удаляет его ранее установленные файлы.

`--no-omo-profile` пропускает профиль моделей из `base`, оставляя выбор
моделей личному глобальному конфигу; `--omo none` пропускает и профиль, и
добавление плагина OMO. Компонент `spec` в обоих случаях добавляет свои роли в
`.omo/omo.jsonc`. Для установки только базовой обвязки используйте `--only base`.

Только focused-spec — для проекта со своей обвязкой:

```bash
agent-kit-1.3.1/install.sh ~/work/project --only spec
```

Справка: `install.sh --help` / `install.cmd --help`.

## Что происходит при установке

| Объект | Поведение |
| --- | --- |
| `project-memory/`, `.omo/rules/` | Создаются, если файла нет; существующие не трогаются |
| `scripts/*`, `.opencode/commands/memory-*.md` | Управляются комплектом: обновляются с резервной копией |
| `AGENTS.md`, `.gitignore`, `.gitattributes` | Вставляется или обновляется блок между маркерами `agent-kit`; остальной текст, BOM и переводы строк сохраняются |
| `opencode.json` | Добавляются отсутствующие `mcp.mempalace` и плагин OMO; ручные настройки не меняются, прежний прямой запуск MCP переводится на `scripts/mempalace-mcp`. При наличии `opencode.jsonc` настройки для ручного слияния выводятся в терминал |
| `.venv-mempalace` | Ссылка на общее окружение (Linux: `~/.local/share/agent-kit/venvs/mempalace-3.9.0`, Windows: `%LOCALAPPDATA%\agent-kit\venvs\mempalace-3.9.0`; в Windows при отсутствии прав на symlink создается junction) или локальное окружение при `--venv local` |
| `.mempalace/palace`, `mempalace.yaml` | Создаются при первой установке; в палату пишется первая запись в комнату `implementation-overview`. Глобальный `~/.mempalace/known_entities.json` не изменяется |
| `.focused-spec/runners/`, `.opencode/skills/focused-spec/` | Компонент `spec`: управляются комплектом |
| `.omo/omo.jsonc` | `base`: полный профиль моделей; `spec`: дополнения ролей SDD. Отсутствующие ключи добавляются рекурсивно, существующие значения и массивы проекта имеют приоритет. При изменении сохраняется резервная копия; комментарии прежнего JSONC остаются в ней |
| `.focused-spec/config.yaml`, `specs/` | Компонент `spec`: принадлежат проекту; конфигурация создаётся один раз, спецификации пишет пользователь или агент по явной задаче |
| `package.json` | Компонент `spec`: добавляются `focused-spec` в `devDependencies` и скрипты `spec:validate`, `spec:run`, `test:runners`, если их нет; версии и скрипты проекта не меняются. Затем `npm install` (или `npm ci` без изменений) |
| `.agent-kit.json` | Имя проекта, крыло, версии и установленные компоненты; повторная установка берет крыло отсюда |

После установки скрипт запускает MCP-сервер так же, как OpenCode, и
проверяет `tools/list`, запись и поиск в крыле проекта. Для компонента `spec`
выполняются `focused-spec validate` и тесты runner'ов (`npm run test:runners`).
`--skip-probe` отключает проверки MCP и focused-spec, но не установку
зависимостей. `--no-mempalace` пропускает создание окружения и палаты;
файлы запуска и настройки MCP остаются частью `base`.

## Профиль OMO и доступ к моделям

Профиль задает основные модели, уровень reasoning, резервные маршруты
агентов и категорий и автоматическое переключение при сбоях (runtime fallback).
Профиль находится в `template/omo/profile.json`, дополнения SDD — в
`template/spec/omo-roles.json`; установщик объединяет их в `.omo/omo.jsonc`
с приоритетом значений, уже заданных проектом. Личный глобальный файл не
изменяется. Повторная установка не заменяет существующие массивы маршрутов.

В профиле используются идентификаторы провайдеров `apiclo`, `externcash`,
`closerouter`, `closerouter-anthropic` и `codexsale`. Конфигурация этих
провайдеров в OpenCode и ключи доступа в комплект не входят: получатель должен
настроить их и авторизоваться через `opencode auth login` либо заменить
маршруты в `.omo/omo.jsonc` своими. Один профиль не создаёт доступ к моделям.
После установки перезапустите OpenCode и используемый `opencode serve`.

## Изоляция данных

Записи, граф знаний и события каждого проекта хранятся в его
`.mempalace/palace`. Общими остаются `~/.mempalace/` (журнал операций без
текста записей, реестр сущностей, настройки по умолчанию), окружение
Mempalace и кэш модели эмбеддингов.

## Офлайн-установка Mempalace

```bash
./build.sh --with-wheels windows   # или linux; Python 3.12, x64
```

В `dist/` создаются архивы
`agent-kit-1.3.1-offline-<платформа>-py312.tar.gz` и `.zip`. Внутри находится
каталог `agent-kit-1.3.1/` с `wheels/`:

```bat
agent-kit-1.3.1\install.cmd C:\work\project --wheelhouse agent-kit-1.3.1\wheels --python "C:\Program Files\Python312\python.exe"
```

Модель `onnx-community/embeddinggemma-300m-ONNX` скачивается в кэш Hugging
Face при первом обращении; для машины без сети скопируйте каталог кэша
(`~/.cache/huggingface` или `%USERPROFILE%\.cache\huggingface`) заранее.
Архив включает только Python-зависимости Mempalace. Пакеты npm для OMO и
focused-spec нужно подготовить отдельно; `--wheelhouse` их не устанавливает.

## Обновление проекта

Запустите установщик новой версии для того же каталога. Проектные файлы и
палата сохраняются, управляемые блоки и скрипты обновляются с резервными
копиями `*.bak-<время>` (исключены из Git).

## Исполняемые спецификации (focused-spec и SDD)

focused-spec дополняет OMO проверяемыми сценариями и точными ссылками на
тесты; простые задачи выполняются обычным порядком.

- Простая задача: Sisyphus реализует и проверяет ее обычным способом.
- Задача по спецификации: Sisyphus пишет сценарии (`ID`, `WHEN`, `THEN`,
  `EVIDENCE`, для ненаписанных тестов `planned:`) и запускает `validate`;
  пользователь утверждает требования; Prometheus составляет план со ссылками
  на ID сценариев; Atlas исполняет и принимает работу по `focused-spec run`.

Слои спецификаций:

| Путь | Назначение |
| --- | --- |
| `specs/<capability>/spec.md` | Действующее поведение возможности; единственный владелец ID |
| `specs/changes/<change>/spec.md` | Сценарии одного изменения; правка сценария владельца — тот же ID и `REVISES: <capability>` |
| `specs/archive/<change>/` | Закрытые изменения, вне discovery |

Имена scope общие для спецификаций возможностей и изменений и не должны
совпадать. После успешного `run` изменения его сценарии переносятся к
владельцам с сохранением ID, каталог изменения перемещается в архив, затем
выполняется `run` каждой затронутой возможности. Небольшое изменение одной
возможности можно вести прямо в ее спецификации с полным `run` этого scope.

Порядок работы ролей задает блок `agent-kit-spec` в `AGENTS.md`, роли OMO
получают `prompt_append` из `.omo/omo.jsonc`. SDD включается только явной
просьбой пользователя; наличие конфигурации его не включает.

```bash
npx focused-spec validate --scope <scope>   # планирование: planned: допустим
npx focused-spec run --scope <scope>        # приемка: тесты выполняются, planned: запрещен
npm run test:runners                        # тесты runner'ов
```

`validate` без спецификаций дает `0 scenarios` и нулевой код — это не
приемка. SKIP и ERROR при `run` не считаются успехом. Селекторы runner'ов:
`py-unittest::<каталог>::<id unittest>` и
`dotnet-xunit::<путь к .csproj>::<полное имя теста>`. Интерпретатор Python для
`py-unittest` задается в `options.python` runner'а в `config.yaml` (по
умолчанию `python3`, в Windows — `python`). После изменения навыка или
`.omo/omo.jsonc` перезапустите OpenCode.

## Разработка и сборка комплекта

```bash
./dev/check.sh
./build.sh
```

`dev/check.sh` проверяет типы TypeScript (strict) runner'ов focused-spec,
запускает их тесты и тесты установщика и слияния профиля OMO. Нужны Node.js 22.18+,
npm и Python 3. При отсутствии зависимостей скрипт скачивает их в
`dev/node_modules`; сами тесты выполняются без сети. Проверки
`dotnet-xunit` используют сохраненные выводы и TRX, без запуска .NET SDK.

`build.sh` создает `dist/agent-kit-1.3.1.tar.gz` и
`dist/agent-kit-1.3.1.zip`. Зависимости разработки и тестовый скрипт из `dev/`
в архивы не входят. Версия архивов берется из `KIT_VERSION` в `lib/kit.py`.
