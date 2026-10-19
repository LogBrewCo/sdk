from __future__ import annotations

import json
import logging
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, ClassVar

from logbrew_sdk import (
    HttpTransport,
    LogBrewClient,
    RecordingTransport,
    SdkError,
    add_logbrew_breadcrumb,
    create_issue_attributes_from_exception,
    create_logbrew_trace_context,
    use_logbrew_trace,
)

TIMESTAMP = "2026-06-02T10:00:00Z"


class _Server(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self.send_response(404 if self.path.startswith("/missing") else 200)
        self.end_headers()
        self.wfile.write(b"ok")

    def do_POST(self) -> None:
        self.rfile.read(int(self.headers["content-length"]))
        self.send_response(202)
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, format: str, *args: Any) -> None:
        return


def client(**kwargs: Any) -> LogBrewClient:
    return LogBrewClient.create(
        api_key="lb_test_key",
        sdk_name="logbrew-python-breadcrumbs",
        sdk_version="0.1.0",
        transport=RecordingTransport.always_accept(),
        automatic_delivery=False,
        **kwargs,
    )


def capture(target: LogBrewClient, event_id: str) -> dict[str, Any]:
    target.issue(event_id, TIMESTAMP, create_issue_attributes_from_exception(ValueError("checkout failed")))
    events = json.loads(target.preview_json())["events"]
    attributes: dict[str, Any] = next(event for event in events if event["id"] == event_id)["attributes"]
    return attributes


def new_trace() -> Any:
    return create_logbrew_trace_context()


class BreadcrumbTests(unittest.TestCase):
    server: ClassVar[ThreadingHTTPServer]
    origin: ClassVar[str]

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Server)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.origin = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def test_logging_and_http_inside_a_request_become_that_requests_issue_breadcrumbs(self) -> None:
        target = client()
        logger = logging.getLogger("checkout")
        logger.setLevel(logging.INFO)
        with use_logbrew_trace(new_trace()):
            logger.info("checkout started for cart %s", "cart-7")
            urllib.request.urlopen(f"{self.origin}/inventory?coupon=hidden#frag").read()
            with self.assertRaises(urllib.error.HTTPError):
                urllib.request.urlopen(f"{self.origin}/missing/price?coupon=hidden")
            issue = capture(target, "evt_issue_request")

        crumbs = [
            {key: crumb.get(key) for key in ("category", "level", "message", "data")} for crumb in issue["breadcrumbs"]
        ]
        self.assertEqual(
            crumbs,
            [
                {
                    "category": "logging",
                    "level": "info",
                    "message": "checkout started for cart %s",
                    "data": {"logger": "checkout"},
                },
                {
                    "category": "http.client",
                    "level": "info",
                    "message": None,
                    "data": {"method": "GET", "url": f"{self.origin}/inventory", "status_code": 200},
                },
                {
                    "category": "http.client",
                    "level": "warning",
                    "message": None,
                    "data": {"method": "GET", "url": f"{self.origin}/missing/price", "status_code": 404},
                },
            ],
        )
        self.assertNotIn("hidden", json.dumps(issue))

    def test_breadcrumbs_from_one_request_never_reach_another_requests_issue(self) -> None:
        target = client()
        with use_logbrew_trace(new_trace()):
            add_logbrew_breadcrumb({"category": "checkout", "message": "first request step"})
        with use_logbrew_trace(new_trace()):
            add_logbrew_breadcrumb({"category": "checkout", "message": "second request step"})
            issue = capture(target, "evt_issue_isolated")

        self.assertEqual([crumb["message"] for crumb in issue["breadcrumbs"]], ["second request step"])

    def test_breadcrumbs_outside_a_request_reach_issues_outside_a_request(self) -> None:
        target = client()
        add_logbrew_breadcrumb({"category": "worker", "message": "job 41 started"})
        issue = capture(target, "evt_issue_process")

        self.assertIn("job 41 started", [crumb.get("message") for crumb in issue["breadcrumbs"]])

    def test_a_scope_keeps_the_newest_64_and_marks_the_issue_truncated(self) -> None:
        target = client()
        with use_logbrew_trace(new_trace()):
            for index in range(70):
                add_logbrew_breadcrumb({"category": "step", "message": f"step {index}"})
            issue = capture(target, "evt_issue_truncated")

        self.assertEqual(len(issue["breadcrumbs"]), 64)
        self.assertEqual(issue["breadcrumbs"][0]["message"], "step 6")
        self.assertTrue(issue["breadcrumbsTruncated"])

    def test_logbrew_delivery_requests_are_not_breadcrumbs(self) -> None:
        delivering = LogBrewClient.create(
            api_key="lb_test_key",
            sdk_name="logbrew-python-breadcrumbs",
            sdk_version="0.1.0",
            transport=HttpTransport(endpoint=f"{self.origin}/v1/events"),
            automatic_delivery=False,
            max_retries=0,
        )
        with use_logbrew_trace(new_trace()):
            delivering.log("evt_log_delivery", TIMESTAMP, {"message": "queued", "level": "info"})
            delivering.flush()
            issue = capture(delivering, "evt_issue_delivery")

        self.assertNotIn("breadcrumbs", issue)

    def test_log_arguments_and_disabled_clients_stay_out_of_issues(self) -> None:
        logger = logging.getLogger("worker")
        logger.setLevel(logging.INFO)
        with use_logbrew_trace(new_trace()):
            logger.error("Failed to process message %r", "PRIVATE_JOB_ARGUMENT")
            issue = capture(client(), "evt_issue_template")
            disabled = capture(client(breadcrumbs=False), "evt_issue_disabled")

        self.assertEqual(issue["breadcrumbs"][-1]["message"], "Failed to process message %r")
        self.assertNotIn("PRIVATE_JOB_ARGUMENT", json.dumps(issue))
        self.assertNotIn("breadcrumbs", disabled)

    def test_invalid_breadcrumbs_are_ignored_and_the_option_is_validated(self) -> None:
        add_logbrew_breadcrumb({"category": "bad category!"})
        with self.assertRaises(SdkError):
            client(breadcrumbs="yes")


if __name__ == "__main__":
    unittest.main()
