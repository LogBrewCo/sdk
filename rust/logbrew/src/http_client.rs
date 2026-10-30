#[cfg(any(feature = "http", feature = "hyper", feature = "reqwest"))]
use crate::http_fields::duration_millis;
use crate::http_fields::{
    insert_optional, normalize_method, sanitize_route_template, status_code_class,
    telemetry_metadata, validate_duration_ms, validate_status_code,
};
use crate::metadata_safety::sanitized_metadata;
use crate::{
    Metadata, SdkError, SpanEvent, TelemetryContext, TelemetryTraceContext, Traceparent,
    TraceparentContext, TraceparentSpanInput, merge_telemetry_contexts,
};
#[cfg(feature = "hyper")]
use core::any::type_name;
#[cfg(any(feature = "hyper", feature = "reqwest"))]
use core::error::Error;
#[cfg(any(feature = "hyper", feature = "reqwest"))]
use core::fmt;
use serde_json::Value;
#[cfg(any(feature = "http", feature = "hyper", feature = "reqwest"))]
use std::time::Instant;
#[cfg(feature = "http")]
use ureq::http;

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
    context: Option<TelemetryContext>,
}

impl HttpClientSpan {
    pub(crate) fn build_from_trace_parts(
        self,
        trace_id: &str,
        parent_span_id: Option<&str>,
        trace_flags: &str,
    ) -> Result<HttpClientSpanEvents, SdkError> {
        let explicit_context = self.context.clone();
        let route = sanitize_route_template("http client route_template", &self.route_template)?;
        let method = normalize_method("http client method", &self.method)?;
        validate_status_code("http client status_code", self.status_code)?;
        validate_duration_ms("http client duration_ms", self.duration_ms)?;

        let span_id = self.span_id;
        let outgoing_traceparent = Traceparent::create(trace_id, &span_id, trace_flags)?;
        let status = client_span_status(self.status_code, self.error_type.as_deref());
        let span_name = format!("http.client:{method} {route}");
        let mut span = match parent_span_id {
            Some(parent) => {
                let context = Traceparent::parse(format!(
                    "00-{}-{}-{}",
                    trace_id.trim(),
                    parent.trim(),
                    trace_flags.trim()
                ))?;
                Traceparent::span_attributes_from_context(
                    &context,
                    TraceparentSpanInput::new(span_name, span_id.clone(), status),
                )?
            }
            None => SpanEvent::new(
                span_name,
                trace_id.trim().to_ascii_lowercase(),
                &span_id,
                status,
            ),
        };
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
        let mut trace = TelemetryTraceContext::new(trace_id).with_span_id(&span_id);
        if let Some(parent) = parent_span_id {
            trace = trace.with_parent_span_id(parent);
        }
        trace = trace.with_sampled(trace_flags_sampled(trace_flags));
        let trace_context = TelemetryContext::new().with_trace(trace);
        let context = merge_telemetry_contexts(Some(&trace_context), explicit_context.as_ref())?
            .unwrap_or(trace_context);
        Ok(HttpClientSpanEvents {
            span: span.with_metadata(metadata).with_context(context),
            trace_id: trace_id.trim().to_ascii_lowercase(),
            span_id,
            parent_span_id: parent_span_id.map(|parent| parent.trim().to_ascii_lowercase()),
            outgoing_traceparent,
        })
    }

    /// Send an app-owned `http::Request` with one W3C propagation header and queue one span.
    ///
    /// # Errors
    ///
    /// Returns the request error unchanged, or a setup error when the span inputs fail validation.
    #[cfg(feature = "hyper")]
    #[inline]
    pub async fn capture_http_request_send<ReqBody, ResBody, E, F, Fut, EventId, Timestamp>(
        self,
        client: &mut crate::LogBrewClient,
        event_id: EventId,
        timestamp: Timestamp,
        context: &TraceparentContext,
        mut request: http_types::Request<ReqBody>,
        send: F,
    ) -> Result<http_types::Response<ResBody>, HttpRequestCaptureError<E>>
    where
        F: FnOnce(http_types::Request<ReqBody>) -> Fut,
        Fut: Future<Output = Result<http_types::Response<ResBody>, E>>,
        EventId: AsRef<str>,
        Timestamp: AsRef<str>,
    {
        let prepared = self
            .clone()
            .from_traceparent_context(context)
            .map_err(HttpRequestCaptureError::Setup)?;
        let value =
            http_types::HeaderValue::from_str(&prepared.outgoing_traceparent).map_err(|error| {
                HttpRequestCaptureError::Setup(SdkError::new("validation_error", error.to_string()))
            })?;
        drop(request.headers_mut().insert("traceparent", value));

        let started = Instant::now();
        let result = send(request).await;
        let duration_ms = duration_millis(started.elapsed());

        let mut span = self.with_duration_ms(duration_ms);
        match result.as_ref() {
            Ok(response) => {
                span = span.with_status_code(response.status().as_u16());
            }
            Err(_) => {
                span = span.with_error_type(type_name::<E>());
            }
        }

        if let Ok(events) = span.from_traceparent_context(context) {
            drop(client.span(event_id.as_ref(), timestamp.as_ref(), events.span));
        }

        result.map_err(HttpRequestCaptureError::Request)
    }

