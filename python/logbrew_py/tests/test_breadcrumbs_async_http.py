from __future__ import annotations

import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, ClassVar

import aiohttp
import httpx
import httpx2
from logbrew_sdk import (
    LogBrewClient,
    RecordingTransport,
    create_issue_attributes_from_exception,
    create_logbrew_trace_context,
    use_logbrew_trace,
)
from logbrew_sdk._breadcrumbs import ignore_breadcrumb_url

TIMESTAMP = "2026-06-02T10:00:00Z"


class _Server(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        status = 404 if self.path.startswith("/missing") else 503 if self.path.startswith("/down") else 200
        self.send_response(status)
        self.send_header("content-length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def do_POST(self) -> None:
        self.rfile.read(int(self.headers.get("content-length") or 0))
        self.do_GET()

    def log_message(self, format: str, *args: Any) -> None:
        return


def capture(event_id: str) -> list[dict[str, Any]]:
    target = LogBrewClient.create(
        api_key="lb_test_key",
        sdk_name="logbrew-python-breadcrumbs",
        sdk_version="0.1.0",
        transport=RecordingTransport.always_accept(),
        automatic_delivery=False,
    )
    target.issue(event_id, TIMESTAMP, create_issue_attributes_from_exception(ValueError("checkout failed")))
    events = json.loads(target.preview_json())["events"]
    attributes = next(event for event in events if event["id"] == event_id)["attributes"]
    return [
        {"level": crumb["level"], **crumb["data"]}
        for crumb in attributes.get("breadcrumbs", [])
        if crumb["category"] == "http.client"
    ]


class AsyncHttpBreadcrumbTests(unittest.TestCase):
    server: ClassVar[ThreadingHTTPServer]
    origin: ClassVar[str]

    @classmethod
    def setUpClass(cls) -> None:
        # Creating a client installs the breadcrumb sources, as an application would at startup.
        capture("evt_issue_install")
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Server)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.origin = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def expected(self, *entries: tuple[str, str, str, int]) -> list[dict[str, Any]]:
        return [
            {"level": level, "method": method, "url": f"{self.origin}{path}", "status_code": status}
            for level, method, path, status in entries
        ]

    def test_httpx_client_requests_become_request_breadcrumbs(self) -> None:
        for module in (httpx, httpx2):
            with (
                self.subTest(module=module.__name__),
                use_logbrew_trace(create_logbrew_trace_context()),
                module.Client() as http,
            ):
                http.get(f"{self.origin}/inventory?coupon=hidden#frag")
                http.post(f"{self.origin}/missing/price?coupon=hidden", content=b"{}")
                crumbs = capture(f"evt_issue_{module.__name__}")

                self.assertEqual(
                    crumbs,
                    self.expected(("info", "GET", "/inventory", 200), ("warning", "POST", "/missing/price", 404)),
                )
                self.assertNotIn("hidden", json.dumps(crumbs))

    def test_httpx_async_client_requests_become_request_breadcrumbs(self) -> None:
        for module in (httpx, httpx2):

            async def run(module: Any = module) -> list[dict[str, Any]]:
                async with module.AsyncClient() as http:
                    await http.get(f"{self.origin}/down/cart?coupon=hidden")
                return capture(f"evt_issue_{module.__name__}_async")

            with self.subTest(module=module.__name__), use_logbrew_trace(create_logbrew_trace_context()):
                crumbs = asyncio.run(run())
                self.assertEqual(crumbs, self.expected(("error", "GET", "/down/cart", 503)))

    def test_aiohttp_requests_become_request_breadcrumbs(self) -> None:
        async def run() -> list[dict[str, Any]]:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{self.origin}/inventory?coupon=hidden") as response:
                    await response.read()
                async with session.get(f"{self.origin}/missing/item") as response:
                    await response.read()
            return capture("evt_issue_aiohttp")

        with use_logbrew_trace(create_logbrew_trace_context()):
            crumbs = asyncio.run(run())

        self.assertEqual(
            crumbs,
            self.expected(("info", "GET", "/inventory", 200), ("warning", "GET", "/missing/item", 404)),
        )

    def test_failed_requests_are_error_breadcrumbs_and_ignored_urls_are_skipped(self) -> None:
        ignore_breadcrumb_url(f"{self.origin}/v1/events")

        async def run_aiohttp() -> None:
            async with aiohttp.ClientSession() as session:
                with self.assertRaises(aiohttp.ClientError):
                    await session.get("http://127.0.0.1:9/refused")
                async with session.get(f"{self.origin}/v1/events") as response:
                    await response.read()

        with use_logbrew_trace(create_logbrew_trace_context()):
            with httpx.Client() as http:
                with self.assertRaises(httpx.ConnectError):
                    http.get("http://127.0.0.1:9/refused")
                http.get(f"{self.origin}/v1/events")
            asyncio.run(run_aiohttp())
            crumbs = capture("evt_issue_failures")

        refused = {"level": "error", "method": "GET", "url": "http://127.0.0.1:9/refused"}
        self.assertEqual(crumbs, [refused, refused])


if __name__ == "__main__":
    unittest.main()
