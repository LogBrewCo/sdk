"""Authenticated encryption for opt-in persistent queue records."""

from __future__ import annotations

import hashlib
import importlib
import json
import os
import re
from dataclasses import dataclass
from typing import Any, Protocol, cast

from logbrew_sdk._errors import SdkError
from logbrew_sdk._event_queue import QueuedEvent

_NONCE_BYTES = 12
_KEY_BYTES = 32
_RECORD_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
_EXPECTED_EVENT_KEYS = {"type", "id", "timestamp", "attributes"}


class _Aead(Protocol):
    def encrypt(self, nonce: bytes, data: bytes, associated_data: bytes | None) -> bytes: ...

    def decrypt(self, nonce: bytes, data: bytes, associated_data: bytes | None) -> bytes: ...


@dataclass(frozen=True, slots=True)
class QueueState:
    accepted_through: int
    last_admitted: int
    pending_bytes: int


class PersistenceCrypto:
    """Encrypt and authenticate queue state without retaining public configuration."""

    def __init__(self, *, key: bytes | bytearray | memoryview, sdk_json: str) -> None:
        if not isinstance(key, bytes | bytearray | memoryview) or len(key) != _KEY_BYTES:
            raise SdkError(
                "configuration_error",
                "persistent_queue_encryption_key must contain exactly 32 bytes",
            )
        self._sdk_digest = hashlib.sha256(sdk_json.encode("utf-8")).digest()
        self._aead = _load_aead(bytes(key))

    def encrypt_state(self, state: QueueState) -> tuple[bytes, bytes]:
        plaintext = _compact_json(
            {
                "acceptedThrough": state.accepted_through,
                "lastAdmitted": state.last_admitted,
                "pendingBytes": state.pending_bytes,
            }
        ).encode("utf-8")
        return self._encrypt(plaintext, self._state_aad())

    def decrypt_state(self, nonce: Any, ciphertext: Any) -> QueueState:
        payload = self._decrypt_json(nonce, ciphertext, self._state_aad())
        if set(payload) != {"acceptedThrough", "lastAdmitted", "pendingBytes"}:
            raise _integrity_error()
        accepted = payload["acceptedThrough"]
        admitted = payload["lastAdmitted"]
        pending_bytes = payload["pendingBytes"]
        if (
            isinstance(accepted, bool)
            or not isinstance(accepted, int)
            or accepted < 0
            or isinstance(admitted, bool)
            or not isinstance(admitted, int)
            or admitted < accepted
            or isinstance(pending_bytes, bool)
            or not isinstance(pending_bytes, int)
            or pending_bytes < 0
        ):
            raise _integrity_error()
        return QueueState(
            accepted_through=accepted,
            last_admitted=admitted,
            pending_bytes=pending_bytes,
        )

    def encrypt_event(self, event: QueuedEvent) -> tuple[bytes, bytes]:
        plaintext = _compact_json(
            {
                "byteCount": event.byte_count,
                "eventJson": event.json,
                "recordId": event.record_id,
                "sequence": event.sequence,
            }
        ).encode("utf-8")
        return self._encrypt(plaintext, self._event_aad(event.sequence))

    def decrypt_event(self, sequence: Any, nonce: Any, ciphertext: Any) -> QueuedEvent:
        if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence <= 0:
            raise _integrity_error()
        payload = self._decrypt_json(nonce, ciphertext, self._event_aad(sequence))
        if set(payload) != {"byteCount", "eventJson", "recordId", "sequence"}:
            raise _integrity_error()
        if payload["sequence"] != sequence:
            raise _integrity_error()
        record_id = payload["recordId"]
        event_json = payload["eventJson"]
        byte_count = payload["byteCount"]
        if (
            not isinstance(record_id, str)
            or _RECORD_ID_PATTERN.fullmatch(record_id) is None
            or not isinstance(event_json, str)
            or isinstance(byte_count, bool)
            or not isinstance(byte_count, int)
            or byte_count <= 0
            or len(event_json.encode("utf-8")) != byte_count
        ):
            raise _integrity_error()
        try:
            event = json.loads(event_json)
        except (TypeError, ValueError):
            raise _integrity_error() from None
        if (
            not isinstance(event, dict)
            or set(event) != _EXPECTED_EVENT_KEYS
            or not isinstance(event["type"], str)
            or not isinstance(event["id"], str)
            or not isinstance(event["timestamp"], str)
            or not isinstance(event["attributes"], dict)
        ):
            raise _integrity_error()
        return QueuedEvent(
            sequence=sequence,
            record_id=record_id,
            json=event_json,
            byte_count=byte_count,
        )

    def _encrypt(self, plaintext: bytes, aad: bytes) -> tuple[bytes, bytes]:
        nonce = os.urandom(_NONCE_BYTES)
        return nonce, self._aead.encrypt(nonce, plaintext, aad)

    def _decrypt_json(self, nonce: Any, ciphertext: Any, aad: bytes) -> dict[str, Any]:
        if (
            not isinstance(nonce, bytes)
            or len(nonce) != _NONCE_BYTES
            or not isinstance(ciphertext, bytes)
            or not ciphertext
        ):
            raise _integrity_error()
        try:
            plaintext = self._aead.decrypt(nonce, ciphertext, aad)
            payload = json.loads(plaintext)
        except Exception:
            raise _integrity_error() from None
        if not isinstance(payload, dict):
            raise _integrity_error()
        return cast(dict[str, Any], payload)

    def _state_aad(self) -> bytes:
        return b"logbrew-python-persistence\x00state\x00v2\x00" + self._sdk_digest

    def _event_aad(self, sequence: int) -> bytes:
        return (
            b"logbrew-python-persistence\x00event\x00v2\x00"
            + self._sdk_digest
            + b"\x00"
            + str(sequence).encode("ascii")
        )


def _load_aead(key: bytes) -> _Aead:
    try:
        module = importlib.import_module("cryptography.hazmat.primitives.ciphers.aead")
        aes_gcm = module.AESGCM
        return cast(_Aead, aes_gcm(key))
    except (ImportError, AttributeError):
        raise SdkError(
            "configuration_error",
            "encrypted persistence requires the logbrew-sdk persistence extra",
        ) from None
    except (TypeError, ValueError):
        raise SdkError(
            "configuration_error",
            "persistent_queue_encryption_key must contain exactly 32 bytes",
        ) from None


def _compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _integrity_error() -> SdkError:
    return SdkError(
        "persistence_integrity_error",
        "persistent queue authentication or continuity check failed",
    )
