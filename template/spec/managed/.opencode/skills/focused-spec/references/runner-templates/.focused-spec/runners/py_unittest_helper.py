"""Вспомогательный скрипт runner'а py-unittest для focused-spec.

Режимы:
  list <id>...  — проверяет, что каждый id загружается ровно в один тест;
  run <id>...   — выполняет ровно указанные тесты и печатает их исход.

Машиночитаемые строки начинаются с маркеров FOCUSED_SPEC_LIST / FOCUSED_SPEC_RESULT
и печатаются в stdout; собственный вывод тестов перенаправляется в stderr.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
import unittest
from typing import TextIO

LIST_MARKER = "FOCUSED_SPEC_LIST"
RESULT_MARKER = "FOCUSED_SPEC_RESULT"
DETAIL_LIMIT = 4000

_marker_stream: TextIO | None = None


def _isolate_stdout() -> None:
    """Отводит fd 1 под маркеры, а любой вывод тестов направляет в stderr.

    Так вывод тестов (включая дочерние процессы) не может подделать строку
    с маркером.
    """
    global _marker_stream  # noqa: PLW0603
    sys.stdout.flush()
    marker_fd = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    _marker_stream = os.fdopen(marker_fd, "w", encoding="utf-8")


def _emit(marker: str, payload: dict[str, object]) -> None:
    stream = _marker_stream if _marker_stream is not None else sys.stdout
    stream.write(marker + " " + json.dumps(payload, ensure_ascii=False) + "\n")
    stream.flush()


def _bounded(text: str) -> str:
    return text if len(text) <= DETAIL_LIMIT else text[:DETAIL_LIMIT] + "…"


def _flatten(suite: unittest.TestSuite | unittest.TestCase) -> list[unittest.TestCase]:
    if isinstance(suite, unittest.TestSuite):
        result: list[unittest.TestCase] = []
        for item in suite:
            result.extend(_flatten(item))
        return result
    return [suite]


def _load_exact(test_id: str) -> tuple[unittest.TestCase | None, str]:
    """Загружает тест по id; возвращает (тест, '') или (None, сообщение)."""
    try:
        loaded = unittest.defaultTestLoader.loadTestsFromName(test_id)
    except Exception as error:  # noqa: BLE001 — любая ошибка загрузки означает неразрешенный селектор
        return None, _bounded(f"ошибка загрузки «{test_id}»: {error!r}")
    tests = _flatten(loaded)
    # Загрузчик сообщает об ошибке импорта через синтетический тест _FailedTest.
    failed = [t for t in tests if type(t).__name__ == "_FailedTest"]
    if failed:
        return None, _bounded(f"ошибка загрузки «{test_id}»: {getattr(failed[0], '_exception', 'неизвестная ошибка')}")
    if not tests:
        return None, f"по «{test_id}» не найдено ни одного теста"
    if len(tests) > 1:
        return None, f"«{test_id}» выбирает несколько тестов ({len(tests)}); укажите метод теста"
    if tests[0].id() != test_id:
        return None, f"«{test_id}» разрешился в другой тест: «{tests[0].id()}»"
    return tests[0], ""


class _MarkerResult(unittest.TestResult):
    """Собирает исход каждого теста и печатает строку с маркером.

    Ошибка fixture (setUpClass, tearDownClass, setUpModule, tearDownModule) приходит от
    синтетического _ErrorHolder с id вида «tearDownClass (модуль.Класс)». Она относится ко всем
    выбранным тестам этого класса или модуля, иначе успешный тест получил бы PASS при упавшей fixture.
    """

    def __init__(self, ids: list[str]) -> None:
        super().__init__()
        self.ids = ids

    def _owners(self, holder_id: str) -> list[str]:
        scope = holder_id[holder_id.find("(") + 1:holder_id.rfind(")")] if "(" in holder_id else ""
        owners = [i for i in self.ids if scope and (i.startswith(scope + ".") or i == scope)]
        return owners or list(self.ids)

    def _report(self, test: unittest.TestCase, outcome: str, detail: str) -> None:
        if type(test).__name__ == "_ErrorHolder":
            for owner in self._owners(test.id()):
                _emit(RESULT_MARKER, {"id": owner, "outcome": "error",
                                      "detail": _bounded(f"ошибка fixture {test.id()}: {detail}")})
            return
        _emit(RESULT_MARKER, {"id": test.id(), "outcome": outcome, "detail": _bounded(detail)})

    def addSuccess(self, test: unittest.TestCase) -> None:  # noqa: N802
        super().addSuccess(test)
        self._report(test, "success", "")

    def addFailure(self, test, err) -> None:  # noqa: N802, ANN001
        super().addFailure(test, err)
        self._report(test, "failure", self.failures[-1][1])

    def addError(self, test, err) -> None:  # noqa: N802, ANN001
        super().addError(test, err)
        self._report(test, "error", self.errors[-1][1])

    def addSkip(self, test, reason) -> None:  # noqa: N802, ANN001
        super().addSkip(test, reason)
        self._report(test, "skipped", str(reason))

    def addExpectedFailure(self, test, err) -> None:  # noqa: N802, ANN001
        super().addExpectedFailure(test, err)
        self._report(test, "failure", "ожидаемый отказ (expectedFailure) не считается прохождением")

    def addUnexpectedSuccess(self, test) -> None:  # noqa: N802, ANN001
        super().addUnexpectedSuccess(test)
        self._report(test, "failure", "неожиданный успех теста с expectedFailure")

    def addSubTest(self, test, subtest, err) -> None:  # noqa: ANN001
        super().addSubTest(test, subtest, err)
        if err is not None:
            # Отказ подтеста — отказ всего выбранного теста.
            detail = "".join(traceback.format_exception(*err))
            outcome = "failure" if issubclass(err[0], test.failureException) else "error"
            self._report(test, outcome, f"подтест {subtest.id()}: {detail}")


def _cmd_list(ids: list[str]) -> int:
    for test_id in ids:
        test, message = _load_exact(test_id)
        _emit(LIST_MARKER, {"id": test_id, "ok": test is not None, "message": message})
    return 0


def _cmd_run(ids: list[str]) -> int:
    suite = unittest.TestSuite()
    for test_id in ids:
        test, message = _load_exact(test_id)
        if test is None:
            _emit(RESULT_MARKER, {"id": test_id, "outcome": "error", "detail": message})
            continue
        suite.addTest(test)
    suite.run(_MarkerResult(ids))
    return 0


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[0] not in ("list", "run"):
        sys.stderr.write("использование: py_unittest_helper.py list|run <id>...\n")
        return 2
    sys.path.insert(0, ".")
    _isolate_stdout()
    return _cmd_list(argv[1:]) if argv[0] == "list" else _cmd_run(argv[1:])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
