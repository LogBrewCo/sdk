import logging
import os

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from logbrew_fastapi import init_logbrew
from logbrew_sdk import HttpTransport, set_logbrew_user

os.environ["LOGBREW_RELEASE"] = "checkout@1.2.3"
os.environ["LOGBREW_ENVIRONMENT"] = "production"
os.environ["LOGBREW_SERVICE_NAME"] = "checkout-api"


def identify() -> None:
    set_logbrew_user("user_123")


app = FastAPI(dependencies=[Depends(identify)])
logbrew = init_logbrew(
    app,
    api_key="LOGBREW_SERVER_API_KEY",
    service_name="checkout-api",
    transport=HttpTransport(endpoint=os.environ["LOGBREW_CAPTURE_ENDPOINT"]),
    capture_request_metrics=True,
)
logger = logging.getLogger("checkout-api")
logger.addHandler(logbrew.logging_handler)
logger.setLevel(logging.INFO)


@app.get("/checkout/{cart_id}")
def checkout(cart_id: str) -> dict[str, bool]:
    logger.info("checkout started")
    return {"ok": True}


@app.get("/fail/{cart_id}")
def fail(cart_id: str) -> dict[str, bool]:
    logger.warning("payment step failing")
    raise RuntimeError("payment declined")


traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
with TestClient(app, raise_server_exceptions=False) as http:
    assert http.get("/checkout/cart-1", headers={"traceparent": traceparent}).status_code == 200
    assert http.get("/fail/cart-2", headers={"traceparent": traceparent}).status_code == 500
