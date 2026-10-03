#!/usr/bin/env python3
"""Установщик agent-kit: OMO, Mempalace, project-memory и правила агентов.

Компоненты: base (OMO, Mempalace, project-memory, правила агентов) и jev
(плагин OpenCode со слоем решений Jev, по умолчанию выключен).

Работает в Linux, macOS, WSL и Windows. Для запуска самого установщика
достаточно Python 3.9+ со стандартной библиотекой; окружению Mempalace нужен
Python 3.12+ (его установщик находит сам или берет из --python).

Подкоманды:
  wizard    пошаговая установка: спрашивает путь проекта и параметры
  install   установка или обновление обвязки в проекте
  probe     проверка MCP-сервера Mempalace проекта по протоколу stdio
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

KIT_VERSION = "1.2.0"
MEMPALACE_VERSION = "3.9.0"
EMBEDDING_MODEL = "embeddinggemma"
MIN_VENV_PYTHON = (3, 12)
DEFAULT_OMO = "oh-my-openagent@4.19.4"

KIT_DIR = Path(__file__).resolve().parent.parent
TEMPLATE = KIT_DIR / "template"
IS_WINDOWS = os.name == "nt"
STAMP = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
MONTHS = ("января", "февраля", "марта", "апреля", "мая", "июня", "июля",
          "августа", "сентября", "октября", "ноября", "декабря")

# Скрипты-обертки для sh: должны оставаться исполняемыми и с LF.
SH_SCRIPTS = ("scripts/agent-worktree", "scripts/mempalace", "scripts/mempalace-mcp")
JEV_SH_SCRIPTS = ("scripts/jev",)
COMPONENTS = ("base", "jev")
# Запуски MCP из прежних версий комплекта, которые безопасно заменить.
LEGACY_MCP_COMMANDS = (
    [".venv-mempalace/bin/mempalace-mcp", "--palace", ".mempalace/palace", "--backend", "chroma"],
)

DRY_RUN = False


class KitError(Exception):
    """Ошибка установки с понятным пользователю сообщением."""


# ---------------------------------------------------------------- вывод

def log(kind: str, message: str) -> None:
    print(f"  [{kind}] {message}", flush=True)


def step(title: str) -> None:
    print(f"\n== {title}", flush=True)


# ---------------------------------------------------------------- файлы

def read_text(path: Path) -> str:
    """Читает UTF-8 без преобразования переводов строк (BOM сохраняется)."""
    return path.read_bytes().decode("utf-8")


def write_text(path: Path, text: str) -> None:
    """Пишет байты как есть: в Windows нет подмены LF на CRLF."""
    if not DRY_RUN:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.encode("utf-8"))


def newline_of(text: str) -> str:
    return "\r\n" if "\r\n" in text else "\n"


def with_newline(text: str, newline: str) -> str:
    text = text.replace("\r\n", "\n")
    return text.replace("\n", newline) if newline != "\n" else text


def backup(path: Path) -> None:
    target = path.with_name(f"{path.name}.bak-{STAMP}")
    if not DRY_RUN:
        shutil.copy2(path, target)
    log("backup", f"{path.name} -> {target.name}")


def render_text(text: str, variables: dict) -> str:
    for key, value in variables.items():
        text = text.replace("{{" + key + "}}", value)
    unresolved = sorted(set(re.findall(r"\{\{[A-Z_]+\}\}", text)))
    if unresolved:
        raise KitError("не заданы переменные шаблона: " + ", ".join(unresolved))
    return text


def render_tree(src: Path, dst: Path, variables: dict, managed: bool) -> None:
    """Копирует дерево шаблонов с подстановкой {{VAR}}.

    Файлы проекта (managed=False) создаются один раз и дальше не меняются.
    Управляемые файлы обновляются при отличии, с резервной копией.
    """
    for path in sorted(src.rglob("*")):
        rel = path.relative_to(src)
        if path.is_dir() or "__pycache__" in rel.parts or path.suffix == ".pyc":
            continue
        if path.name == ".keep-empty":
            if not DRY_RUN:
                (dst / rel.parent).mkdir(parents=True, exist_ok=True)
            continue
        target = dst / rel
        content = render_text(read_text(path), variables).encode("utf-8")
        if target.exists():
            if target.read_bytes() == content:
                log("ok", f"{rel.as_posix()} без изменений")
                continue
            if not managed:
                log("keep", f"{rel.as_posix()} уже существует, не изменяется")
                continue
            backup(target)
            action = "update"
        else:
            action = "create"
        if not DRY_RUN:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            if not IS_WINDOWS:
                shutil.copymode(path, target)
        log(action, rel.as_posix())


def upsert_block(path: Path, content: Path, block_id: str, style: str,
                 variables: dict, header: Path | None = None) -> None:
    """Вставляет или обновляет блок между маркерами, остальной текст не трогает."""
    body = render_text(read_text(content), variables).replace("\r\n", "\n").strip("\n")
    if style == "md":
        start, end = f"<!-- {block_id}:start -->", f"<!-- {block_id}:end -->"
    else:
        start, end = f"# >>> {block_id}", f"# <<< {block_id}"
    block = f"{start}\n{body}\n{end}\n"
    if path.exists():
        text = read_text(path)
        nl = newline_of(text)
        block_nl = with_newline(block, nl)
        pattern = re.compile(re.escape(start) + r".*?" + re.escape(end) + r"(\r?\n)?", re.S)
        if pattern.search(text):
            new_text = pattern.sub(lambda _: block_nl, text, count=1)
            action = "update"
        else:
            stripped = text.rstrip("\r\n")
            new_text = stripped + (nl * 2 if stripped.strip("\ufeff") else "") + block_nl
            action = "append"
        if new_text == text:
            log("ok", f"{path.name}: блок {block_id} актуален")
            return
        backup(path)
    else:
        prefix = ""
        if header is not None:
            prefix = render_text(read_text(header), variables).replace("\r\n", "\n").rstrip("\n") + "\n\n"
        new_text = prefix + block
        action = "create"
    write_text(path, new_text)
    log(action, f"{path.name}: блок {block_id}")


# ---------------------------------------------------------------- opencode.json

def merge_opencode(project: Path, variables: dict, omo: str) -> None:
    template = json.loads(render_text(read_text(TEMPLATE / "opencode.json"), variables))
    if omo == "none":
        template.pop("plugin", None)
    else:
        template["plugin"] = [omo]

    jsonc, path = project / "opencode.jsonc", project / "opencode.json"
    if jsonc.exists():
        log("manual", "найден opencode.jsonc: автоматическое слияние не выполняется, добавьте вручную:")
        print(json.dumps({k: template[k] for k in ("mcp", "plugin") if k in template},
                         ensure_ascii=False, indent=2))
        return
    if not path.exists():
        write_text(path, json.dumps(template, ensure_ascii=False, indent=2) + "\n")
        log("create", "opencode.json")
        return

    raw = read_text(path)
    try:
        config = json.loads(raw.lstrip("\ufeff"))
    except json.JSONDecodeError as exc:
        raise KitError(f"opencode.json не разобран как JSON ({exc}); добавьте настройки вручную") from exc

    changed = []
    config.setdefault("$schema", template["$schema"])
    servers = config.setdefault("mcp", {})
    for name, server in template["mcp"].items():
        current = servers.get(name)
        if current is None:
            servers[name] = server
            changed.append(f"mcp.{name}")
        elif current.get("command") in LEGACY_MCP_COMMANDS:
            current["command"] = server["command"]
            env = current.setdefault("environment", {})
            for key, value in server.get("environment", {}).items():
                env.setdefault(key, value)
            current.setdefault("timeout", server.get("timeout"))
            changed.append(f"mcp.{name} (кроссплатформенный запуск)")
        elif current != server:
            log("keep", f"mcp.{name} настроен вручную и отличается от шаблона; не изменяется")
    if "plugin" in template:
        plugins = config.setdefault("plugin", [])
        omo_plugins = [str(p) for p in plugins if re.match(r"^oh-my-(openagent|opencode)(@|$)", str(p))]
        if omo_plugins:
            log("keep", "плагин OMO уже подключен: " + ", ".join(omo_plugins))
        else:
            plugins.append(template["plugin"][0])
            changed.append("plugin")
    if not changed:
        log("ok", "opencode.json актуален")
        return
    backup(path)
    out = json.dumps(config, ensure_ascii=False, indent=2) + "\n"
    out = ("\ufeff" if raw.startswith("\ufeff") else "") + with_newline(out, newline_of(raw))
    write_text(path, out)
    log("update", "opencode.json: " + ", ".join(changed))


# ---------------------------------------------------------------- Mempalace

MEMPALACE_YAML = """wing: {wing}
rooms:
- name: project_memory
  description: Files from project-memory/
  keywords:
  - project_memory
  - project-memory
