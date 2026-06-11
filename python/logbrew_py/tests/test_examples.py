from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from logbrew_sdk.examples import __main__ as examples_main

REPO_ROOT = Path(__file__).resolve().parents[3]


def run_repo_example(relative_path: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    existing_pythonpath = env.get("PYTHONPATH")
    src_path = str(REPO_ROOT / "python/logbrew_py/src")
    env["PYTHONPATH"] = src_path if not existing_pythonpath else f"{src_path}:{existing_pythonpath}"
    return subprocess.run(
        [sys.executable, str(REPO_ROOT / relative_path)],
        check=True,
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        env=env,
    )


def run_repo_module(*args: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    existing_pythonpath = env.get("PYTHONPATH")
    src_path = str(REPO_ROOT / "python/logbrew_py/src")
    env["PYTHONPATH"] = src_path if not existing_pythonpath else f"{src_path}:{existing_pythonpath}"
    return subprocess.run(
        [sys.executable, "-m", "logbrew_sdk.examples", *args],
        check=True,
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        env=env,
    )


def run_repo_python_module(module_name: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    existing_pythonpath = env.get("PYTHONPATH")
    src_path = str(REPO_ROOT / "python/logbrew_py/src")
    env["PYTHONPATH"] = src_path if not existing_pythonpath else f"{src_path}:{existing_pythonpath}"
    return subprocess.run(
        [sys.executable, "-m", module_name],
        check=True,
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        env=env,
    )


class LogBrewExamplesEntrypointTests(unittest.TestCase):
    def test_list_outputs_packaged_example_names(self) -> None:
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            exit_code = examples_main.main(["--list"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            stdout.getvalue().splitlines(),
            [
                "agent-timeline -> python -m logbrew_sdk.examples agent-timeline",
                "readme-example -> python -m logbrew_sdk.examples readme-example",
                "real-user-smoke -> python -m logbrew_sdk.examples real-user-smoke",
                "default (real-user-smoke) -> python -m logbrew_sdk.examples",
            ],
        )

    def test_default_runs_real_user_smoke(self) -> None:
        with patch("logbrew_sdk.examples.real_user_smoke.main", return_value=0) as runner:
            exit_code = examples_main.main([])

        self.assertEqual(exit_code, 0)
        runner.assert_called_once_with()

    def test_named_readme_example_runs_requested_example(self) -> None:
        with patch("logbrew_sdk.examples.readme_example.main", return_value=0) as runner:
            exit_code = examples_main.main(["readme-example"])

        self.assertEqual(exit_code, 0)
        runner.assert_called_once_with()

    def test_help_outputs_packaged_examples_usage(self) -> None:
        stdout = io.StringIO()
        with self.assertRaises(SystemExit) as ctx, redirect_stdout(stdout):
            examples_main.main(["--help"])

        self.assertEqual(ctx.exception.code, 0)
        output = stdout.getvalue()
        self.assertIn("Run the packaged LogBrew SDK examples", output)
        self.assertIn("--list", output)
        self.assertIn("{agent-timeline,readme-example,real-user-smoke}", output)
        self.assertIn("Packaged examples:", output)
        self.assertIn(
            "agent-timeline -> python -m logbrew_sdk.examples agent-timeline",
            output,
        )
        self.assertIn(
            "readme-example -> python -m logbrew_sdk.examples readme-example",
            output,
        )
        self.assertIn(
            "real-user-smoke -> python -m logbrew_sdk.examples real-user-smoke",
            output,
        )
        self.assertIn(
            "default (real-user-smoke) -> python -m logbrew_sdk.examples",
            output,
        )

    def test_repo_checkout_readme_example_script_runs(self) -> None:
        result = run_repo_example("python/logbrew_py/examples/readme_example.py")

        payload = json.loads(result.stdout)
        self.assertEqual(
            [event["type"] for event in payload["events"]],
            ["release", "environment", "issue", "log", "span", "action"],
        )
        self.assertEqual(
            json.loads(result.stderr),
            {"ok": True, "status": 202, "attempts": 1, "events": 6},
        )

    def test_repo_checkout_examples_module_help_runs(self) -> None:
        result = run_repo_module("--help")

        self.assertIn("Run the packaged LogBrew SDK examples", result.stdout)
        self.assertIn("--list", result.stdout)
        self.assertIn("readme-example -> python -m logbrew_sdk.examples readme-example", result.stdout)
        self.assertIn("default (real-user-smoke) -> python -m logbrew_sdk.examples", result.stdout)
        self.assertEqual(result.stderr, "")

    def test_repo_checkout_examples_module_list_runs(self) -> None:
        result = run_repo_module("--list")

        self.assertEqual(
            result.stdout.splitlines(),
            [
                "agent-timeline -> python -m logbrew_sdk.examples agent-timeline",
                "readme-example -> python -m logbrew_sdk.examples readme-example",
                "real-user-smoke -> python -m logbrew_sdk.examples real-user-smoke",
                "default (real-user-smoke) -> python -m logbrew_sdk.examples",
            ],
        )
        self.assertEqual(result.stderr, "")

    def test_repo_checkout_examples_module_default_runs(self) -> None:
        result = run_repo_module()

        payload = json.loads(result.stdout)
        self.assertEqual(
            [event["type"] for event in payload["events"]],
            ["release", "environment", "issue", "log", "span", "action"],
        )
        self.assertEqual(
            json.loads(result.stderr),
            {"ok": True, "status": 202, "attempts": 1, "events": 6},
        )

    def test_repo_checkout_examples_module_named_readme_example_runs(self) -> None:
        result = run_repo_module("readme-example")

        payload = json.loads(result.stdout)
        self.assertEqual(
            [event["type"] for event in payload["events"]],
            ["release", "environment", "issue", "log", "span", "action"],
        )
        self.assertEqual(
            json.loads(result.stderr),
            {"ok": True, "status": 202, "attempts": 1, "events": 6},
        )

    def test_repo_checkout_examples_module_named_real_user_smoke_runs(self) -> None:
        result = run_repo_module("real-user-smoke")

        payload = json.loads(result.stdout)
        self.assertEqual(
            [event["type"] for event in payload["events"]],
            ["release", "environment", "issue", "log", "span", "action"],
        )
        self.assertEqual(
            json.loads(result.stderr),
            {"ok": True, "status": 202, "attempts": 1, "events": 6},
        )

    def test_repo_checkout_examples_module_named_agent_timeline_runs(self) -> None:
        result = run_repo_module("agent-timeline")

        payload = json.loads(result.stdout)
        self.assertEqual([event["type"] for event in payload["events"]], ["action", "action"])
        self.assertEqual(
            [event["attributes"]["metadata"]["source"] for event in payload["events"]],
            ["product.action", "network.milestone"],
        )
        output_text = result.stdout
        self.assertNotIn("private@example.test", output_text)
        self.assertNotIn("card", output_text)
        self.assertNotIn("authorization", output_text)
        self.assertEqual(
            json.loads(result.stderr),
            {
                "ok": True,
                "status": 202,
                "attempts": 1,
                "events": 2,
                "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            },
        )

    def test_repo_checkout_real_user_smoke_script_runs(self) -> None:
        result = run_repo_example("python/logbrew_py/examples/real_user_smoke.py")

        payload = json.loads(result.stdout)
        self.assertEqual(
            [event["type"] for event in payload["events"]],
            ["release", "environment", "issue", "log", "span", "action"],
        )
        self.assertEqual(
            json.loads(result.stderr),
            {"ok": True, "status": 202, "attempts": 1, "events": 6},
        )

    def test_repo_checkout_readme_example_module_runs(self) -> None:
        result = run_repo_python_module("logbrew_sdk.examples.readme_example")

        payload = json.loads(result.stdout)
        self.assertEqual(
            [event["type"] for event in payload["events"]],
            ["release", "environment", "issue", "log", "span", "action"],
        )
        self.assertEqual(
            json.loads(result.stderr),
            {"ok": True, "status": 202, "attempts": 1, "events": 6},
        )

    def test_repo_checkout_real_user_smoke_module_runs(self) -> None:
        result = run_repo_python_module("logbrew_sdk.examples.real_user_smoke")

        payload = json.loads(result.stdout)
        self.assertEqual(
            [event["type"] for event in payload["events"]],
            ["release", "environment", "issue", "log", "span", "action"],
        )
        self.assertEqual(
            json.loads(result.stderr),
            {"ok": True, "status": 202, "attempts": 1, "events": 6},
        )


if __name__ == "__main__":
    unittest.main()
