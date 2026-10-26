from __future__ import annotations

import json
import unittest
from typing import Any

from django.core.exceptions import BadRequest, PermissionDenied, SuspiciousOperation
from django.http import Http404, HttpRequest, HttpResponse
from django.test import Client, override_settings
from django.urls import include, path, re_path
from logbrew_django import _simplify_regex_route, configure_logbrew
from logbrew_sdk import RecordingTransport
from test_django_integration import make_client, setup_django


def page(_request: HttpRequest, _path: str) -> HttpResponse:
    raise Http404


def article(_request: HttpRequest, year: str) -> HttpResponse:
    return HttpResponse(year)


def forbidden(_request: HttpRequest) -> HttpResponse:
    raise PermissionDenied


def bad(_request: HttpRequest) -> HttpResponse:
    raise BadRequest


def suspicious(_request: HttpRequest) -> HttpResponse:
    raise SuspiciousOperation


def broken(_request: HttpRequest) -> HttpResponse:
    raise RuntimeError("boom")


urlpatterns = [
    re_path(r"^articles/(?P<year>[0-9]{4})/$", article),
    path("forbidden/", forbidden),
    path("bad/", bad),
    path("suspicious/", suspicious),
    path("broken/", broken),
    path("cms/", include([re_path(r"^((?:[\w\-]+/)*)$", page)])),
]


class RegexRouteTemplateTests(unittest.TestCase):
    def test_simplifies_regex_routes(self) -> None:
        cases = {
            r"^((?:[\w\-]+/)*)$": "<var>",
            r"^articles/(?P<year>[0-9]{4})/$": "articles/<year>/",
            r"^blog/(\d+)/$": "blog/<var>/",
            r"documents/(\d+)/(.*)$": "documents/<var>/<var>",
            r"^files/[a-z]+\.txt$": "files/<var>.txt",
            r"^a(?:b|c)?/x{2,3}$": "a<var>/x",
            r"cms/^((?:[\w\-]+/)*)$": "cms/<var>",
            r"^$": "",
        }
        for route, expected in cases.items():
            with self.subTest(route=route):
                self.assertEqual(_simplify_regex_route(route), expected)


class RegexRouteAndClientErrorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        setup_django()

    def events(self, url: str) -> tuple[int, list[dict[str, Any]]]:
        transport = RecordingTransport.always_accept()
        configure_logbrew(client=make_client(), transport=transport)
        with override_settings(ROOT_URLCONF=__name__):
            response = Client(raise_request_exception=False).get(url)
        events = [event for body in transport.sent_bodies for event in json.loads(body)["events"]]
        return response.status_code, events

    def test_regex_route_names_the_span_with_a_readable_template(self) -> None:
        status, events = self.events("/articles/2026/")
        self.assertEqual(status, 200)
        self.assertEqual([event["type"] for event in events], ["span"])
        self.assertEqual(events[0]["attributes"]["name"], "GET /articles/<year>/")

    def test_http404_from_a_view_is_a_span_not_an_issue(self) -> None:
        status, events = self.events("/cms/no-such-page/")
        self.assertEqual(status, 404)
        self.assertEqual([event["type"] for event in events], ["span"])
        self.assertEqual(events[0]["attributes"]["name"], "GET /cms/<var>")

    def test_client_error_exceptions_are_not_issues(self) -> None:
        for url, expected in (("/forbidden/", 403), ("/bad/", 400), ("/suspicious/", 400)):
            with self.subTest(url=url):
                status, events = self.events(url)
                self.assertEqual(status, expected)
                self.assertEqual([event["type"] for event in events], ["span"])

    def test_server_errors_stay_issues(self) -> None:
        status, events = self.events("/broken/")
        self.assertEqual(status, 500)
        self.assertEqual([event["type"] for event in events], ["issue", "span"])
