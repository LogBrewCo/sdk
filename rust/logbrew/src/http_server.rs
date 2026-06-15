use crate::http_fields::{
    normalize_method, sanitize_route_template, status_code_class, telemetry_metadata,
    validate_duration_ms, validate_status_code,
};
use crate::{Metadata, MetricEvent, SdkError, SpanEvent, Traceparent, TraceparentSpanInput};
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
    duration_ms: Option<f64>,
    metadata: Option<Metadata>,
    span_name: Option<String>,
    metric_name: String,
}

impl HttpRequestTelemetry {
    /// Create request telemetry from app-owned route, method, trace, and child span IDs.
    pub fn new(
        route_template: impl Into<String>,
        method: impl Into<String>,
        trace_id: impl Into<String>,
        span_id: impl Into<String>,
    ) -> Self {
        Self {
            route_template: route_template.into(),
            method: method.into(),
            trace_id: trace_id.into(),
            span_id: span_id.into(),
            trace_flags: DEFAULT_TRACE_FLAGS.to_string(),
            incoming_traceparent: None,
            status_code: None,
            duration_ms: None,
            metadata: None,
            span_name: None,
            metric_name: "http.server.duration".to_string(),
        }
    }

    /// Attach an incoming W3C traceparent. Malformed values fall back to the explicit trace ID.
    pub fn with_incoming_traceparent(mut self, traceparent: impl Into<String>) -> Self {
        self.incoming_traceparent = Some(traceparent.into());
        self
    }

    /// Override outgoing trace flags used when no valid incoming traceparent is present.
    pub fn with_trace_flags(mut self, trace_flags: impl Into<String>) -> Self {
        self.trace_flags = trace_flags.into();
        self
    }

    /// Attach the final HTTP status code.
    pub fn with_status_code(mut self, status_code: u16) -> Self {
        self.status_code = Some(status_code);
        self
    }

    /// Attach request duration in milliseconds. When absent, no metric event is built.
    pub fn with_duration_ms(mut self, duration_ms: f64) -> Self {
        self.duration_ms = Some(duration_ms);
        self
    }

    /// Attach primitive, low-cardinality request metadata.
    pub fn with_metadata(mut self, metadata: Metadata) -> Self {
        self.metadata = Some(metadata);
        self
    }

    /// Override the default span name of `METHOD routeTemplate`.
    pub fn with_span_name(mut self, span_name: impl Into<String>) -> Self {
        self.span_name = Some(span_name.into());
        self
    }

    /// Override the default request-duration metric name.
    pub fn with_metric_name(mut self, metric_name: impl Into<String>) -> Self {
        self.metric_name = metric_name.into();
        self
    }

    /// Build the request span plus an optional duration metric.
    pub fn build(self) -> Result<HttpRequestTelemetryEvents, SdkError> {
        let route = sanitize_route_template("http request route_template", self.route_template)?;
        let method = normalize_method("http request method", &self.method)?;
        validate_status_code("http request status_code", self.status_code)?;
        validate_duration_ms("http request duration_ms", self.duration_ms)?;

        let parsed_context = self
            .incoming_traceparent
            .as_deref()
            .and_then(|traceparent| Traceparent::parse(traceparent).ok());
        let trace_flags = parsed_context
            .as_ref()
            .map(|context| context.trace_flags.as_str())
            .unwrap_or_else(|| self.trace_flags.trim());
        let trace_id = parsed_context
            .as_ref()
            .map(|context| context.trace_id.as_str())
            .unwrap_or_else(|| self.trace_id.trim());
        let span_id = self.span_id.trim().to_ascii_lowercase();
        let outgoing_traceparent = Traceparent::create(trace_id, &span_id, trace_flags)?;

        let span_name = match self.span_name {
            Some(span_name) => {
                crate::require_non_empty("http request span name", &span_name)?;
                span_name.trim().to_string()
            }
            None => format!("{method} {route}"),
        };
        let status = request_span_status(self.status_code);
        let metadata = request_metadata(&route, &method, self.status_code, self.metadata)?;

        let span = match parsed_context.as_ref() {
            Some(context) => {
                let mut input = TraceparentSpanInput::new(span_name, &span_id, status);
                if let Some(duration_ms) = self.duration_ms {
                    input = input.with_duration_ms(duration_ms);
                }
                Traceparent::span_attributes_from_context(
                    context,
                    input.with_metadata(metadata.clone()),
                )?
            }
            None => {
                let mut span = SpanEvent::new(span_name, trace_id, &span_id, status);
                if let Some(duration_ms) = self.duration_ms {
                    span = span.with_duration_ms(duration_ms);
                }
                span.with_metadata(metadata.clone())
            }
        };
        let metric = self.duration_ms.map(|duration_ms| {
            MetricEvent::new(self.metric_name, "histogram", duration_ms, "ms", "delta")
                .with_metadata(metadata)
        });

        Ok(HttpRequestTelemetryEvents {
            span,
            metric,
            trace_id: trace_id.to_string(),
            span_id,
            parent_span_id: parsed_context.map(|context| context.parent_span_id),
            outgoing_traceparent,
        })
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
    /// Outgoing W3C traceparent header value for downstream app-owned clients.
    pub outgoing_traceparent: String,
}

fn request_metadata(
    route: &str,
    method: &str,
    status_code: Option<u16>,
    metadata: Option<Metadata>,
) -> Result<Metadata, SdkError> {
    let mut metadata = telemetry_metadata("rust_http_server", metadata)?;
    metadata.insert(
        "routeTemplate".to_string(),
        Value::String(route.to_string()),
    );
    metadata.insert("method".to_string(), Value::String(method.to_string()));
    if let Some(status_code) = status_code {
        metadata.insert("statusCode".to_string(), Value::from(status_code));
        metadata.insert(
            "statusCodeClass".to_string(),
            Value::String(status_code_class(status_code)),
        );
    }
    Ok(metadata)
}

fn request_span_status(status_code: Option<u16>) -> &'static str {
    if status_code.is_some_and(|code| code >= 500) {
        "error"
    } else {
        "ok"
    }
}
