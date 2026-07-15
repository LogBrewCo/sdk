from __future__ import annotations

import os
from pathlib import Path

from celery import Celery  # type: ignore[import-untyped]
from logbrew_sdk import (
    HttpTransport,
    LogBrewClient,
    celery_worker_persistent_queue_directory,
    instrument_celery_worker_processes_with_logbrew,
)

worker_app = Celery("checkout-worker")
queue_root = Path(os.environ["LOGBREW_QUEUE_ROOT"]).resolve()
queue_root.mkdir(mode=0o700, parents=True, exist_ok=True)


def create_worker_client() -> LogBrewClient:
    persistence_key = bytes.fromhex(os.environ["LOGBREW_PERSISTENCE_KEY_HEX"])
    return LogBrewClient.create(
        api_key=os.environ["LOGBREW_API_KEY"],
        sdk_name="checkout-worker",
        sdk_version="1.0.0",
        max_retries=2,
        persistent_queue_directory=celery_worker_persistent_queue_directory(queue_root),
        persistent_queue_encryption_key=persistence_key,
    )


worker_lifecycle = instrument_celery_worker_processes_with_logbrew(
    worker_app,
    client_factory=create_worker_client,
    transport_factory=HttpTransport,
    metadata={"service": "checkout-worker"},
)
