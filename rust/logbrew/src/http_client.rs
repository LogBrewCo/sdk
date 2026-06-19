use crate::http_fields::{
    insert_optional, normalize_method, sanitize_route_template, status_code_class,
    telemetry_metadata, validate_duration_ms, validate_status_code,
};
use crate::metadata_safety::sanitized_metadata;
use crate::{Metadata, SdkError, SpanEvent, Traceparent, TraceparentContext, TraceparentSpanInput};
use serde_json::Value;
#[cfg(feature = "http")]
use std::time::Instant;

#[derive(Clone, Debug, PartialEq)]
/// Explicit app-owned outbound HTTP span builder.
pub struct HttpClientSpan {
    route_template: String,
    method: String,
    span_id: String,
    status_code: Option<u16>,
    duration_ms: Option<f64>,
    error_type: Option<String>,
    metadata: Option<Metadata>,
}

impl HttpClientSpan {
    /// Create an outbound HTTP span with app-owned route, method, and child span ID.
    pub fn new(
        route_template: impl Into<String>,
        method: impl Into<String>,
        span_id: impl Into<String>,
    ) -> Self {
        Self {
            route_template: route_template.into(),
            method: method.into(),
            span_id: span_id.into(),
            status_code: None,
            duration_ms: None,
            error_type: None,
            metadata: None,
        }
    }

    /// Attach an HTTP response status code.
    pub fn with_status_code(mut self, status_code: u16) -> Self {
        self.status_code = Some(status_code);
        self
    }

    /// Attach a non-negative client request duration in milliseconds.
    pub fn with_duration_ms(mut self, duration_ms: f64) -> Self {
        self.duration_ms = Some(duration_ms);
        self
    }

    /// Mark the span as failed and attach only the public exception type name.
    pub fn with_error_type(mut self, error_type: impl Into<String>) -> Self {
        self.error_type = Some(error_type.into());
        self
    }

    /// Attach primitive app-owned metadata; unsafe key names and non-primitives are dropped.
    pub fn with_metadata(mut self, metadata: Metadata) -> Self {
        self.metadata = Some(sanitized_metadata(metadata));
        self
    }

    /// Build the outbound span plus the exact W3C `traceparent` header value to send.
    pub fn from_traceparent_context(
        self,
        context: &TraceparentContext,
    ) -> Result<HttpClientSpanEvents, SdkError> {
        let route = sanitize_route_template("http client route_template", self.route_template)?;
        let method = normalize_method("http client method", &self.method)?;
        validate_status_code("http client status_code", self.status_code)?;
        validate_duration_ms("http client duration_ms", self.duration_ms)?;

        let span_id = self.span_id;
        let outgoing_traceparent =
            Traceparent::create(&context.trace_id, &span_id, &context.trace_flags)?;
        let status = client_span_status(self.status_code, self.error_type.as_deref());
        let span_name = format!("http.client:{method} {route}");
        let mut span = Traceparent::span_attributes_from_context(
            context,
            TraceparentSpanInput::new(span_name, span_id.clone(), status),
        )?;
        if let Some(duration_ms) = self.duration_ms {
            span = span.with_duration_ms(duration_ms);
        }

        let metadata = client_metadata(
            &route,
            &method,
            self.status_code,
            self.error_type,
            self.metadata,
        )?;
        Ok(HttpClientSpanEvents {
            span: span.with_metadata(metadata),
            trace_id: context.trace_id.clone(),
            span_id,
            parent_span_id: Some(context.parent_span_id.clone()),
            outgoing_traceparent,
        })
    }

    /// Run an explicit `ureq` call with one W3C propagation header and queue one span.
    #[cfg(feature = "http")]
    pub fn capture_ureq_call<F>(
        self,
        client: &mut crate::LogBrewClient,
        event_id: impl AsRef<str>,
        timestamp: impl AsRef<str>,
        context: &TraceparentContext,
        call: F,
    ) -> Result<ureq::http::Response<ureq::Body>, ureq::Error>
    where
        F: FnOnce(&str) -> Result<ureq::http::Response<ureq::Body>, ureq::Error>,
    {
        let prepared = self
            .clone()
            .from_traceparent_context(context)
            .map_err(ureq_error_from_sdk)?;
        let started = Instant::now();
        let result = call(&prepared.outgoing_traceparent);
        let duration_ms = started.elapsed().as_secs_f64() * 1000.0;

        let mut span = self.with_duration_ms(duration_ms);
        match &result {
            Ok(response) => {
                span = span.with_status_code(response.status().as_u16());
            }
            Err(error) => {
                if let ureq::Error::StatusCode(status_code) = error {
                    span = span.with_status_code(*status_code);
                }
                span = span.with_error_type(ureq_error_type(error));
            }
        }

        if let Ok(events) = span.from_traceparent_context(context) {
            let _ = client.span(event_id.as_ref(), timestamp.as_ref(), events.span);
        }
        result
    }
}

#[derive(Clone, Debug, PartialEq)]
/// Built outbound HTTP span and propagation header for app-owned clients.
pub struct HttpClientSpanEvents {
    /// Span event that represents the outbound HTTP call.
    pub span: SpanEvent,
    /// Trace ID used by the outbound span.
    pub trace_id: String,
    /// Child span ID used by the outbound span and propagation header.
    pub span_id: String,
    /// Parent span ID copied from the incoming/current context.
    pub parent_span_id: Option<String>,
    /// Exact W3C `traceparent` header value the app-owned client should set.
    pub outgoing_traceparent: String,
}

fn client_metadata(
    route: &str,
    method: &str,
    status_code: Option<u16>,
    error_type: Option<String>,
    metadata: Option<Metadata>,
) -> Result<Metadata, SdkError> {
    let mut metadata = telemetry_metadata("rust_http_client", metadata)?;
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
    insert_optional(&mut metadata, "exception.type", error_type);
    Ok(metadata)
}

fn client_span_status(status_code: Option<u16>, error_type: Option<&str>) -> &'static str {
    if error_type.is_some() || status_code.is_some_and(|status_code| status_code >= 400) {
        "error"
    } else {
        "ok"
    }
}

#[cfg(feature = "http")]
fn ureq_error_from_sdk(error: SdkError) -> ureq::Error {
    ureq::Error::BadUri(format!(
        "logbrew http client span setup failed: {}",
        error.message
    ))
}

#[cfg(feature = "http")]
fn ureq_error_type(error: &ureq::Error) -> &'static str {
    match error {
        ureq::Error::StatusCode(_) => "ureq::StatusCode",
        ureq::Error::Http(_) => "ureq::Http",
        ureq::Error::BadUri(_) => "ureq::BadUri",
        ureq::Error::Protocol(_) => "ureq::Protocol",
        ureq::Error::Io(_) => "ureq::Io",
        ureq::Error::Timeout(_) => "ureq::Timeout",
        ureq::Error::HostNotFound => "ureq::HostNotFound",
        ureq::Error::RedirectFailed => "ureq::RedirectFailed",
        ureq::Error::InvalidProxyUrl => "ureq::InvalidProxyUrl",
        ureq::Error::ConnectionFailed => "ureq::ConnectionFailed",
        ureq::Error::BodyExceedsLimit(_) => "ureq::BodyExceedsLimit",
        ureq::Error::TooManyRedirects => "ureq::TooManyRedirects",
        ureq::Error::Tls(_) => "ureq::Tls",
        _ => "ureq::Error",
    }
}
