from __future__ import annotations

import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Literal, cast
from unittest.mock import patch

from logbrew_sdk import LogBrewClient, RecordingTransport, SdkError, TransportResponse
from logbrew_sdk._persistent_event_queue import PersistentEventQueue
from test_persistent_delivery import HAS_PERSISTENCE_CRYPTO, capture_log, create_persistent_client


@unittest.skipUnless(HAS_PERSISTENCE_CRYPTO, "persistence extra is not installed")
class PersistentAcceptanceFailureTests(unittest.TestCase):
    def test_failed_confirmation_statistics_keep_original_error_and_concurrent_suffix(self) -> None:
        for interrupted in (False, True):
            with self.subTest(interrupted=interrupted), tempfile.TemporaryDirectory() as directory:
                self.check_failure(Path(directory).resolve(), interrupted)

    def check_failure(self, directory: Path, interrupted: bool) -> None:
        entered, release, armed = threading.Event(), threading.Event(), threading.Event()
        bodies: list[str] = []
        primary: list[BaseException] = []
        caller: list[BaseException] = []

        class AcceptingTransport:
            def send(self, api_key: str, body: str) -> TransportResponse:
                bodies.append(body)
                entered.set()
                if not release.wait(5):
                    raise AssertionError("acceptance was not released")
                return TransportResponse(202, 1)

        client = create_persistent_client(directory, transport=AcceptingTransport(), automatic_delivery=False)
        capture_log(client, "evt_before", "before acceptance")
        queue = cast(PersistentEventQueue, client._queue)
        original_commit, original_fsync = queue._commit_transaction, os.fsync
        calls = 0

        def fsync(descriptor: int) -> None:
            nonlocal calls
            if not armed.is_set():
                original_fsync(descriptor)
                return
            calls += 1
            if calls == 1 and interrupted:
                raise KeyboardInterrupt("synthetic acknowledgement interruption")
            raise OSError("synthetic confirmation failure")

        def commit(*, pending: tuple[Literal["append", "ack", "purge"], int], message: str) -> None:
            try:
                original_commit(pending=pending, message=message)
            except BaseException as error:
                primary.append(error)
                raise

        def flush() -> None:
            try:
                client.flush()
            except BaseException as error:
                caller.append(error)

        worker = threading.Thread(target=flush)
        try:
            with (
                patch("logbrew_sdk._persistent_event_queue.os.fsync", side_effect=fsync),
                patch.object(queue, "_commit_transaction", side_effect=commit),
            ):
                worker.start()
                try:
                    self.assertTrue(entered.wait(5))
                    capture_log(client, "evt_later", "during acceptance")
                    armed.set()
                finally:
                    release.set()
                    worker.join(5)
                self.assertFalse(worker.is_alive())
            self.check_outcome(client, queue, bodies, primary, caller, interrupted=interrupted)
        finally:
            release.set()
            if worker.is_alive():
                worker.join(5)
            queue.close()

    def check_outcome(
        self, client: LogBrewClient, queue: PersistentEventQueue, bodies: list[str],
        primary: list[BaseException], caller: list[BaseException], *, interrupted: bool,
    ) -> None:
        self.assertEqual(len(primary), 1)
        self.assertEqual(len(caller), 1)
        self.assertIs(caller[0], primary[0])
        self.assertIsInstance(caller[0], KeyboardInterrupt if interrupted else SdkError)
        self.assertEqual(json.loads(bodies[0])["events"][0]["id"], "evt_before")
        self.assertEqual(queue._pending_confirmation, ("ack", 1))
        health = client.delivery_health()
        self.assertEqual(health.last_outcome, "paused")
        self.assertEqual(health.pause_reason, "internal" if interrupted else "storage")
        self.assertFalse(health.delivery_in_flight)
        self.assertNotIn("synthetic", repr(health))
        self.assertEqual(health.pending_events, 1)
        accepted = RecordingTransport.always_accept()
        self.assertEqual(client.shutdown(accepted).accepted_events, 1)
        events = [event["id"] for body in accepted.sent_bodies for event in json.loads(body)["events"]]
        self.assertEqual(events, ["evt_later"])
