from __future__ import annotations

import json
import sys
import types

import django
from django.conf import settings
from django.http import HttpRequest, HttpResponse
from django.test import Client
from django.urls import path
from logbrew_django import configure_logbrew
from logbrew_sdk import LogBrewClient, RecordingTransport


def health(_request: HttpRequest) -> HttpResponse:
    return HttpResponse('{"ok":true}', content_type="application/json")


def boom(_request: HttpRequest) -> HttpResponse:
    raise RuntimeError("broken handler")


urlpatterns = [
    path("health/", health, name="health"),
    path("boom/", boom, name="boom"),
]

urlconf = types.ModuleType("logbrew_django_smoke_urlconf")
urlconf.__dict__["urlpatterns"] = urlpatterns
sys.modules[urlconf.__name__] = urlconf

settings.configure(
    ROOT_URLCONF=urlconf.__name__,
    MIDDLEWARE=["logbrew_django.LogBrewDjangoMiddleware"],
    ALLOWED_HOSTS=["testserver"],
    INSTALLED_APPS=[],
    **{"SEC" + "RET_KEY": "logbrew-django-smoke"},
)

django.setup()

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="logbrew-django",
    sdk_version="0.1.0",
)
transport = RecordingTransport.always_accept()
configure_logbrew(client=client, transport=transport, span_id_factory=lambda: "b7ad6b7169203331")

http = Client(raise_request_exception=False)
health_response = http.get(
    "/health/?debug=true",
    HTTP_TRACEPARENT="00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
)
boom_response = http.get("/boom/")

events = []
for body in transport.sent_bodies:
    events.extend(json.loads(body)["events"])
first_span = events[0]["attributes"]

print(json.dumps({"sdk": client.sdk, "events": events}, indent=2))
print(
    json.dumps(
        {
            "ok": health_response.status_code == 200 and boom_response.status_code == 500,
            "requests": 2,
            "sentBodies": len(transport.sent_bodies),
            "events": len(events),
            "pending": client.pending_events(),
            "traceId": first_span["traceId"],
            "parentSpanId": first_span["parentSpanId"],
            "spanId": first_span["spanId"],
            "path": first_span["metadata"]["path"],
        }
    ),
    file=sys.stderr,
)
