"""Проверки компонентов установщика и безопасного обновления профиля OMO."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import subprocess
from pathlib import Path
from unittest.mock import patch
import tempfile
import unittest

KIT_ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("kit", KIT_ROOT / "lib" / "kit.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Не найден модуль установщика")
kit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(kit)


class OmoProfileTests(unittest.TestCase):
    def test_jsonc_preserves_string_literals(self):
        raw = '''// комментарий
        {"url": "https://example.org/a", "prompt": "сохранить ,} и ,]", /* пояснение */
         "escaped": "кавычка \\\" // строка", "items": [1, 2,],}
        '''
        parsed = json.loads(kit.strip_jsonc(raw))
        self.assertEqual(parsed["prompt"], "сохранить ,} и ,]")
        self.assertEqual(parsed["url"], "https://example.org/a")
        self.assertEqual(parsed["escaped"], 'кавычка " // строка')
        self.assertEqual(parsed["items"], [1, 2])

    def test_jsonc_rejects_unclosed_comment(self):
        with self.assertRaises(kit.KitError):
            kit.strip_jsonc('{"agents": {}} /* незакрытый комментарий')

    def test_existing_values_and_arrays_win(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            path = project / ".omo" / "omo.jsonc"
            path.parent.mkdir()
            original = {
                "[opencode]": {
                    "agents": {"sisyphus": {
                        "model": "local/custom",
                        "fallback_models": [],
                        "prompt_append": "Свои правила",
                    }},
                    "categories": {"quick": {"models": [{"model": "local/quick"}]}},
                },
                "_migrations": ["local-migration"],
            }
            raw = "\ufeff// мои настройки\r\n" + json.dumps(original, ensure_ascii=False) + "\r\n"
            path.write_bytes(raw.encode("utf-8"))
            kit.merge_omo(project, [KIT_ROOT / "template/omo/profile.json",
                                    KIT_ROOT / "template/spec/omo-roles.json"])
            updated = json.loads(kit.strip_jsonc(kit.read_text(path).lstrip("\ufeff")))
            agents = updated["[opencode]"]["agents"]
            self.assertEqual(agents["sisyphus"]["model"], "local/custom")
            self.assertEqual(agents["sisyphus"]["fallback_models"], [])
            self.assertEqual(agents["sisyphus"]["prompt_append"], "Свои правила")
            self.assertEqual(updated["[opencode]"]["categories"]["quick"]["models"],
                             [{"model": "local/quick"}])
            self.assertEqual(updated["_migrations"], ["local-migration"])
            self.assertEqual(len(agents), 11)
            self.assertIn("prompt_append", agents["prometheus"])
            self.assertEqual(path.with_name(f"omo.jsonc.bak-{kit.STAMP}").read_bytes(), raw.encode("utf-8"))
            self.assertTrue(path.read_bytes().startswith(b"\xef\xbb\xbf"))
            self.assertIn(b"\r\n", path.read_bytes())

    def test_repeated_merge_does_not_rewrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            layers = [KIT_ROOT / "template/omo/profile.json", KIT_ROOT / "template/spec/omo-roles.json"]
            kit.merge_omo(project, layers)
            path = project / ".omo" / "omo.jsonc"
            before = path.read_bytes()
            kit.merge_omo(project, layers)
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(list(path.parent.glob("*.bak-*")), [])

    def test_dry_run_does_not_create_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "new"
            kit.DRY_RUN = True
            try:
                kit.merge_omo(project, [KIT_ROOT / "template/omo/profile.json"])
            finally:
                kit.DRY_RUN = False
            self.assertFalse(project.exists())


class InstallerComponentTests(unittest.TestCase):
    def test_install_spec_checks_only_document_structure(self):
        variables = {
            "KIT_VERSION": kit.KIT_VERSION,
            "FOCUSED_SPEC_VERSION": kit.FOCUSED_SPEC_VERSION,
            "PROJECT_NAME": "Проверка установки", "WING": "install_check",
        }
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            with patch.object(kit, "node_tools", return_value=("node", "npm")), \
                 patch.object(kit.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "", "")) as run, \
                 contextlib.redirect_stdout(io.StringIO()):
                kit.install_spec(project, variables, check=True)
            commands = [call.args[0] for call in run.call_args_list]
            self.assertEqual(commands, [
                ["npm", "install", "--no-audit", "--no-fund", "--loglevel=error"],
                ["node", str(project / "node_modules/focused-spec/dist/cli.js"), "validate", "--syntax-only"],
            ])
            # Проверка структуры не заменяет полную валидацию по явной команде проекта.
            package = json.loads((project / "package.json").read_text(encoding="utf-8"))
            self.assertEqual(package["scripts"]["spec:validate"], "focused-spec validate")
            self.assertNotIn("test:runners", package["scripts"])
            self.assertFalse((project / ".focused-spec/runners").exists())
            config = (project / ".focused-spec/config.yaml").read_text(encoding="utf-8")
            self.assertIn("runners: {}", config)
            self.assertNotIn("dotnet-xunit:", config)
            examples = project / ".opencode/skills/focused-spec/references/runner-templates/.focused-spec/runners"
            self.assertTrue((examples / "dotnet-xunit.ts").exists())
            self.assertTrue((examples / "py-unittest.ts").exists())

    def test_install_spec_preserves_existing_runner_and_project_settings(self):
        variables = {
            "KIT_VERSION": kit.KIT_VERSION,
            "FOCUSED_SPEC_VERSION": kit.FOCUSED_SPEC_VERSION,
            "PROJECT_NAME": "Проверка обновления", "WING": "upgrade_check",
        }
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            runner = project / ".focused-spec/runners/custom.ts"
            runner.parent.mkdir(parents=True)
            runner.write_text("// Проектный адаптер.\n", encoding="utf-8")
            config = project / ".focused-spec/config.yaml"
            original_config = "version: 2\nrunners:\n  custom:\n    module: ./.focused-spec/runners/custom.ts\n"
            config.write_text(original_config, encoding="utf-8")
            package = project / "package.json"
            package.write_text(json.dumps({"scripts": {"test:runners": "node custom-tests.js"}}), encoding="utf-8")
            with patch.object(kit, "node_tools", return_value=None), contextlib.redirect_stdout(io.StringIO()):
                kit.install_spec(project, variables, check=True)
            self.assertEqual(runner.read_text(encoding="utf-8"), "// Проектный адаптер.\n")
            self.assertEqual(config.read_text(encoding="utf-8"), original_config)
            self.assertEqual(json.loads(package.read_text(encoding="utf-8"))["scripts"]["test:runners"],
                             "node custom-tests.js")

    def test_components_and_default_installation(self):
        self.assertEqual(kit.COMPONENTS, ("base", "spec"))
        self.assertEqual(kit.parse_components("spec,base,spec"), ("spec", "base"))
        with self.assertRaises(kit.KitError):
            kit.parse_components("unsupported")
        for options, expected in (([], ["base", "spec"]),
                                  (["--no-spec"], ["base"]),
                                  (["--no-spec", "--only", "spec"], ["spec"])):
            with self.subTest(options=options), tempfile.TemporaryDirectory() as tmp:
                project = Path(tmp)
                args = kit.build_parser().parse_args([
                    "install", str(project), "--no-mempalace", "--skip-probe", *options,
                ])
                with patch.object(kit, "install_base") as base, \
                     patch.object(kit, "install_spec") as spec, \
                     contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(args.func(args), 0)
                self.assertEqual(base.call_count, int("base" in expected))
                self.assertEqual(spec.call_count, int("spec" in expected))
                state = json.loads((project / ".agent-kit.json").read_text(encoding="utf-8"))
                self.assertEqual(state["components"], expected)

    def test_wizard_dispatches_supported_components(self):
        with tempfile.TemporaryDirectory() as tmp:
            for use_spec in (True, False):
                answers = iter((tmp, "Проверка мастера", "wizard_check", "none"))
                with self.subTest(use_spec=use_spec), \
                     patch.object(kit, "ask", side_effect=lambda *args: next(answers)), \
                     patch.object(kit, "ask_yes", side_effect=[False, use_spec, True]) as ask_yes, \
                     patch.object(kit, "cmd_install", return_value=0) as install, \
                     contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(kit.cmd_wizard(None), 0)
                self.assertEqual(ask_yes.call_count, 3)
                args = install.call_args.args[0]
                self.assertEqual(args.no_spec, not use_spec)
                self.assertEqual(args.omo, "none")
                self.assertEqual(args.venv, "shared")


if __name__ == "__main__":
    unittest.main()