- name: general
  description: Files that don't fit other rooms
  keywords: []
"""


def write_wing(project: Path, wing: str, name: str) -> None:
    """Файлы крыла без `mempalace init`: он пишет эвристические сущности
    в глобальный ~/.mempalace/known_entities.json."""
    yaml_path = project / "mempalace.yaml"
    if yaml_path.exists():
        text = read_text(yaml_path)
        new_text, count = re.subn(r"(?m)^wing:.*$", f"wing: {wing}", text, count=1)
        if count == 0:
            new_text = f"wing: {wing}\n" + text
        action = "ok" if new_text == text else "update"
    else:
        new_text, action = MEMPALACE_YAML.format(wing=wing), "create"
    if action != "ok":
        write_text(yaml_path, new_text)
    log(action, f"mempalace.yaml: крыло {wing}")
    entities = project / "entities.json"
    if not entities.exists():
        write_text(entities, json.dumps({"people": [], "projects": [name], "topics": []},
                                        ensure_ascii=False, indent=2) + "\n")
        log("create", "entities.json")


def default_venv_dir() -> Path:
    if IS_WINDOWS:
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return base / "agent-kit" / "venvs" / f"mempalace-{MEMPALACE_VERSION}"


def venv_exe(venv: Path, name: str) -> Path:
    return venv / "Scripts" / f"{name}.exe" if IS_WINDOWS else venv / "bin" / name


def venv_version(venv: Path) -> str | None:
    python = venv_exe(venv, "python")
    if not python.exists():
        return None
    result = subprocess.run(
        [str(python), "-c", "import importlib.metadata as m; print(m.version('mempalace'))"],
        capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else None


PYTHON_CHECK = (
    "import platform, sys; "
    "print(sys.version_info[:2] >= (3, 12)); "
    "print(platform.machine()); "
    "print(sys.executable)"
)


def find_python(explicit: str | None) -> str:
    """Ищет Python 3.12+ для окружения Mempalace."""
    candidates = [[explicit]] if explicit else [[sys.executable]]
    if not explicit:
        if IS_WINDOWS:
            candidates += [["py", f"-3.{minor}"] for minor in (14, 13, 12)]
        else:
            candidates += [[f"python3.{minor}"] for minor in (14, 13, 12)]
    for command in candidates:
        if not os.path.isabs(command[0]) and shutil.which(command[0]) is None:
            continue
        try:
            result = subprocess.run(command + ["-c", PYTHON_CHECK], capture_output=True,
                                    text=True, timeout=60)
        except (OSError, subprocess.TimeoutExpired):
            continue
        lines = result.stdout.split()
        if result.returncode == 0 and len(lines) >= 3 and lines[0] == "True":
            machine = lines[1].lower()
            if IS_WINDOWS and machine not in ("amd64", "x86_64"):
                raise KitError(f"Windows {lines[1]} не поддерживается: для chromadb есть только сборки x64")
            return lines[2]
    if explicit:
        raise KitError(f"{explicit} не подходит: нужен Python 3.12 или новее")
    hint = "установите Python 3.12+ (python.org, py-launcher)" if IS_WINDOWS else \
        "установите python3.12 и python3.12-venv или укажите --python"
    raise KitError(f"не найден Python 3.12+ для окружения Mempalace: {hint}")


def link_venv(link: Path, target: Path) -> Path | None:
    """Ссылка .venv-mempalace на общее окружение. В Windows без прав на
    символические ссылки создается junction."""
    if link.is_symlink() or link.exists():
        try:
            same = link.resolve() == target.resolve()
        except OSError:
            same = False
        if same:
            log("ok", f".venv-mempalace -> {target}")
        else:
            log("keep", ".venv-mempalace уже существует и не ведет в общее окружение")
        return link
    if DRY_RUN:
        log("dry-run", f".venv-mempalace -> {target}")
        return link
    try:
        os.symlink(target, link, target_is_directory=True)
        log("create", f".venv-mempalace -> {target}")
        return link
    except OSError:
        if not IS_WINDOWS:
            raise
    try:
        import _winapi  # type: ignore[import-not-found]
        _winapi.CreateJunction(str(target), str(link))
        log("create", f".venv-mempalace -> {target} (junction)")
        return link
    except (ImportError, OSError) as exc:
        log("warn", f"ссылка не создана ({exc}); скрипты запуска найдут общее окружение сами")
        return None


def venv_path(project: Path, args: argparse.Namespace) -> Path:
    return project / ".venv-mempalace" if args.venv == "local" else Path(args.venv_dir or default_venv_dir())


def ensure_venv(project: Path, args: argparse.Namespace, python: str | None) -> None:
    venv = venv_path(project, args)
    step(f"Окружение Mempalace {MEMPALACE_VERSION} ({args.venv}): {venv}")
    if python is None:
        log("ok", str(venv))
    elif DRY_RUN:
        log("dry-run", f"создание окружения {venv} ({python})")
    else:
        log("python", python)
        subprocess.run([python, "-m", "venv", str(venv)], check=True)
        pip = [str(venv_exe(venv, "python")), "-m", "pip", "install", "--quiet",
               "--disable-pip-version-check"]
        if args.wheelhouse:
            pip += ["--no-index", "--find-links", str(Path(args.wheelhouse).resolve())]
        pip += ["-r", str(KIT_DIR / "mempalace" / "requirements.lock")]
        if subprocess.run(pip).returncode != 0:
            raise KitError("pip не установил зависимости Mempalace (см. вывод выше)")
        log("create", str(venv))
    if args.venv == "shared":
        link_venv(project / ".venv-mempalace", venv)


# ---------------------------------------------------------------- проверка MCP

def resolve_command(command: list, cwd: Path) -> list:
    """Разрешает команду так же, как cross-spawn в OpenCode: в Windows
    `scripts/x` находит `scripts/x.cmd` по PATHEXT и запускает через cmd."""
    if not IS_WINDOWS:
        return command
    head = cwd / command[0]
    if head.suffix:
        candidates = [head]
    else:
        # Как node-which: имя без точки проверяется только с расширениями PATHEXT,
        # поэтому sh-скрипт без расширения рядом с .cmd не выбирается.
        exts = os.environ.get("PATHEXT", ".COM;.EXE;.BAT;.CMD").split(";")
        candidates = [head.with_name(head.name + ext.lower()) for ext in exts if ext]
    for candidate in candidates:
        if candidate.is_file():
            if candidate.suffix.lower() in (".cmd", ".bat"):
                return ["cmd.exe", "/d", "/c", str(candidate)] + command[1:]
            return [str(candidate)] + command[1:]
    return command


def probe(project: Path, wing: str, query: str, seed: str | None, timeout: int = 900) -> None:
    config = json.loads(read_text(project / "opencode.json").lstrip("\ufeff"))
    server = config["mcp"]["mempalace"]
    env = os.environ.copy()
    env.update(server.get("environment", {}))
    env.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    command = resolve_command(server["command"], project)
    proc = subprocess.Popen(command, cwd=project, env=env, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, encoding="utf-8", errors="replace")

    def send(message: dict) -> None:
        proc.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        proc.stdin.flush()

    def receive(request_id: int) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = proc.stdout.readline()
            if not line:
                raise KitError("MCP-сервер завершился: " + proc.stderr.read()[-1500:])
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if message.get("id") == request_id:
                return message
        raise KitError(f"MCP-сервер не ответил за {timeout} с")

    def call(request_id: int, name: str, arguments: dict) -> dict:
        send({"jsonrpc": "2.0", "id": request_id, "method": "tools/call",
              "params": {"name": name, "arguments": arguments}})
        response = receive(request_id)
        result = response.get("result") or {}
        if "error" in response or result.get("isError"):
            raise KitError(f"{name}: {json.dumps(response, ensure_ascii=False)[:800]}")
        text = "".join(part.get("text", "") for part in result.get("content", []))
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return {"text": text}

    try:
        send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "agent-kit-probe", "version": KIT_VERSION}}})
        info = receive(1)["result"]["serverInfo"]
        send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        tools = {tool["name"] for tool in receive(2)["result"]["tools"]}
        required = {"mempalace_search", "mempalace_add_drawer", "mempalace_checkpoint",
                    "mempalace_diary_write"}
        if required - tools:
            raise KitError("нет инструментов MCP: " + ", ".join(sorted(required - tools)))
        log("ok", f"MCP {info.get('name')} {info.get('version')}: {len(tools)} инструментов")
        if seed:
            result = call(3, "mempalace_add_drawer", {
                "wing": wing, "room": "implementation-overview", "content": seed,
                "added_by": "agent-kit"})
            log("ok", f"первая запись палаты: {result.get('drawer_id', result)}")
        hits = call(4, "mempalace_search", {"query": query, "wing": wing, "limit": 1}).get("results", [])
        if seed and not hits:
            raise KitError("поиск не нашел только что добавленную запись")
        log("ok", f"поиск в крыле {wing}: найдено {len(hits)}")
    finally:
        if proc.stdin:
            proc.stdin.close()
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


# ---------------------------------------------------------------- установка

def git(project: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(project), *args], capture_output=True, text=True, check=check)


def load_state(path: Path) -> dict:
    try:
        return json.loads(read_text(path).lstrip("\ufeff"))
    except FileNotFoundError:
        return {}


def slug_wing(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def install_jev(project: Path, variables: dict) -> None:
    """Слой решений Jev: плагин и скрипт управляются комплектом, настройки принадлежат проекту.
    Режим по умолчанию off (файла .opencode/jev.mode нет): поведение агентов не меняется."""
    jev = TEMPLATE / "jev"
    step("Слой решений Jev: управляемые файлы (плагин, scripts/jev)")
    render_tree(jev / "managed", project, variables, managed=True)
    step("Слой решений Jev: настройки проекта (.opencode/jev.json)")
    render_tree(jev / "project", project, variables, managed=False)
    if IS_WINDOWS and not DRY_RUN:
        git(project, "update-index", "--add", "--chmod=+x", *JEV_SH_SCRIPTS, check=False)
    upsert_block(project / ".gitignore", jev / "gitignore-jev.txt", "agent-kit-jev", "hash", variables)
    upsert_block(project / "AGENTS.md", jev / "agents-jev.md", "agent-kit-jev", "md", variables,
                 header=TEMPLATE / "blocks" / "agents-header.md")
    mode_file = project / ".opencode" / "jev.mode"
    mode = mode_file.read_text(encoding="utf-8").strip() if mode_file.exists() else "off"
    log("ok", f"режим Jev: {mode} (переключение: scripts/jev on|shadow|off)")


def parse_components(raw: str) -> tuple[str, ...]:
    items = tuple(dict.fromkeys(part.strip() for part in raw.split(",") if part.strip()))
    unknown = [item for item in items if item not in COMPONENTS]
    if unknown or not items:
        raise KitError(f"неизвестные компоненты: {', '.join(unknown) or raw!r}; допустимо: {', '.join(COMPONENTS)}")
    return items


def cmd_install(args: argparse.Namespace) -> int:
    global DRY_RUN
    DRY_RUN = args.dry_run
    if shutil.which("git") is None:
        raise KitError("нужен git")

    project = Path(args.target).expanduser().resolve()
    if project == KIT_DIR:
        raise KitError("нельзя устанавливать комплект в его собственный каталог")
    if project.exists() and not project.is_dir():
        raise KitError(f"{project} существует и не является каталогом")

    components = parse_components(args.only) if args.only else \
        tuple(c for c in COMPONENTS if not (c == "jev" and args.no_jev))
    base = "base" in components

    state_path = project / ".agent-kit.json"
    state = load_state(state_path)
    name = args.name or state.get("name") or project.name
    wing = args.wing or state.get("wing") or slug_wing(name) or slug_wing(project.name) or "project"
    if not re.fullmatch(r"[a-z0-9][a-z0-9_]{0,63}", wing):
        raise KitError(f"недопустимое крыло '{wing}': используйте --wing с [a-z0-9_]")

    today = dt.date.today()
    variables = {
        "PROJECT_NAME": name, "WING": wing, "DATE": today.isoformat(),
        "DATE_HUMAN": f"{today.day} {MONTHS[today.month - 1]} {today.year}",
        "KIT_VERSION": KIT_VERSION, "EMBEDDING_MODEL": EMBEDDING_MODEL,
        "MEMPALACE_VERSION": MEMPALACE_VERSION, "OMO_PLUGIN": args.omo,
    }

    # Python для окружения ищется до любых изменений в проекте.
    venv_python = None
    if base and not args.no_mempalace and venv_version(venv_path(project, args)) != MEMPALACE_VERSION:
        venv_python = find_python(args.python)

    print(f"agent-kit {KIT_VERSION} -> {project}")
    print(f"  проект: {name}, компоненты: {', '.join(components)}"
          + (f", крыло Mempalace: {wing}, OMO: {args.omo}" if base else ""))
    if DRY_RUN:
        print("  режим проверки: изменения не записываются")
    elif not project.exists():
        project.mkdir(parents=True)

    if base:
        install_base(project, args, variables, venv_python)
    if "jev" in components:
        install_jev(project, variables)

    if not DRY_RUN:
        state.setdefault("installedAt", today.isoformat())
        if base:
            state.update(name=name, wing=wing, mempalaceVersion=MEMPALACE_VERSION)
        else:
            state.setdefault("name", name)
        installed = set(state.get("components") or (["base"] if state.get("wing") else []))
        state.update(kitVersion=KIT_VERSION, updatedAt=today.isoformat(),
                     components=[c for c in COMPONENTS if c in installed | set(components)])
        write_text(state_path, json.dumps(state, ensure_ascii=False, indent=2) + "\n")

    step("Готово")
    hints = []
    if base:
        hints += ["Заполните раздел «Проект» в AGENTS.md (вне блоков agent-kit).",
                  f"Запустите opencode в {project}: MCP mempalace и OMO подключатся автоматически.",
                  "Проверка: opencode mcp list"]
    if "jev" in components:
        hints += ["Jev выключен по умолчанию: scripts/jev shadow — только журнал решений, "
                  "scripts/jev on — применять; scripts/jev status — режим и ключ провайдера."]
    commit = ["AGENTS.md", ".gitignore", ".agent-kit.json", "scripts/"]
    if base:
        commit[1:1] = ["opencode.json"]
        commit += [".gitattributes", "project-memory/", ".opencode/commands/"]
    if "jev" in components:
        commit += [".opencode/plugins/jev.ts", ".opencode/jev/", ".opencode/jev.json"]
    hints.append("Закоммитьте " + ", ".join(commit) + ".")
    print("  Дальше:\n" + "\n".join(f"  {i}. {hint}" for i, hint in enumerate(hints, 1)))
    return 0


def install_base(project: Path, args: argparse.Namespace, variables: dict, venv_python: str | None) -> None:
    name, wing = variables["PROJECT_NAME"], variables["WING"]
    step("Git-репозиторий")
    inside = project.exists() and git(project, "rev-parse", "--is-inside-work-tree", check=False).returncode == 0
    if inside:
        log("ok", git(project, "rev-parse", "--show-toplevel").stdout.strip())
    else:
        if not DRY_RUN:
            git(project, "init", "-q")
        log("create", "git init (project-memory и agent-worktree требуют Git)")

    step(".gitignore и .gitattributes")
    blocks = TEMPLATE / "blocks"
    upsert_block(project / ".gitignore", blocks / "gitignore.txt", "agent-kit", "hash", variables)
    upsert_block(project / ".gitattributes", blocks / "gitattributes.txt", "agent-kit", "hash", variables)

    step("Файлы проекта (создаются один раз, затем принадлежат проекту)")
    render_tree(TEMPLATE / "project", project, variables, managed=False)

    step("Управляемые файлы комплекта (обновляются с резервной копией)")
    render_tree(TEMPLATE / "managed", project, variables, managed=True)
    if IS_WINDOWS and not DRY_RUN:
        # NTFS не хранит бит исполнения: фиксируем его в индексе Git для Linux.
        result = git(project, "update-index", "--add", "--chmod=+x", *SH_SCRIPTS, check=False)
        if result.returncode == 0:
            log("git", "sh-скрипты добавлены в индекс с правом исполнения")

    step("AGENTS.md")
    upsert_block(project / "AGENTS.md", blocks / "agents-kit.md", "agent-kit", "md", variables,
                 header=blocks / "agents-header.md")

    step("opencode.json (OMO и MCP mempalace)")
    merge_opencode(project, variables, args.omo)

    if not args.no_mempalace:
        ensure_venv(project, args, venv_python)
        step(f"Палата Mempalace (крыло {wing})")
        write_wing(project, wing, name)
        if not args.skip_probe and not DRY_RUN:
            step("Проверка MCP mempalace (первый запуск может скачать модель эмбеддингов)")
            seed = None
            if not (project / ".mempalace" / "palace" / "chroma.sqlite3").exists():
                seed = (f"{variables['DATE_HUMAN']}: проект {name} подключен к Mempalace комплектом "
                        f"agent-kit {KIT_VERSION}. Источник истины — project-memory/ в Git "
                        "(ADR-0001, CHG-0001); палата хранит причины решений, историю и ссылки "
                        "на Git-артефакты.")
            probe(project, wing, "подключение проекта к Mempalace", seed)


def ask(prompt: str, default: str = "") -> str:
    """Вопрос пользователю; пустой ответ дает значение по умолчанию."""
    suffix = f" [{default}]" if default else ""
    try:
        answer = input(f"{prompt}{suffix}: ").strip()
    except EOFError as exc:
        raise KitError("ввод прерван") from exc
    return answer or default


def ask_yes(prompt: str, default: bool = True) -> bool:
    hint = "Y/n" if default else "y/N"
    while True:
        answer = ask(f"{prompt} ({hint})").lower()
        if not answer:
            return default
        if answer in ("y", "yes", "д", "да"):
            return True
        if answer in ("n", "no", "н", "нет"):
            return False
        print("  ответьте y или n")


def clean_path(raw: str) -> str:
    """Убирает кавычки, которые добавляет перетаскивание папки в терминал."""
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
        raw = raw[1:-1]
    if raw.startswith("file://"):
        raw = raw[len("file://"):]
    return raw


def cmd_wizard(_args: argparse.Namespace) -> int:
    """Пошаговая установка: запрашивает путь проекта и параметры."""
    print(f"agent-kit {KIT_VERSION}: установка агентской обвязки в проект")
    print("OMO, Mempalace, project-memory и правила агентов. Ctrl+C — отмена.\n")
    example = r"C:\work\my-project" if IS_WINDOWS else "~/work/my-project"
    while True:
        raw = clean_path(ask(f"Путь к каталогу проекта (например, {example})"))
        if not raw:
            print("  путь не указан")
            continue
        project = Path(os.path.expandvars(raw)).expanduser().resolve()
        if project == KIT_DIR:
            print("  это каталог самого комплекта; укажите каталог проекта")
            continue
        if project.exists() and not project.is_dir():
            print(f"  {project} существует и не является каталогом")
            continue
        if not project.exists() and not ask_yes(f"  Каталог {project} не существует. Создать?"):
            continue
        break

    state = load_state(project / ".agent-kit.json")
    if state:
        print(f"  В проекте уже установлен agent-kit {state.get('kitVersion', '?')} "
              f"(крыло {state.get('wing')}): будет выполнено обновление.")
        name, wing = state.get("name") or project.name, state.get("wing") or slug_wing(project.name)
    else:
        name = ask("Имя проекта", project.name)
        while True:
            wing = ask("Крыло Mempalace (a-z, 0-9, _)",
                       slug_wing(name) or slug_wing(project.name) or "project")
            if re.fullmatch(r"[a-z0-9][a-z0-9_]{0,63}", wing):
                break
            print("  допустимы строчные латинские буквы, цифры и _, начиная с буквы или цифры")
    omo = ask("Плагин OMO для opencode.json (none — не подключать)", DEFAULT_OMO)
    local = ask_yes("Отдельное окружение Mempalace внутри проекта (~430 МБ)? "
                    "Нет — одно общее окружение для всех проектов", default=False)

    jev = ask_yes("Слой решений Jev (плагин OpenCode, по умолчанию выключен; нужен ключ ApiClo)?")
    argv = ["install", str(project), "--name", name, "--wing", wing, "--omo", omo,
            "--venv", "local" if local else "shared"] + ([] if jev else ["--no-jev"])
    wheels = KIT_DIR / "wheels"
    if wheels.is_dir() and any(wheels.glob("*.whl")):
        argv += ["--wheelhouse", str(wheels)]
        print(f"  Найден каталог пакетов {wheels}: установка без обращения к PyPI.")

    print("\nБудет выполнено:")
    print(f"  проект:     {project}")
    print(f"  имя:        {name}")
    print(f"  крыло:      {wing}")
    print(f"  OMO:        {omo}")
    print(f"  окружение:  {'в проекте (.venv-mempalace)' if local else default_venv_dir()}")
    print(f"  Jev:        {'да (режим off до scripts/jev on|shadow)' if jev else 'нет'}")
    print("  Существующие файлы проекта не перезаписываются; измененные файлы сохраняются как *.bak-<время>.")
    if not ask_yes("\nПродолжить?"):
        print("Отменено, изменения не вносились.")
        return 0
    print()
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


def cmd_probe(args: argparse.Namespace) -> int:
    project = Path(args.project).resolve()
    state = load_state(project / ".agent-kit.json")
    wing = args.wing or state.get("wing")
    if not wing:
        raise KitError("не удалось определить крыло: укажите --wing")
    probe(project, wing, args.query, None)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="kit.py", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("wizard", help="пошаговая установка с вопросами")
    p.set_defaults(func=cmd_wizard)

    p = sub.add_parser("install", help="установка обвязки в проект",
                       description="Установка или обновление agent-kit в каталоге проекта. "
                                   "Повторный запуск безопасен: файлы проекта не перезаписываются, "
                                   "управляемые блоки и скрипты обновляются с резервной копией.")
    p.add_argument("target", help="каталог проекта (создается при отсутствии)")
    p.add_argument("--name", help="имя проекта (по умолчанию имя каталога)")
    p.add_argument("--wing", help="крыло Mempalace (по умолчанию имя в snake_case)")
    p.add_argument("--omo", default=DEFAULT_OMO, help=f"плагин OMO (по умолчанию {DEFAULT_OMO}; none — не подключать)")
    p.add_argument("--venv", choices=("shared", "local"), default="shared",
                   help="общее окружение Mempalace для всех проектов или собственное в .venv-mempalace")
    p.add_argument("--venv-dir", help=f"каталог общего окружения (по умолчанию {default_venv_dir()})")
    p.add_argument("--python", help="Python 3.12+ для создания окружения")
    p.add_argument("--wheelhouse", help="офлайн-установка пакетов из каталога wheel-файлов")
    p.add_argument("--no-mempalace", action="store_true", help="не устанавливать Mempalace (только файлы)")
    p.add_argument("--no-jev", action="store_true", help="не устанавливать слой решений Jev")
    p.add_argument("--only", metavar="КОМПОНЕНТЫ",
                   help=f"установить только перечисленные компоненты через запятую ({', '.join(COMPONENTS)}); "
                        "например --only jev для проекта с собственной обвязкой")
    p.add_argument("--skip-probe", action="store_true", help="не проверять MCP-сервер после установки")
    p.add_argument("--dry-run", action="store_true", help="показать действия без изменений")
    p.set_defaults(func=cmd_install)

    p = sub.add_parser("probe", help="проверка MCP-сервера Mempalace проекта")
    p.add_argument("project")
    p.add_argument("--wing")
    p.add_argument("--query", default="подключение проекта к Mempalace")
    p.set_defaults(func=cmd_probe)
    return parser


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except AttributeError:
            pass
    args = build_parser().parse_args()
    try:
        return args.func(args)
    except KeyboardInterrupt:
        print("\nПрервано пользователем.", file=sys.stderr)
        return 130
    except KitError as exc:
        print(f"ошибка: {exc}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as exc:
        print(f"ошибка: команда завершилась с кодом {exc.returncode}: {' '.join(map(str, exc.cmd))}",
              file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