    /// Send an explicit `reqwest` request with one W3C propagation header and queue one span.
    ///
    /// # Errors
    ///
    /// Returns the request error unchanged, or a setup error when the span inputs fail validation.
    #[cfg(feature = "reqwest")]
    #[inline]
    pub async fn capture_reqwest_send<EventIdInput, TimestampInput>(
        self,
        client: &mut crate::LogBrewClient,
        event_id: EventIdInput,
        timestamp: TimestampInput,
        context: &TraceparentContext,
        request: reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, ReqwestCaptureError>
    where
        EventIdInput: AsRef<str>,
        TimestampInput: AsRef<str>,
    {
        let prepared = self
            .clone()
            .from_traceparent_context(context)
            .map_err(ReqwestCaptureError::Setup)?;
        let started = Instant::now();
        let result = request
            .header("traceparent", prepared.outgoing_traceparent)
            .send()
            .await;
        let duration_ms = duration_millis(started.elapsed());

        let mut span = self.with_duration_ms(duration_ms);
        match result.as_ref() {
            Ok(response) => {
                span = span.with_status_code(response.status().as_u16());
            }
            Err(error) => {
                if let Some(status_code) = error.status() {
                    span = span.with_status_code(status_code.as_u16());
                }
                span = span.with_error_type("reqwest::Error");
            }
        }

        if let Ok(events) = span.from_traceparent_context(context) {
            drop(client.span(event_id.as_ref(), timestamp.as_ref(), events.span));
        }

        result.map_err(ReqwestCaptureError::Request)
    }

    /// Run an explicit `ureq` call with one W3C propagation header and queue one span.
    ///
    /// # Errors
    ///
    /// Returns the error from `call` unchanged, or a `ureq` error that wraps the validation
    /// failure when the span inputs are invalid.
    #[cfg(feature = "http")]
    #[inline]
    pub fn capture_ureq_call<F, EventIdInput, TimestampInput>(
        self,
        client: &mut crate::LogBrewClient,
        event_id: EventIdInput,
        timestamp: TimestampInput,
        context: &TraceparentContext,
        call: F,
    ) -> Result<http::Response<ureq::Body>, ureq::Error>
    where
        F: FnOnce(&str) -> Result<http::Response<ureq::Body>, ureq::Error>,
        EventIdInput: AsRef<str>,
        TimestampInput: AsRef<str>,
    {
        let prepared = self
            .clone()
            .from_traceparent_context(context)
            .map_err(|error| ureq_error_from_sdk(&error))?;
        let started = Instant::now();
        let result = call(&prepared.outgoing_traceparent);
        let duration_ms = duration_millis(started.elapsed());

        let mut span = self.with_duration_ms(duration_ms);
        match result.as_ref() {
            Ok(response) => {
                span = span.with_status_code(response.status().as_u16());
            }
            Err(error) => {
                if let ureq::Error::StatusCode(status_code) = *error {
                    span = span.with_status_code(status_code);
                }
                span = span.with_error_type(ureq_error_type(error));
            }
        }

        if let Ok(events) = span.from_traceparent_context(context) {
            drop(client.span(event_id.as_ref(), timestamp.as_ref(), events.span));
        }
        result
    }

    /// Build the outbound span plus the exact W3C `traceparent` header value to send.
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when an input fails validation.
    #[inline]
    pub fn from_traceparent_context(
        self,
        context: &TraceparentContext,
    ) -> Result<HttpClientSpanEvents, SdkError> {
        self.build_from_trace_parts(
            &context.trace_id,
            Some(&context.parent_span_id),
            &context.trace_flags,
        )
    }

    /// Create an outbound HTTP span with app-owned route, method, and child span ID.
    #[inline]
    pub fn new<RouteTemplate, Method, SpanId>(
        route_template: RouteTemplate,
        method: Method,
        span_id: SpanId,
    ) -> Self
    where
        RouteTemplate: Into<String>,
        Method: Into<String>,
        SpanId: Into<String>,
    {
        Self {
            route_template: route_template.into(),
            method: method.into(),
            span_id: span_id.into(),
            status_code: None,
            duration_ms: None,
            error_type: None,
            metadata: None,
            context: None,
        }
    }

    /// Attach shared event context; effective outbound trace identity is merged into it.
    #[must_use]
    #[inline]
    pub fn with_context(mut self, context: TelemetryContext) -> Self {
        self.context = Some(context);
        self
    }

    /// Attach a non-negative client request duration in milliseconds.
    #[must_use]
    #[inline]
    pub const fn with_duration_ms(mut self, duration_ms: f64) -> Self {
        self.duration_ms = Some(duration_ms);
        self
    }

    /// Mark the span as failed and attach only the public exception type name.
    #[must_use]
    #[inline]
    pub fn with_error_type<ErrorType>(mut self, error_type: ErrorType) -> Self
    where
        ErrorType: Into<String>,
    {
        self.error_type = Some(error_type.into());
        self
    }

    /// Attach primitive app-owned metadata; unsafe key names and non-primitives are dropped.
    #[must_use]
    #[inline]
    pub fn with_metadata(mut self, metadata: Metadata) -> Self {
        self.metadata = Some(sanitized_metadata(metadata));
        self
    }

    /// Attach an HTTP response status code.
    #[must_use]
    #[inline]
    pub const fn with_status_code(mut self, status_code: u16) -> Self {
        self.status_code = Some(status_code);
        self
    }
}

#[cfg(feature = "hyper")]
#[derive(Debug, PartialEq, Eq)]
/// Error returned by explicit `http::Request` capture setup or the app-owned request.
pub enum HttpRequestCaptureError<E> {
    /// The app-owned HTTP request failed.
    Request(E),
    /// LogBrew rejected the span setup before sending the request.
    Setup(SdkError),
}

#[cfg(feature = "hyper")]
impl<E> fmt::Display for HttpRequestCaptureError<E>
where
    E: fmt::Display,
{
    #[inline]
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match *self {
            Self::Setup(ref error) => write!(f, "logbrew http request span setup failed: {error}"),
            Self::Request(ref error) => write!(f, "{error}"),
        }
    }
}

