"""Public Python client for building, validating, previewing, and flushing LogBrew event batches.

A 2xx response means LogBrew accepted the batch, not that you can read it. Read it back with a
project read key: ``LOGBREW_TOKEN=<read key> logbrew read traces --since 1h --json`` (or
``logbrew issues``). See https://docs.logbrew.co/guides/verify-setup.
"""

import typing as _typing

from logbrew_sdk._arq_client import (
    LogBrewArqPoolInstrumentation,
    LogBrewArqWorkerInstrumentation,
    instrument_arq_pool_with_logbrew_spans,
    instrument_arq_worker_with_logbrew_spans,
)
from logbrew_sdk._automatic_delivery import (
    DeliveryHealthSnapshot as DeliveryHealthSnapshot,
)
from logbrew_sdk._breadcrumbs import (
    LogBrewBreadcrumbHandler,
    add_logbrew_breadcrumb,
)
from logbrew_sdk._cache_client import (
    async_cache_operation_with_logbrew_span,
    cache_operation_with_logbrew_span,
)
from logbrew_sdk._celery_client import (
    celery_operation_with_logbrew_span,
    create_celery_trace_headers,
    logbrew_trace_context_from_celery_headers,
)
from logbrew_sdk._celery_instrumentation import (
    LogBrewCeleryInstrumentation,
    instrument_celery_app_with_logbrew_spans,
)
from logbrew_sdk._celery_worker_lifecycle import (
    LogBrewCeleryWorkerLifecycle,
    celery_worker_persistent_queue_directory,
    instrument_celery_worker_processes_with_logbrew,
)
from logbrew_sdk._client import (
    ACTION_STATUSES as ACTION_STATUSES,
)
from logbrew_sdk._client import (
    CLIENT_REPORT_ID_PATTERN as CLIENT_REPORT_ID_PATTERN,
)
from logbrew_sdk._client import (
    CLIENT_REPORT_REASON_PATTERN as CLIENT_REPORT_REASON_PATTERN,
)
from logbrew_sdk._client import (
    CLIENT_REPORT_SAVE_INTERVAL_SECONDS as CLIENT_REPORT_SAVE_INTERVAL_SECONDS,
)
from logbrew_sdk._client import (
    DEFAULT_HTTP_ENDPOINT as DEFAULT_HTTP_ENDPOINT,
)
from logbrew_sdk._client import (
    DEFAULT_MAX_BATCH_BYTES as DEFAULT_MAX_BATCH_BYTES,
)
from logbrew_sdk._client import (
    DEFAULT_MAX_BATCH_EVENTS as DEFAULT_MAX_BATCH_EVENTS,
)
from logbrew_sdk._client import (
    DEFAULT_MAX_QUEUE_BYTES as DEFAULT_MAX_QUEUE_BYTES,
)
from logbrew_sdk._client import (
    DEFAULT_MAX_QUEUE_SIZE as DEFAULT_MAX_QUEUE_SIZE,
)
from logbrew_sdk._client import (
    ISSUE_LEVELS as ISSUE_LEVELS,
)
from logbrew_sdk._client import (
    LOG_RECORD_BUILTINS as LOG_RECORD_BUILTINS,
)
from logbrew_sdk._client import (
    MAX_CLIENT_REPORT_COUNT as MAX_CLIENT_REPORT_COUNT,
)
from logbrew_sdk._client import (
    MAX_CLIENT_REPORT_REASONS as MAX_CLIENT_REPORT_REASONS,
)
from logbrew_sdk._client import (
    MAX_METRIC_DESCRIPTION_LENGTH as MAX_METRIC_DESCRIPTION_LENGTH,
)
from logbrew_sdk._client import (
    METRIC_KINDS as METRIC_KINDS,
)
from logbrew_sdk._client import (
    METRIC_TEMPORALITIES_BY_KIND as METRIC_TEMPORALITIES_BY_KIND,
)
from logbrew_sdk._client import (
    NON_NEGATIVE_METRIC_KINDS as NON_NEGATIVE_METRIC_KINDS,
)
from logbrew_sdk._client import (
    SEVERITY_ALIASES as SEVERITY_ALIASES,
)
from logbrew_sdk._client import (
    SEVERITY_VALUES as SEVERITY_VALUES,
)
from logbrew_sdk._client import (
    SPAN_STATUSES as SPAN_STATUSES,
)
from logbrew_sdk._client import (
    TRACEPARENT_PATTERN as TRACEPARENT_PATTERN,
)
from logbrew_sdk._client import (
    ZERO_SPAN_ID as ZERO_SPAN_ID,
)
from logbrew_sdk._client import (
    ZERO_TRACE_ID as ZERO_TRACE_ID,
)
from logbrew_sdk._client import (
    ActionAttributes,
    EnvironmentAttributes,
    EventDrop,
    EventDropReason,
    HttpTransport,
    IssueAttributes,
    IssueBreadcrumb,
    IssueBreadcrumbDataValue,
    IssueBreadcrumbLevel,
    IssueBreadcrumbLevelInput,
    IssueDiagnosticEvidence,
    IssueException,
    IssueExceptionChain,
    IssueExceptionChainEntry,
    IssueExceptionMechanism,
    IssueExceptionMessageState,
    IssueExceptionRelationship,
    IssueExceptionStackFramesState,
    IssueImpactEvidence,
    IssueLikelyFixArea,
    IssueStackFrame,
    LogAttributes,
    LogBrewClient,
    LogBrewLoggingHandler,
    Metadata,
    MetadataValue,
    MetricAttributes,
    RecordingTransport,
    ReleaseAttributes,
    TraceparentContext,
    Transport,
    TransportError,
    TransportResponse,
    create_issue_attributes_from_exception,
    create_logbrew_trace_context,
    create_support_ticket_draft,
    create_traceparent,
    create_traceparent_headers,
    log_attributes_from_record,
    logbrew_trace_context_from_current_open_telemetry_span,
    logbrew_trace_context_from_open_telemetry_span,
    logbrew_trace_context_from_open_telemetry_span_context,
    parse_traceparent,
    span_attributes_from_trace_context,
    span_attributes_from_traceparent,
)
from logbrew_sdk._client import (
    ScriptedTransportResponse as ScriptedTransportResponse,
)
from logbrew_sdk._client import (
    clone_metadata as clone_metadata,
)
from logbrew_sdk._client import (
    compact_metadata as compact_metadata,
)
from logbrew_sdk._client import (
    default_log_record_event_id as default_log_record_event_id,
)
from logbrew_sdk._client import (
    default_span_id_factory as default_span_id_factory,
)
from logbrew_sdk._client import (
    default_trace_id as default_trace_id,
)
from logbrew_sdk._client import (
    extra_metadata_from_log_record as extra_metadata_from_log_record,
)
from logbrew_sdk._client import (
    logbrew_level as logbrew_level,
)
from logbrew_sdk._client import (
    metadata_from_log_record as metadata_from_log_record,
)
from logbrew_sdk._client import (
    metric_description_or_none as metric_description_or_none,
)
from logbrew_sdk._client import (
    normalize_severity as normalize_severity,
)
from logbrew_sdk._client import (
    require_allowed_value as require_allowed_value,
)
from logbrew_sdk._client import (
    require_finite_number as require_finite_number,
)
from logbrew_sdk._client import (
    require_non_empty as require_non_empty,
)
from logbrew_sdk._client import (
    require_span_id as require_span_id,
)
from logbrew_sdk._client import (
    require_timestamp as require_timestamp,
)
from logbrew_sdk._client import (
    require_trace_flags as require_trace_flags,
)
from logbrew_sdk._client import (
    require_trace_id as require_trace_id,
)
from logbrew_sdk._client import (
    slugify as slugify,
)
from logbrew_sdk._client import (
    timestamp_from_log_record as timestamp_from_log_record,
)
from logbrew_sdk._client import (
    uuid4_hex as uuid4_hex,
)
from logbrew_sdk._client import (
    validate_action as validate_action,
)
from logbrew_sdk._client import (
    validate_environment as validate_environment,
)
from logbrew_sdk._client import (
    validate_headers as validate_headers,
)
from logbrew_sdk._client import (
    validate_issue as validate_issue,
)
from logbrew_sdk._client import (
    validate_log as validate_log,
)
from logbrew_sdk._client import (
    validate_metric as validate_metric,
)
from logbrew_sdk._client import (
    validate_release as validate_release,
)
from logbrew_sdk._client import (
    validate_span as validate_span,
)
from logbrew_sdk._client import (
    with_common_attributes as with_common_attributes,
)
from logbrew_sdk._client import (
    with_metadata as with_metadata,
)
from logbrew_sdk._db_client import (
    async_database_operation_with_logbrew_span,
    database_operation_with_logbrew_span,
)
from logbrew_sdk._dbapi_client import (
    LogBrewDbapiConnection,
    LogBrewDbapiCursor,
    connect_dbapi_connection_with_logbrew_spans,
    instrument_dbapi_connection_with_logbrew_spans,
)
from logbrew_sdk._django_cache_client import (
    LogBrewDjangoCacheInstrumentation,
    instrument_django_cache_with_logbrew_spans,
)
from logbrew_sdk._dramatiq_client import (
    LogBrewDramatiqInstrumentation,
    instrument_dramatiq_broker_with_logbrew_spans,
)
from logbrew_sdk._errors import (
    SdkError,
)
from logbrew_sdk._flask_cache_client import (
    LogBrewFlaskCacheInstrumentation,
    instrument_flask_cache_with_logbrew_spans,
)
from logbrew_sdk._http_client import (
    aiohttp_request_with_logbrew_span,
    async_httpx_request_with_logbrew_span,
    httpx_request_with_logbrew_span,
    requests_request_with_logbrew_span,
    urlopen_with_logbrew_span,
)
from logbrew_sdk._http_instrumentation import (
    LogBrewAiohttpClientSessionInstrumentation,
    LogBrewHttpxClientInstrumentation,
    LogBrewRequestsSessionInstrumentation,
    instrument_aiohttp_client_session_with_logbrew_spans,
    instrument_httpx_client_with_logbrew_spans,
    instrument_requests_session_with_logbrew_spans,
)
from logbrew_sdk._opentelemetry_processor import (
    LogBrewOpenTelemetrySpanExporter,
    LogBrewOpenTelemetrySpanProcessor,
    create_logbrew_open_telemetry_span_exporter,
    create_logbrew_open_telemetry_span_processor,
    span_attributes_from_open_telemetry_readable_span,
)
from logbrew_sdk._process_errors import (
    ProcessErrorCapture,
    install_process_error_capture,
)
from logbrew_sdk._pymemcache_client import (
    LogBrewPymemcacheInstrumentation,
    instrument_pymemcache_client_with_logbrew_spans,
)
from logbrew_sdk._queue_client import (
    async_queue_operation_with_logbrew_span,
    queue_operation_with_logbrew_span,
)
from logbrew_sdk._redis_client import (
    LogBrewRedisInstrumentation,
    instrument_redis_client_with_logbrew_spans,
)
from logbrew_sdk._rq_client import (
    LogBrewRqQueueInstrumentation,
    LogBrewRqWorkerInstrumentation,
    instrument_rq_queue_with_logbrew_spans,
    instrument_rq_worker_processes_with_logbrew,
    rq_operation_with_logbrew_span,
)
from logbrew_sdk._span_events import (
    SpanAttributes,
    SpanEventSummary,
    SpanLinkSummary,
)
from logbrew_sdk._sqlalchemy_client import (
    LogBrewSqlAlchemyInstrumentation,
    instrument_sqlalchemy_engine_with_logbrew_spans,
)
from logbrew_sdk._support_ticket import (
    SupportDiagnosticsValue,
    SupportTicketCategory,
    SupportTicketDraft,
    SupportTicketSource,
)
from logbrew_sdk._telemetry_context import (
    TelemetryApplication,
    TelemetryContext,
    TelemetryDeployment,
    TelemetryDevice,
    TelemetryNamedVersion,
    TelemetryOperatingSystem,
    TelemetryResource,
    TelemetrySessionContext,
    TelemetrySubjectContext,
    TelemetryTraceContext,
)
from logbrew_sdk._timeline import (
    create_network_milestone_attributes,
    create_product_action_attributes,
)
from logbrew_sdk._trace_context import (
    LogBrewTraceContext,
    get_active_logbrew_trace,
    trace_metadata,
    use_logbrew_trace,
)
from logbrew_sdk._user_context import (
    set_logbrew_user,
)

