#!/usr/bin/env python3
"""Переключатель слоя решений Jev для агентов OpenCode и отчеты для сравнения режимов.

Команды:
  on                      включить: решения Jev применяются
  shadow                  теневой режим: решения только журналируются, агент работает как без Jev
  off                     выключить: плагин ничего не делает (поведение как до внедрения Jev)
  status                  текущий режим, источник и наличие ключа провайдера
  report [--days N]       сводка журнала решений (по умолчанию за 7 дней)
  compare <ses_A> <ses_B> сравнить две сессии OpenCode с субагентами: токены, стоимость,
                          вызовы и объем вывода тулов, решения Jev
  eval [параметры]        оценка Jev по истории сессий проекта: ложные скрытия, экономия по
                          порогам, точность проверки субагентов, вердикт по каждой функции.
                          Модели агентов не вызываются, платный только Jev (~$0,001 за случай).
                          --limit N (300), --days N (45), --resume, --summary-only;
                          результат в .opencode/jev-eval/ (report.md, cases.jsonl)

Режим читается плагином перед каждым вызовом тула: перезапуск OpenCode не нужен.
Для одного запуска режим задается переменной окружения JEV_MODE=off|shadow|on.
Запуск: scripts/jev (Linux, macOS, WSL) или scripts\\jev (Windows).
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import os
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

MODES = ("off", "shadow", "on")


def project_root() -> Path:
    result = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    return Path(result.stdout.strip()) if result.returncode == 0 else Path.cwd()


ROOT = project_root()
MODE_FILE = ROOT / ".opencode" / "jev.mode"
SETTINGS_FILE = ROOT / ".opencode" / "jev.json"
LOG_DIR = ROOT / ".opencode" / "jev-log"


def data_home() -> Path:
    if os.environ.get("XDG_DATA_HOME"):
        return Path(os.environ["XDG_DATA_HOME"])
    return Path.home() / ".local" / "share"


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def file_mode() -> str:
    try:
        value = MODE_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return "off"
    return value if value in MODES else "off"


def cmd_set(mode: str) -> int:
    MODE_FILE.parent.mkdir(parents=True, exist_ok=True)
    MODE_FILE.write_text(mode + "\n", encoding="utf-8")
    print(f"режим Jev: {mode}")
    if mode != "off":
        warn_key()
    return 0


def provider() -> dict:
    defaults = {"apiKeyEnv": "APICLO_API_KEY", "opencodeAuth": "apiclo", "endpoint": "https://apiclo.com/v1/decisions"}
    configured = read_json(SETTINGS_FILE).get("provider")
    return {**defaults, **(configured if isinstance(configured, dict) else {})}


def key_source() -> str | None:
    settings = provider()
    if os.environ.get(settings["apiKeyEnv"], "").strip():
        return f"переменная {settings['apiKeyEnv']}"
    entry = read_json(data_home() / "opencode" / "auth.json").get(settings["opencodeAuth"])
    if isinstance(entry, dict) and entry.get("key"):
        return f"opencode auth: {settings['opencodeAuth']}"
    return None


def warn_key() -> None:
    if key_source() is None:
        settings = provider()
        print(f"внимание: ключ провайдера не найден — задайте {settings['apiKeyEnv']} или выполните "
              f"`opencode auth login` для {settings['opencodeAuth']}; без ключа плагин пишет ошибки и вывод не меняет")


def cmd_status() -> int:
    env_mode = os.environ.get("JEV_MODE", "").strip()
    if env_mode:
        effective = env_mode if env_mode in MODES else "off"
        print(f"режим Jev: {effective} (переменная JEV_MODE; файл: {file_mode()})")
    else:
        print(f"режим Jev: {file_mode()} (файл .opencode/jev.mode)")
    settings = provider()
    print(f"провайдер: {settings['endpoint']}, ключ: {key_source() or 'не найден'}")
    print(f"настройки проекта: {'.opencode/jev.json' if SETTINGS_FILE.exists() else 'значения комплекта'}")
    return 0


def load_log(since: str | None = None) -> list[dict]:
    rows: list[dict] = []
    for path in sorted(LOG_DIR.glob("*.jsonl")) if LOG_DIR.exists() else []:
        if since is not None and path.stem < since:
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rows.append(json.loads(line))
    return rows


def cmd_report(days: int) -> int:
    since = (dt.date.today() - dt.timedelta(days=days - 1)).isoformat()
    rows = load_log(since)
    if not rows:
        print(f"журнал решений Jev за {days} дн. пуст")
        return 0
    groups: dict[tuple[str, str], list[dict]] = collections.defaultdict(list)
    for row in rows:
        groups[(row["feature"], row["mode"])].append(row)
    print(f"Решения Jev за {days} дн. (с {since}), записей: {len(rows)}\n")
    print(f"{'функция':16} {'режим':7} {'всего':>6} {'примен.':>8} {'тень':>6} {'пропуск':>8} "
          f"{'ошибки':>7} {'симв. сэкон.':>13} {'Jev ток.':>9} {'Jev мс p50':>10}")
    for (feature, mode), items in sorted(groups.items()):
        by = collections.Counter(item["decision"] for item in items)
        saved = sum(item.get("beforeChars", 0) - item.get("afterChars", item.get("beforeChars", 0))
                    for item in items if item["decision"] in ("applied", "shadow"))
        tokens = sum(item.get("jevInputTokens", 0) for item in items)
        latencies = sorted(item["jevMs"] for item in items if "jevMs" in item)
        p50 = latencies[len(latencies) // 2] if latencies else 0
        print(f"{feature:16} {mode:7} {len(items):6} {by['applied']:8} {by['shadow']:6} {by['skipped']:8} "
              f"{by['error']:7} {saved:13} {tokens:9} {p50:10}")
    for title, decision in (("Причины ошибок", "error"), ("Причины пропуска", "skipped")):
        reasons = collections.Counter(row["reason"] for row in rows if row["decision"] == decision)
        if reasons:
            print(f"\n{title}: " + ", ".join(f"{reason}: {count}" for reason, count in reasons.most_common(8)))
    print("\nСимволы → токены: ~1,6 символа русского текста или ~3,5 символа кода на токен.")
    return 0


def session_tree(db: sqlite3.Connection, root: str) -> list[str]:
    """Сессия вместе со всеми субагентами (дочерние сессии по parent_id)."""
    ids, frontier = [root], [root]
    while frontier:
        marks = ",".join("?" * len(frontier))
        frontier = [row[0] for row in db.execute(f"select id from session where parent_id in ({marks})", frontier)]
        ids += frontier
    return ids


def session_stats(db: sqlite3.Connection, root: str, log: list[dict]) -> tuple[str, dict, collections.Counter, collections.Counter]:
    head = db.execute("select title from session where id = ?", [root]).fetchone()
    if head is None:
        raise SystemExit(f"ошибка: сессия {root} не найдена")
    ids = session_tree(db, root)
    marks = ",".join("?" * len(ids))
    totals: dict[str, float] = collections.defaultdict(float)
    for (raw,) in db.execute(f"select data from message where session_id in ({marks})", ids):
        info = json.loads(raw)
        if info.get("role") != "assistant":
            continue
        tokens = info.get("tokens") or {}
        cache = tokens.get("cache") or {}
        timing = info.get("time") or {}
        totals["запросов к модели"] += 1
        totals["входные токены"] += tokens.get("input", 0)
        totals["чтение кэша"] += cache.get("read", 0)
        totals["запись кэша"] += cache.get("write", 0)
        totals["выходные токены"] += tokens.get("output", 0)
        totals["стоимость, $"] += info.get("cost") or 0
        if timing.get("created") and timing.get("completed"):
            totals["время модели, с"] += (timing["completed"] - timing["created"]) / 1000
    tools: collections.Counter = collections.Counter()
    for (raw,) in db.execute(
            f"select data from part where session_id in ({marks}) and json_extract(data, '$.type') = 'tool'", ids):
        part = json.loads(raw)
        tools[part["tool"]] += 1
        totals["символов вывода тулов"] += len((part.get("state") or {}).get("output") or "")
    totals["вызовов тулов"] = sum(tools.values())
    totals["субагентов"] = len(ids) - 1
    members = set(ids)
    jev = collections.Counter(f"{row['feature']}:{row['decision']}" for row in log if row["session"] in members)
    return head[0], totals, tools, jev


def cmd_compare(first: str, second: str) -> int:
    path = data_home() / "opencode" / "opencode.db"
    if not path.exists():
        raise SystemExit(f"ошибка: база OpenCode не найдена: {path}")
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    log = load_log()
    results = [session_stats(db, session, log) for session in (first, second)]
    keys = list(dict.fromkeys(key for _, totals, _, _ in results for key in totals))
    print(f"{'показатель':24} {'A':>16} {'B':>16} {'B/A':>7}")
    for key in keys:
        a, b = results[0][1].get(key, 0), results[1][1].get(key, 0)
        ratio = f"{b / a:.2f}" if a else "—"
        fmt = (lambda v: f"{v:.3f}") if key in ("стоимость, $", "время модели, с") else (lambda v: f"{int(v)}")
        print(f"{key:24} {fmt(a):>16} {fmt(b):>16} {ratio:>7}")
    for label, session, (title, _, tools, jev) in zip("AB", (first, second), results):
        print(f"\n{label}: {session} — {title}")
        print("  тулы: " + ", ".join(f"{name} {count}" for name, count in tools.most_common(8)))
        print("  решения Jev: " + (", ".join(f"{name} {count}" for name, count in sorted(jev.items())) or "нет"))
    return 0


def cmd_eval(extra: list[str]) -> int:
    runner = ROOT / ".opencode" / "jev" / "eval" / "run.ts"
    if not runner.exists():
        raise SystemExit(f"ошибка: нет {runner}; переустановите компонент jev")
    node = shutil.which("node")
    if node is None:
        raise SystemExit("ошибка: для eval нужен Node.js 22.18+ (TypeScript и node:sqlite)")
    command = [node, "--no-warnings", str(runner), "--root", str(ROOT), *extra]
    return subprocess.run(command, cwd=ROOT).returncode


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except AttributeError:
            pass
    parser = argparse.ArgumentParser(prog="scripts/jev", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for mode in MODES:
        sub.add_parser(mode, help=f"установить режим {mode}")
    sub.add_parser("status", help="текущий режим")
    report = sub.add_parser("report", help="сводка журнала решений")
    report.add_argument("--days", type=int, default=7)
    compare = sub.add_parser("compare", help="сравнение двух сессий")
    compare.add_argument("first")
    compare.add_argument("second")
    sub.add_parser("eval", help="оценка Jev по истории сессий", add_help=False)
    if len(sys.argv) > 1 and sys.argv[1] == "eval":
        return cmd_eval(sys.argv[2:])
    args = parser.parse_args()
    if args.command in MODES:
        return cmd_set(args.command)
    if args.command == "status":
        return cmd_status()
    if args.command == "report":
        return cmd_report(max(args.days, 1))
    return cmd_compare(args.first, args.second)


if __name__ == "__main__":
    sys.exit(main())
