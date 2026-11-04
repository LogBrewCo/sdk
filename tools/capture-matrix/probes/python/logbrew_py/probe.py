import logging
import os
from datetime import UTC, datetime

from logbrew_sdk import (
    HttpTransport,
    LogBrewClient,
    LogBrewLoggingHandler,
    create_issue_attributes_from_exception,
    create_logbrew_trace_context,
    set_logbrew_user,
    span_attributes_from_trace_context,
    use_logbrew_trace,
)

os.environ["LOGBREW_RELEASE"] = "checkout@1.2.3"
os.environ["LOGBREW_ENVIRONMENT"] = "production"
os.environ["LOGBREW_SERVICE_NAME"] = "checkout-worker"


def now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    transport=HttpTransport(endpoint=os.environ["LOGBREW_CAPTURE_ENDPOINT"]),
    context={"schemaVersion": 1, "session": {"id": "sess_123"}},
)
logger = logging.getLogger("checkout-worker")
logger.addHandler(LogBrewLoggingHandler(client))
logger.setLevel(logging.INFO)

trace = create_logbrew_trace_context("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
with use_logbrew_trace(trace):
    set_logbrew_user("user_123")
    logger.info("checkout started")
    try:
        raise RuntimeError("payment declined")
    except RuntimeError as error:
        logger.warning("payment step failing")
        client.issue("evt_issue_001", now(), create_issue_attributes_from_exception(error, mechanism="checkout.worker", handled=False))
    metric = {"name": "checkout.duration", "kind": "histogram", "value": 12, "unit": "ms", "temporality": "delta"}
    client.metric("evt_metric_001", now(), metric)
    client.span("evt_span_001", now(), span_attributes_from_trace_context(trace, name="checkout", status="error", duration_ms=12))
client.shutdown()
