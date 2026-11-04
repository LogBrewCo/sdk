import logging
import os
from collections.abc import Callable

import django
from django.conf import settings
from django.http import HttpRequest, HttpResponse, JsonResponse
from django.test import Client
from django.urls import path
from logbrew_django import configure_logbrew
from logbrew_sdk import HttpTransport, LogBrewClient, LogBrewLoggingHandler, set_logbrew_user

os.environ["LOGBREW_RELEASE"] = "checkout@1.2.3"
os.environ["LOGBREW_ENVIRONMENT"] = "production"
os.environ["LOGBREW_SERVICE_NAME"] = "checkout-api"

logger = logging.getLogger("checkout-api")


def identify(get_response: Callable[[HttpRequest], HttpResponse]) -> Callable[[HttpRequest], HttpResponse]:
    def middleware(request: HttpRequest) -> HttpResponse:
        set_logbrew_user("user_123")
        return get_response(request)

    return middleware


def checkout(request: HttpRequest, cart_id: str) -> JsonResponse:
    logger.info("checkout started")
    return JsonResponse({"ok": True})


def fail(request: HttpRequest, cart_id: str) -> JsonResponse:
    logger.warning("payment step failing")
    raise RuntimeError("payment declined")


urlpatterns = [path("checkout/<str:cart_id>/", checkout), path("fail/<str:cart_id>/", fail)]

settings.configure(
    DEBUG=False,
    ALLOWED_HOSTS=["testserver"],
    ROOT_URLCONF=__name__,
    SECRET_KEY="capture-probe-secret-key",
    MIDDLEWARE=["logbrew_django.LogBrewDjangoMiddleware", f"{__name__}.identify"],
    LOGGING_CONFIG=None,
)
django.setup()

client = LogBrewClient.create(api_key="LOGBREW_SERVER_API_KEY")
logger.addHandler(LogBrewLoggingHandler(client))
logger.setLevel(logging.INFO)
configure_logbrew(
    client=client,
    transport=HttpTransport(endpoint=os.environ["LOGBREW_CAPTURE_ENDPOINT"]),
    service_name="checkout-api",
    capture_request_metrics=True,
)

http = Client(raise_request_exception=False)
traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
assert http.get("/checkout/cart-1/", headers={"traceparent": traceparent}).status_code == 200
assert http.get("/fail/cart-2/", headers={"traceparent": traceparent}).status_code == 500
