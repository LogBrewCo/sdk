"""Automatic delivery sends pending events when the interpreter exits normally."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, ClassVar

SRC_PATH = str(Path(__file__).resolve().parents[1] / "src")


class _Intake(BaseHTTPRequestHandler):
    batches: ClassVar[list[dict[str, Any]]] = []
    delay_seconds: ClassVar[float] = 0.0

    def do_POST(self) -> None:
        length = int(self.headers["content-length"])
        type(self).batches.append(json.loads(self.rfile.read(length)))
        time.sleep(type(self).delay_seconds)
        self.send_response(202)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, format: str, *args: Any) -> None:
        return


def run_app(body: str, endpoint: str) -> subprocess.CompletedProcess[str]:
    # A one-hour interval keeps the background worker idle, so only the exit hook can send.
    source = textwrap.dedent(
        f"""
        from logbrew_sdk import HttpTransport, LogBrewClient
        client = LogBrewClient.create(
            api_key="lb_test_key",
            sdk_name="logbrew-python-exit-test",
            sdk_version="0.1.0",
            transport=HttpTransport(endpoint={endpoint!r}, timeout=30),
            delivery_interval_seconds=3600,
            max_retries=0,
        )
        client.log("evt_exit_flush", "2026-10-25T00:00:00.000Z", {{"message": "last words", "level": "info"}})
        """
    ) + textwrap.dedent(body)
    env = {**os.environ, "PYTHONPATH": SRC_PATH}
    return subprocess.run(
        [sys.executable, "-c", source], capture_output=True, text=True, env=env, timeout=60, check=False
    )


class ExitFlushTests(unittest.TestCase):
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
        _Intake.delay_seconds = 0.0

    def logs(self) -> list[dict[str, Any]]:
        return [event for batch in _Intake.batches for event in batch["events"] if event["type"] == "log"]

    def test_pending_event_is_sent_when_the_interpreter_exits(self) -> None:
        result = run_app("", self.endpoint)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual([event["id"] for event in self.logs()], ["evt_exit_flush"])

    def test_explicit_shutdown_is_not_repeated_at_exit(self) -> None:
        result = run_app("client.shutdown()\n", self.endpoint)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(len(_Intake.batches), 1)

    def test_a_stalled_intake_does_not_hold_exit_past_the_bound(self) -> None:
        _Intake.delay_seconds = 10.0
        started = time.monotonic()
        result = run_app("", self.endpoint)
        elapsed = time.monotonic() - started

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(elapsed, 8.0)
        self.assertEqual(len(_Intake.batches), 1)

    def test_a_forked_child_does_not_send_the_parent_queue(self) -> None:
        # The child exits normally, so it runs the inherited exit hook before the parent does.
        result = run_app(
            """
            import os
            import sys
            import warnings
            warnings.simplefilter("ignore", DeprecationWarning)
            pid = os.fork()
            if pid == 0:
                sys.exit(0)
            os.waitpid(pid, 0)
            """,
            self.endpoint,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([event["id"] for event in self.logs()], ["evt_exit_flush"])


if __name__ == "__main__":
    unittest.main()
