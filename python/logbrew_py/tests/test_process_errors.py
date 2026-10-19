from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
import textwrap
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, ClassVar

from logbrew_sdk import LogBrewClient, RecordingTransport, SdkError, install_process_error_capture

SRC_PATH = str(Path(__file__).resolve().parents[1] / "src")


class _Intake(BaseHTTPRequestHandler):
    batches: ClassVar[list[dict[str, Any]]] = []

    def do_POST(self) -> None:
        length = int(self.headers["content-length"])
        type(self).batches.append(json.loads(self.rfile.read(length)))
        self.send_response(202)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, format: str, *args: Any) -> None:
        return


def run_app(body: str, endpoint: str, flush_timeout: float = 2.0) -> subprocess.CompletedProcess[str]:
    source = textwrap.dedent(
        f"""
        import threading
        from logbrew_sdk import HttpTransport, LogBrewClient, install_process_error_capture
        client = LogBrewClient.create(
            api_key="lb_test_key",
            sdk_name="logbrew-python-process-test",
            sdk_version="0.1.0",
            transport=HttpTransport(endpoint={endpoint!r}, timeout=5),
            automatic_delivery=False,
            max_retries=0,
        )
        install_process_error_capture(client, flush_timeout_seconds={flush_timeout!r})
        """
    ) + textwrap.dedent(body)
    env = {**os.environ, "PYTHONPATH": SRC_PATH}
    return subprocess.run(
        [sys.executable, "-c", source], capture_output=True, text=True, env=env, timeout=60, check=False
    )


class ProcessErrorCaptureTests(unittest.TestCase):
    server: ClassVar[ThreadingHTTPServer]
    endpoint: ClassVar[str]

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Intake)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.endpoint = f"http://127.0.0.1:{cls.server.server_address[1]}/v1/events"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self) -> None:
        _Intake.batches.clear()

    def issues(self) -> list[dict[str, Any]]:
        return [event for batch in _Intake.batches for event in batch["events"] if event["type"] == "issue"]

    def test_uncaught_exception_is_delivered_and_python_still_exits_with_its_traceback(self) -> None:
        result = run_app(
            """
            def charge(total):
                raise ValueError(f"checkout total {total} rejected")
            charge(42)
            """,
            self.endpoint,
        )

        self.assertEqual(result.returncode, 1)
        self.assertIn("Traceback (most recent call last)", result.stderr)
        self.assertIn("ValueError: checkout total 42 rejected", result.stderr)
        [issue] = self.issues()
        attributes = issue["attributes"]
        self.assertEqual(attributes["level"], "critical")
        self.assertEqual(
            attributes["exception"],
            {"type": "ValueError", "mechanism": {"type": "python.excepthook", "handled": False}},
        )
        self.assertEqual(attributes["stackFrames"][0]["function"], "charge")
        self.assertEqual(attributes["context"]["resource"]["runtime"]["name"], platform.python_implementation())

    def test_thread_crash_is_reported_and_the_process_keeps_running(self) -> None:
        result = run_app(
            """
            def worker():
                raise RuntimeError("background sync failed")
            thread = threading.Thread(target=worker)
            thread.start()
            thread.join()
            print("main thread still running")
            """,
            self.endpoint,
        )

        self.assertEqual(result.returncode, 0)
        self.assertIn("main thread still running", result.stdout)
        self.assertIn("RuntimeError: background sync failed", result.stderr)
        [issue] = self.issues()
        self.assertEqual(issue["attributes"]["level"], "error")
        self.assertEqual(issue["attributes"]["exception"]["mechanism"]["type"], "python.threading_excepthook")

    def test_keyboard_interrupt_is_not_reported(self) -> None:
        result = run_app("raise KeyboardInterrupt\n", self.endpoint)

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.issues(), [])

    def test_unreachable_intake_delays_exit_by_at_most_the_flush_timeout(self) -> None:
        started = time.monotonic()
        result = run_app('raise ValueError("intake down")\n', "http://192.0.2.1:9/v1/events", flush_timeout=0.3)

        self.assertEqual(result.returncode, 1)
        self.assertIn("ValueError: intake down", result.stderr)
        self.assertLess(time.monotonic() - started, 10)


class ProcessErrorCaptureInstallTests(unittest.TestCase):
    def client(self) -> LogBrewClient:
        return LogBrewClient.create(
            api_key="lb_test_key",
            sdk_name="logbrew-python-process-test",
            sdk_version="0.1.0",
            transport=RecordingTransport.always_accept(),
        )

    def test_install_once_and_uninstall_puts_previous_hooks_back(self) -> None:
        before = (sys.excepthook, threading.excepthook)
        capture = install_process_error_capture(self.client())
        try:
            self.assertIsNot(sys.excepthook, before[0])
            with self.assertRaisesRegex(SdkError, "already installed"):
                install_process_error_capture(self.client())
        finally:
            capture.uninstall()
        capture.uninstall()
        self.assertEqual((sys.excepthook, threading.excepthook), before)
        install_process_error_capture(self.client()).uninstall()

    def test_capture_failure_still_reaches_the_previous_hook(self) -> None:
        client = self.client()
        failures: list[BaseException] = []
        seen: list[BaseException] = []
        previous = sys.excepthook
        sys.excepthook = lambda _type, value, _traceback: seen.append(value)
        try:
            capture = install_process_error_capture(client, on_capture_error=failures.append)
            client.shutdown()
            error = ValueError("after shutdown")
            sys.excepthook(ValueError, error, None)
            capture.uninstall()
        finally:
            sys.excepthook = previous
        self.assertEqual(seen, [error])
        self.assertEqual(len(failures), 1)

    def test_invalid_configuration_is_rejected(self) -> None:
        for kwargs in ({"flush_timeout_seconds": 31}, {"flush_timeout_seconds": True}, {"transport": object()}):
            with self.subTest(kwargs=kwargs), self.assertRaises(SdkError):
                install_process_error_capture(self.client(), **kwargs)
        with self.assertRaises(SdkError):
            install_process_error_capture(object())  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
