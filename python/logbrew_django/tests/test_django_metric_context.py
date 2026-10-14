from __future__ import annotations

import unittest

from django.test import RequestFactory
from logbrew_django import create_request_metric_attributes
from logbrew_sdk import create_logbrew_trace_context, use_logbrew_trace
from test_django_integration import setup_django


class DjangoMetricContextTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        setup_django()

    def test_metric_attributes_bind_request_trace_before_core_capture(self) -> None:
        request = RequestFactory().get("/health/")
        trace = create_logbrew_trace_context(
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
            span_id_factory=lambda: "b7ad6b7169203331",
        )
        request.META["logbrew.trace"] = trace
        with use_logbrew_trace(create_logbrew_trace_context()):
            attributes = create_request_metric_attributes(request, status_code=200, duration_ms=1)
        self.assertEqual(attributes["context"]["trace"], {
            "traceId": trace.trace_id, "spanId": trace.span_id,
            "parentSpanId": trace.parent_span_id, "sampled": False,
        })

    def test_metric_attributes_use_active_trace_when_request_has_none(self) -> None:
        request = RequestFactory().get("/health/")
        trace = create_logbrew_trace_context()
        with use_logbrew_trace(trace):
            attributes = create_request_metric_attributes(request, status_code=200, duration_ms=1)
        self.assertEqual(attributes["context"]["trace"]["spanId"], trace.span_id)
        self.assertNotIn("parentSpanId", attributes["context"]["trace"])

    def test_metric_attributes_without_trace_keep_context_absent(self) -> None:
        request = RequestFactory().get("/health/")
        attributes = create_request_metric_attributes(request, status_code=200, duration_ms=1)
        self.assertNotIn("context", attributes)
