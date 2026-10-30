use crate::http_fields::{
    normalize_method, sanitize_route_template, status_code_class, telemetry_metadata,
    validate_duration_ms, validate_status_code,
};
use crate::issue_diagnostics::require_exception_type;
use crate::{
    Metadata, MetricEvent, SdkError, SpanEvent, TelemetryContext, TelemetryTraceContext,
    Traceparent, TraceparentSpanInput, merge_telemetry_contexts,
};
use serde_json::Value;

const DEFAULT_TRACE_FLAGS: &str = "01";

#[derive(Clone, Debug, PartialEq)]
/// App-owned HTTP server telemetry built from framework request metadata.
pub struct HttpRequestTelemetry {
    route_template: String,
    method: String,
    trace_id: String,
    span_id: String,
    trace_flags: String,
    incoming_traceparent: Option<String>,
    status_code: Option<u16>,
    error_type: Option<String>,
    duration_ms: Option<f64>,
    metadata: Option<Metadata>,
    span_name: Option<String>,
    metric_name: String,
    context: Option<TelemetryContext>,
}

impl HttpRequestTelemetry {
    /// Build the request span plus an optional duration metric.
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when an input fails validation.
    #[inline]
    pub fn build(self) -> Result<HttpRequestTelemetryEvents, SdkError> {
        let explicit_context = self.context.clone();
        let route = sanitize_route_template("http request route_template", &self.route_template)?;
        let method = normalize_method("http request method", &self.method)?;
        validate_status_code("http request status_code", self.status_code)?;
        validate_duration_ms("http request duration_ms", self.duration_ms)?;
        let error_type = self
            .error_type
            .as_deref()
            .map(require_exception_type)
            .transpose()?;

        let parsed_context = self
            .incoming_traceparent
            .as_deref()
            .and_then(|traceparent| Traceparent::parse(traceparent).ok());
        let trace_flags = parsed_context.as_ref().map_or_else(
            || self.trace_flags.trim(),
            |context| context.trace_flags.as_str(),
        );
        let trace_id = parsed_context
            .as_ref()
            .map_or_else(|| self.trace_id.trim(), |context| context.trace_id.as_str());
        let span_id = self.span_id.trim().to_ascii_lowercase();
        let outgoing_traceparent = Traceparent::create(trace_id, &span_id, trace_flags)?;

        let span_name = match self.span_name {
            Some(span_name) => {
                crate::require_non_empty("http request span name", &span_name)?;
                span_name.trim().to_owned()
            }
            None => format!("{method} {route}"),
        };
        let status = request_span_status(self.status_code, error_type.as_deref());
        let metadata = request_metadata(
            &route,
            &method,
            self.status_code,
            error_type.as_deref(),
            self.metadata,
        )?;

        let mut span = if let Some(context) = parsed_context.as_ref() {
            let mut input = TraceparentSpanInput::new(span_name, &span_id, status);
            if let Some(duration_ms) = self.duration_ms {
                input = input.with_duration_ms(duration_ms);
            }
            Traceparent::span_attributes_from_context(
                context,
                input.with_metadata(metadata.clone()),
            )?
        } else {
            let mut span = SpanEvent::new(span_name, trace_id, &span_id, status);
            if let Some(duration_ms) = self.duration_ms {
                span = span.with_duration_ms(duration_ms);
            }
            span.with_metadata(metadata.clone())
        };
        let mut trace = TelemetryTraceContext::new(trace_id).with_span_id(&span_id);
        if let Some(parent_span_id) = parsed_context
            .as_ref()
            .map(|context| context.parent_span_id.as_str())
        {
            trace = trace.with_parent_span_id(parent_span_id);
        }
        let sampled = parsed_context.as_ref().map_or_else(
            || trace_flags_sampled(trace_flags),
            |context| context.sampled,
        );
        trace = trace.with_sampled(sampled);
        let trace_context = TelemetryContext::new().with_trace(trace);
        let context = merge_telemetry_contexts(Some(&trace_context), explicit_context.as_ref())?
            .unwrap_or(trace_context);
        span = span.with_context(context.clone());
        let metric = self.duration_ms.map(|duration_ms| {
            MetricEvent::new(self.metric_name, "histogram", duration_ms, "ms", "delta")
                .with_description("Duration of one completed server request.")
                .with_metadata(metadata)
                .with_context(context)
        });

        Ok(HttpRequestTelemetryEvents {
            span,
            metric,
            trace_id: trace_id.to_owned(),
            span_id,
            parent_span_id: parsed_context.map(|parsed| parsed.parent_span_id),
            sampled,
            outgoing_traceparent,
        })
    }

    /// Create request telemetry from app-owned route, method, trace, and child span IDs.
    #[inline]
    pub fn new<RouteTemplate, Method, TraceId, SpanId>(
        route_template: RouteTemplate,
        method: Method,
        trace_id: TraceId,
        span_id: SpanId,
    ) -> Self
    where
        RouteTemplate: Into<String>,
        Method: Into<String>,
        TraceId: Into<String>,
        SpanId: Into<String>,
    {
        Self {
            route_template: route_template.into(),
            method: method.into(),
            trace_id: trace_id.into(),
            span_id: span_id.into(),
            trace_flags: DEFAULT_TRACE_FLAGS.to_owned(),
            incoming_traceparent: None,
            status_code: None,
            error_type: None,
            duration_ms: None,
            metadata: None,
            span_name: None,
            metric_name: "http.server.duration".to_owned(),
            context: None,
        }
    }