#[cfg(feature = "hyper")]
impl<E> Error for HttpRequestCaptureError<E>
where
    E: Error + 'static,
{
    #[inline]
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match *self {
            Self::Setup(ref error) => Some(error),
            Self::Request(ref error) => Some(error),
        }
    }
}

#[cfg(feature = "reqwest")]
#[derive(Debug)]
/// Error returned by explicit `reqwest` capture setup or the app-owned request.
pub enum ReqwestCaptureError {
    /// The app-owned `reqwest` request failed.
    Request(reqwest::Error),
    /// LogBrew rejected the span setup before sending the request.
    Setup(SdkError),
}

#[cfg(feature = "reqwest")]
impl fmt::Display for ReqwestCaptureError {
    #[inline]
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match *self {
            Self::Setup(ref error) => write!(f, "logbrew reqwest span setup failed: {error}"),
            Self::Request(ref error) => write!(f, "{error}"),
        }
    }
}

#[cfg(feature = "reqwest")]
impl Error for ReqwestCaptureError {
    #[inline]
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match *self {
            Self::Setup(ref error) => Some(error),
            Self::Request(ref error) => Some(error),
        }
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

fn trace_flags_sampled(trace_flags: &str) -> bool {
    u8::from_str_radix(trace_flags.trim(), 16).is_ok_and(|flags| flags & 1 == 1)
}

fn client_metadata(
    route: &str,
    method: &str,
    status_code: Option<u16>,
    error_type: Option<String>,
    metadata: Option<Metadata>,
) -> Result<Metadata, SdkError> {
    let mut fields = telemetry_metadata("rust_http_client", metadata)?;
    drop(fields.insert("routeTemplate".to_owned(), Value::String(route.to_owned())));
    drop(fields.insert("method".to_owned(), Value::String(method.to_owned())));
    if let Some(code) = status_code {
        drop(fields.insert("statusCode".to_owned(), Value::from(code)));
        drop(fields.insert(
            "statusCodeClass".to_owned(),
            Value::String(status_code_class(code)),
        ));
    }
    insert_optional(&mut fields, "exception.type", error_type);
    Ok(fields)
}

fn client_span_status(status_code: Option<u16>, error_type: Option<&str>) -> &'static str {
    if error_type.is_some() || status_code.is_some_and(|code| code >= 400) {
        "error"
    } else {
        "ok"
    }
}

#[cfg(feature = "http")]
fn ureq_error_from_sdk(error: &SdkError) -> ureq::Error {
    ureq::Error::BadUri(format!(
        "logbrew http client span setup failed: {}",
        error.message
    ))
}

#[cfg(feature = "http")]
const fn ureq_error_type(error: &ureq::Error) -> &'static str {
    match *error {
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
        ureq::Error::Pem(_)
        | ureq::Error::Rustls(_)
        | ureq::Error::RequireHttpsOnly(_)
        | ureq::Error::LargeResponseHeader(..)
        | ureq::Error::Decompress(..)
        | ureq::Error::ConnectProxyFailed(_)
        | ureq::Error::TlsRequired
        | ureq::Error::Other(_)
        | _ => "ureq::Error",
    }
}
