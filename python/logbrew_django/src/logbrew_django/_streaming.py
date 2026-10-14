"""Lazy request tracing around Django response iteration and close."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import suppress
from typing import cast

from django.http import StreamingHttpResponse
from logbrew_sdk import LogBrewTraceContext, use_logbrew_trace


def wrap_streaming_response(
    response: StreamingHttpResponse,
    trace: LogBrewTraceContext,
    finish: Callable[[Exception | None], None],
) -> None:
    content = response.streaming_content
    original_close = response.close
    finished = False

    def close(error: Exception | None = None) -> None:
        nonlocal finished
        if finished:
            return
        finished = True
        with use_logbrew_trace(trace):
            try:
                original_close()
            finally:
                finish(error)

    def sync_body() -> Iterator[bytes]:
        iterator = iter(cast("Iterator[bytes]", content))
        while True:
            with use_logbrew_trace(trace):
                try:
                    chunk = next(iterator)
                except StopIteration:
                    close()
                    return
                except Exception as error:
                    close(error)
                    raise
            yield chunk

    async def async_body() -> AsyncIterator[bytes]:
        iterator = aiter(cast("AsyncIterator[bytes]", content))
        while True:
            with use_logbrew_trace(trace):
                try:
                    chunk = await anext(iterator)
                except StopAsyncIteration:
                    close()
                    return
                except asyncio.CancelledError:
                    # Complete telemetry after the source has unwound, retaining cancellation.
                    with suppress(Exception):
                        close()
                    raise
                except Exception as error:
                    close(error)
                    raise
            yield chunk

    response.streaming_content = async_body() if response.is_async else sync_body()
    # Django exposes no public close hook; the instance attribute wraps its closers.
    response.close = close  # type: ignore[method-assign]