    /// Attach shared event context; effective request trace identity is merged into it.
    #[must_use]
    #[inline]
    pub fn with_context(mut self, context: TelemetryContext) -> Self {
        self.context = Some(context);
        self
    }

    /// Attach request duration in milliseconds. When absent, no metric event is built.
    #[must_use]
    #[inline]
    pub const fn with_duration_ms(mut self, duration_ms: f64) -> Self {
        self.duration_ms = Some(duration_ms);
        self
    }

    /// Mark the request span as failed with a bounded exception type only.
    #[must_use]
    #[inline]
    pub fn with_error_type<ErrorType>(mut self, error_type: ErrorType) -> Self
    where
        ErrorType: Into<String>,
    {
        self.error_type = Some(error_type.into());
        self
    }

    /// Attach an incoming W3C traceparent. Malformed values fall back to the explicit trace ID.
    #[must_use]
    #[inline]
    pub fn with_incoming_traceparent<TraceparentInput>(
        mut self,
        traceparent: TraceparentInput,
    ) -> Self
    where
        TraceparentInput: Into<String>,
    {
        self.incoming_traceparent = Some(traceparent.into());
        self
    }

    /// Attach primitive, low-cardinality request metadata.
    #[must_use]
    #[inline]
    pub fn with_metadata(mut self, metadata: Metadata) -> Self {
        self.metadata = Some(metadata);
        self
    }

    /// Override the default request-duration metric name.
    #[must_use]
    #[inline]
    pub fn with_metric_name<MetricName>(mut self, metric_name: MetricName) -> Self
    where
        MetricName: Into<String>,
    {
        self.metric_name = metric_name.into();
        self
    }

    /// Override the default span name of `METHOD routeTemplate`.
    #[must_use]
    #[inline]
    pub fn with_span_name<SpanName>(mut self, span_name: SpanName) -> Self
    where
        SpanName: Into<String>,
    {
        self.span_name = Some(span_name.into());
        self
    }

    /// Attach the final HTTP status code.
    #[must_use]
    #[inline]
    pub const fn with_status_code(mut self, status_code: u16) -> Self {
        self.status_code = Some(status_code);
        self
    }

    /// Override outgoing trace flags used when no valid incoming traceparent is present.
    #[must_use]
    #[inline]
    pub fn with_trace_flags<TraceFlags>(mut self, trace_flags: TraceFlags) -> Self
    where
        TraceFlags: Into<String>,
    {
        self.trace_flags = trace_flags.into();
        self
    }
}

#[derive(Clone, Debug, PartialEq)]
/// Request span and optional duration metric built for queueing on `LogBrewClient`.
pub struct HttpRequestTelemetryEvents {
    /// Span event that represents the handled HTTP request.
    pub span: SpanEvent,
    /// Optional `http.server.duration` histogram metric when duration was provided.
    pub metric: Option<MetricEvent>,
    /// Effective trace ID used for span and outgoing propagation.
    pub trace_id: String,
    /// Effective child span ID used for span and outgoing propagation.
    pub span_id: String,
    /// Parent span ID when a valid incoming traceparent was continued.
    pub parent_span_id: Option<String>,
    /// Whether the effective W3C trace sampled bit is set.
    pub sampled: bool,
    /// Outgoing W3C traceparent header value for downstream app-owned clients.
    pub outgoing_traceparent: String,
}

fn trace_flags_sampled(trace_flags: &str) -> bool {
    u8::from_str_radix(trace_flags.trim(), 16).is_ok_and(|flags| flags & 1 == 1)
}

fn request_metadata(
    route: &str,
    method: &str,
    status_code: Option<u16>,
    error_type: Option<&str>,
    metadata: Option<Metadata>,
) -> Result<Metadata, SdkError> {
    let mut fields = telemetry_metadata("rust_http_server", metadata)?;
    drop(fields.insert("routeTemplate".to_owned(), Value::String(route.to_owned())));
    drop(fields.insert("method".to_owned(), Value::String(method.to_owned())));
    if let Some(code) = status_code {
        drop(fields.insert("statusCode".to_owned(), Value::from(code)));
        drop(fields.insert(
            "statusCodeClass".to_owned(),
            Value::String(status_code_class(code)),
        ));
    }
    if let Some(exception_type) = error_type {
        drop(fields.insert(
            "exception.type".to_owned(),
            Value::String(exception_type.to_owned()),
        ));
    }
    Ok(fields)
}

fn request_span_status(status_code: Option<u16>, error_type: Option<&str>) -> &'static str {
    if error_type.is_some() || status_code.is_some_and(|code| code >= 500) {
        "error"
    } else {
        "ok"
    }
}
