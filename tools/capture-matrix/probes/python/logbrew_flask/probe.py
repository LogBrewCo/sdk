import logging
import os

from flask import Flask
from logbrew_flask import init_logbrew
from logbrew_sdk import HttpTransport, LogBrewLoggingHandler, set_logbrew_user

os.environ["LOGBREW_SERVER_API_KEY"] = "LOGBREW_SERVER_API_KEY"
os.environ["LOGBREW_RELEASE"] = "checkout@1.2.3"
os.environ["LOGBREW_ENVIRONMENT"] = "production"
os.environ["LOGBREW_SERVICE_NAME"] = "checkout-api"

app = Flask(__name__)
logbrew = init_logbrew(app, transport=HttpTransport(endpoint=os.environ["LOGBREW_CAPTURE_ENDPOINT"]), capture_request_metrics=True)
app.logger.addHandler(LogBrewLoggingHandler(logbrew.client))
app.logger.setLevel(logging.INFO)


@app.before_request
def identify() -> None:
    set_logbrew_user("user_123")


@app.get("/checkout/<cart_id>")
def checkout(cart_id: str) -> dict[str, bool]:
    app.logger.info("checkout started")
    return {"ok": True}


@app.get("/fail/<cart_id>")
def fail(cart_id: str) -> dict[str, bool]:
    app.logger.warning("payment step failing")
    raise RuntimeError("payment declined")


http = app.test_client()
traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
assert http.get("/checkout/cart-1", headers={"traceparent": traceparent}).status_code == 200
assert http.get("/fail/cart-2", headers={"traceparent": traceparent}).status_code == 500
logbrew.client.shutdown()
