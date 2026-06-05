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


urlpatterns = [
    path("health/", health, name="health"),
]

urlconf = types.ModuleType("logbrew_django_readme_urlconf")
urlconf.__dict__["urlpatterns"] = urlpatterns
sys.modules[urlconf.__name__] = urlconf

settings.configure(
    ROOT_URLCONF=urlconf.__name__,
    MIDDLEWARE=["logbrew_django.LogBrewDjangoMiddleware"],
    ALLOWED_HOSTS=["testserver"],
    INSTALLED_APPS=[],
    **{"SEC" + "RET_KEY": "logbrew-django-readme"},
)

django.setup()

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="logbrew-django",
    sdk_version="0.1.0",
)
transport = RecordingTransport.always_accept()
configure_logbrew(client=client, transport=transport)

response = Client().get("/health/")
print(json.dumps({"ok": response.status_code == 200, "status": response.status_code}), file=sys.stderr)
print(transport.sent_bodies[-1])
