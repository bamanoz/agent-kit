"""Фикстура для проверки runner'а py-unittest."""

import unittest


class SampleTests(unittest.TestCase):
    def test_pass(self) -> None:
        print("FOCUSED_SPEC_RESULT не JSON: вывод теста не должен ломать разбор")
        self.assertEqual(1 + 1, 2)

    def test_fail(self) -> None:
        self.assertEqual(1, 2, "намеренный отказ фикстуры")

    def test_skip(self) -> None:
        self.skipTest("намеренный пропуск фикстуры")


class OtherTests(unittest.TestCase):
    def test_other(self) -> None:
        self.assertTrue(True)


class BrokenTeardownTests(unittest.TestCase):
    """Тест проходит, но tearDownClass падает: выбранный тест не должен получить PASS."""

    @classmethod
    def tearDownClass(cls) -> None:
        raise RuntimeError("сбой tearDownClass")

    def test_ok(self) -> None:
        self.assertTrue(True)