# Keep the long-standing public identity of classes whose implementation moved to _client.
# get_type_hints reads names from a class's module, so resolve the annotations in _client first.
for _moved in (SdkError, TransportError, RecordingTransport, HttpTransport, LogBrewClient):
    _moved.__annotations__ = _typing.get_type_hints(_moved, include_extras=True)
    _moved.__module__ = __name__
del _moved, _typing


__all__ = [
    "ActionAttributes",
    "EnvironmentAttributes",
    "EventDrop",
    "EventDropReason",
    "HttpTransport",
    "IssueAttributes",
    "IssueBreadcrumb",
    "IssueBreadcrumbDataValue",
    "IssueBreadcrumbLevel",
    "IssueBreadcrumbLevelInput",
    "IssueDiagnosticEvidence",
    "IssueException",
    "IssueExceptionChain",
    "IssueExceptionChainEntry",
    "IssueExceptionMechanism",
    "IssueExceptionMessageState",
    "IssueExceptionRelationship",
    "IssueExceptionStackFramesState",
    "IssueImpactEvidence",
    "IssueLikelyFixArea",
    "IssueStackFrame",
    "LogAttributes",
    "LogBrewAiohttpClientSessionInstrumentation",
    "LogBrewArqPoolInstrumentation",
    "LogBrewArqWorkerInstrumentation",
    "LogBrewBreadcrumbHandler",
    "LogBrewCeleryInstrumentation",
    "LogBrewCeleryWorkerLifecycle",
    "LogBrewClient",
    "LogBrewDbapiConnection",
    "LogBrewDbapiCursor",
    "LogBrewDjangoCacheInstrumentation",
    "LogBrewDramatiqInstrumentation",
    "LogBrewFlaskCacheInstrumentation",
    "LogBrewHttpxClientInstrumentation",
    "LogBrewLoggingHandler",
    "LogBrewOpenTelemetrySpanExporter",
    "LogBrewOpenTelemetrySpanProcessor",
    "LogBrewPymemcacheInstrumentation",
    "LogBrewRedisInstrumentation",
    "LogBrewRequestsSessionInstrumentation",
    "LogBrewRqQueueInstrumentation",
    "LogBrewRqWorkerInstrumentation",
    "LogBrewSqlAlchemyInstrumentation",
    "LogBrewTraceContext",
    "Metadata",
    "MetadataValue",
    "MetricAttributes",
    "ProcessErrorCapture",
    "RecordingTransport",
    "ReleaseAttributes",
    "SdkError",
    "SpanAttributes",
    "SpanEventSummary",
    "SpanLinkSummary",
    "SupportDiagnosticsValue",
    "SupportTicketCategory",
    "SupportTicketDraft",
    "SupportTicketSource",
    "TelemetryApplication",
    "TelemetryContext",
    "TelemetryDeployment",
    "TelemetryDevice",
    "TelemetryNamedVersion",
    "TelemetryOperatingSystem",
    "TelemetryResource",
    "TelemetrySessionContext",
    "TelemetrySubjectContext",
    "TelemetryTraceContext",
    "TraceparentContext",
    "Transport",
    "TransportError",
    "TransportResponse",
    "add_logbrew_breadcrumb",
    "aiohttp_request_with_logbrew_span",
    "async_cache_operation_with_logbrew_span",
    "async_database_operation_with_logbrew_span",
    "async_httpx_request_with_logbrew_span",
    "async_queue_operation_with_logbrew_span",
    "cache_operation_with_logbrew_span",
    "celery_operation_with_logbrew_span",
    "celery_worker_persistent_queue_directory",
    "connect_dbapi_connection_with_logbrew_spans",
    "create_celery_trace_headers",
    "create_issue_attributes_from_exception",
    "create_logbrew_open_telemetry_span_exporter",
    "create_logbrew_open_telemetry_span_processor",
    "create_logbrew_trace_context",
    "create_network_milestone_attributes",
    "create_product_action_attributes",
    "create_support_ticket_draft",
    "create_traceparent",
    "create_traceparent_headers",
    "database_operation_with_logbrew_span",
    "get_active_logbrew_trace",
    "httpx_request_with_logbrew_span",
    "install_process_error_capture",
    "instrument_aiohttp_client_session_with_logbrew_spans",
    "instrument_arq_pool_with_logbrew_spans",
    "instrument_arq_worker_with_logbrew_spans",
    "instrument_celery_app_with_logbrew_spans",
    "instrument_celery_worker_processes_with_logbrew",
    "instrument_dbapi_connection_with_logbrew_spans",
    "instrument_django_cache_with_logbrew_spans",
    "instrument_dramatiq_broker_with_logbrew_spans",
    "instrument_flask_cache_with_logbrew_spans",
    "instrument_httpx_client_with_logbrew_spans",
    "instrument_pymemcache_client_with_logbrew_spans",
    "instrument_redis_client_with_logbrew_spans",
    "instrument_requests_session_with_logbrew_spans",
    "instrument_rq_queue_with_logbrew_spans",
    "instrument_rq_worker_processes_with_logbrew",
    "instrument_sqlalchemy_engine_with_logbrew_spans",
    "log_attributes_from_record",
    "logbrew_trace_context_from_celery_headers",
    "logbrew_trace_context_from_current_open_telemetry_span",
    "logbrew_trace_context_from_open_telemetry_span",
    "logbrew_trace_context_from_open_telemetry_span_context",
    "parse_traceparent",
    "queue_operation_with_logbrew_span",
    "requests_request_with_logbrew_span",
    "rq_operation_with_logbrew_span",
    "set_logbrew_user",
    "span_attributes_from_open_telemetry_readable_span",
    "span_attributes_from_trace_context",
    "span_attributes_from_traceparent",
    "trace_metadata",
    "urlopen_with_logbrew_span",
    "use_logbrew_trace",
]
