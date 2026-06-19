use crate::{
    HttpClientSpan, HttpRequestTelemetry, Metadata, SdkError, SharedLogBrewClient, Traceparent,
    require_non_empty,
};
use http_types::{HeaderValue, Request, Response};
use std::{
    future::Future,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Instant,
};
use tower::{Layer, Service};

/// App-provided trace and span identifiers for one Tower request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TowerRequestIds {
    /// Fallback trace ID used when there is no valid incoming W3C traceparent.
    pub trace_id: String,
    /// Child span ID used for the LogBrew request span and outgoing traceparent.
    pub span_id: String,
    /// Optional parent span ID used when no valid request traceparent is already present.
    pub parent_span_id: Option<String>,
}

impl TowerRequestIds {
    /// Create request IDs from app-owned trace and span generators.
    pub fn new(trace_id: impl Into<String>, span_id: impl Into<String>) -> Self {
        Self {
            trace_id: trace_id.into(),
            span_id: span_id.into(),
            parent_span_id: None,
        }
    }

    /// Attach an app-owned parent span ID for outbound client spans.
    pub fn with_parent_span_id(mut self, parent_span_id: impl Into<String>) -> Self {
        self.parent_span_id = Some(parent_span_id.into());
        self
    }
}

/// Optional Tower `Layer` that queues safe request span and duration metric events.
#[derive(Clone)]
pub struct TowerRequestTelemetryLayer<R, I, T> {
    client: SharedLogBrewClient,
    route_template: R,
    request_ids: I,
    timestamp: T,
    metadata: Metadata,
    span_event_id_prefix: String,
    metric_event_id_prefix: String,
}

impl<R, I, T> TowerRequestTelemetryLayer<R, I, T> {
    /// Build a Tower request telemetry layer from app-owned extraction and ID functions.
    pub fn new(
        client: SharedLogBrewClient,
        route_template: R,
        request_ids: I,
        timestamp: T,
    ) -> Self {
        Self {
            client,
            route_template,
            request_ids,
            timestamp,
            metadata: Metadata::new(),
            span_event_id_prefix: "evt_http_request_span".to_string(),
            metric_event_id_prefix: "evt_http_request_duration".to_string(),
        }
    }

    /// Attach primitive, low-cardinality metadata copied into every queued request event.
    pub fn with_metadata(mut self, metadata: Metadata) -> Self {
        self.metadata = metadata;
        self
    }

    /// Override event ID prefixes. The child span ID is appended to keep IDs stable per request.
    pub fn with_event_id_prefixes(
        mut self,
        span_event_id_prefix: impl Into<String>,
        metric_event_id_prefix: impl Into<String>,
    ) -> Self {
        self.span_event_id_prefix = span_event_id_prefix.into();
        self.metric_event_id_prefix = metric_event_id_prefix.into();
        self
    }
}

impl<S, R, I, T> Layer<S> for TowerRequestTelemetryLayer<R, I, T>
where
    R: Clone,
    I: Clone,
    T: Clone,
{
    type Service = TowerRequestTelemetryService<S, R, I, T>;

    fn layer(&self, inner: S) -> Self::Service {
        TowerRequestTelemetryService {
            inner,
            client: Arc::clone(&self.client),
            route_template: self.route_template.clone(),
            request_ids: self.request_ids.clone(),
            timestamp: self.timestamp.clone(),
            metadata: self.metadata.clone(),
            span_event_id_prefix: self.span_event_id_prefix.clone(),
            metric_event_id_prefix: self.metric_event_id_prefix.clone(),
        }
    }
}

/// Tower service produced by `TowerRequestTelemetryLayer`.
#[derive(Clone)]
pub struct TowerRequestTelemetryService<S, R, I, T> {
    inner: S,
    client: SharedLogBrewClient,
    route_template: R,
    request_ids: I,
    timestamp: T,
    metadata: Metadata,
    span_event_id_prefix: String,
    metric_event_id_prefix: String,
}

/// Optional Tower `Layer` that injects W3C propagation and queues outbound HTTP spans.
#[derive(Clone)]
pub struct TowerHttpClientSpanLayer<R, I, T> {
    client: SharedLogBrewClient,
    route_template: R,
    request_ids: I,
    timestamp: T,
    metadata: Metadata,
    span_event_id_prefix: String,
}

impl<R, I, T> TowerHttpClientSpanLayer<R, I, T> {
    /// Build a Tower outbound HTTP span layer from app-owned extraction and ID functions.
    pub fn new(
        client: SharedLogBrewClient,
        route_template: R,
        request_ids: I,
        timestamp: T,
    ) -> Self {
        Self {
            client,
            route_template,
            request_ids,
            timestamp,
            metadata: Metadata::new(),
            span_event_id_prefix: "evt_http_client_span".to_string(),
        }
    }

    /// Attach primitive, low-cardinality metadata copied into every queued client span.
    pub fn with_metadata(mut self, metadata: Metadata) -> Self {
        self.metadata = metadata;
        self
    }

    /// Override the event ID prefix. The child span ID is appended per request.
    pub fn with_event_id_prefix(mut self, span_event_id_prefix: impl Into<String>) -> Self {
        self.span_event_id_prefix = span_event_id_prefix.into();
        self
    }
}

impl<S, R, I, T> Layer<S> for TowerHttpClientSpanLayer<R, I, T>
where
    R: Clone,
    I: Clone,
    T: Clone,
{
    type Service = TowerHttpClientSpanService<S, R, I, T>;

    fn layer(&self, inner: S) -> Self::Service {
        TowerHttpClientSpanService {
            inner,
            client: Arc::clone(&self.client),
            route_template: self.route_template.clone(),
            request_ids: self.request_ids.clone(),
            timestamp: self.timestamp.clone(),
            metadata: self.metadata.clone(),
            span_event_id_prefix: self.span_event_id_prefix.clone(),
        }
    }
}

/// Tower service produced by `TowerHttpClientSpanLayer`.
#[derive(Clone)]
pub struct TowerHttpClientSpanService<S, R, I, T> {
    inner: S,
    client: SharedLogBrewClient,
    route_template: R,
    request_ids: I,
    timestamp: T,
    metadata: Metadata,
    span_event_id_prefix: String,
}

impl<S, ReqBody, ResBody, R, I, T> Service<Request<ReqBody>>
    for TowerRequestTelemetryService<S, R, I, T>
where
    S: Service<Request<ReqBody>, Response = Response<ResBody>>,
    S::Future: Send + 'static,
    S::Error: Send + 'static,
    ReqBody: Send + 'static,
    ResBody: Send + 'static,
    R: Fn(&Request<ReqBody>) -> String + Clone + Send + Sync + 'static,
    I: Fn() -> TowerRequestIds + Clone + Send + Sync + 'static,
    T: Fn() -> String + Clone + Send + Sync + 'static,
{
    type Response = Response<ResBody>;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, request: Request<ReqBody>) -> Self::Future {
        let started = Instant::now();
        let method = request.method().as_str().to_string();
        let incoming_traceparent = request
            .headers()
            .get("traceparent")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let route_template = (self.route_template)(&request);
        let request_ids = (self.request_ids)();
        let timestamp = (self.timestamp)();
        let metadata = self.metadata.clone();
        let client = Arc::clone(&self.client);
        let span_event_id_prefix = self.span_event_id_prefix.clone();
        let metric_event_id_prefix = self.metric_event_id_prefix.clone();
        let future = self.inner.call(request);

        Box::pin(async move {
            let mut response = future.await?;
            let duration_ms = started.elapsed().as_secs_f64() * 1000.0;
            let telemetry = request_telemetry(
                route_template,
                method,
                request_ids,
                incoming_traceparent,
                response.status().as_u16(),
                duration_ms,
                metadata,
            );
            let Ok(events) = telemetry.and_then(|telemetry| telemetry.build()) else {
                return Ok(response);
            };

            if let Ok(value) = HeaderValue::from_str(&events.outgoing_traceparent) {
                response.headers_mut().insert("traceparent", value);
            }
            if let Ok(mut client) = client.lock() {
                let span_event_id = event_id(&span_event_id_prefix, &events.span_id);
                let metric_event_id = event_id(&metric_event_id_prefix, &events.span_id);
                let _ = client.span(span_event_id, timestamp.clone(), events.span);
                if let Some(metric) = events.metric {
                    let _ = client.metric(metric_event_id, timestamp, metric);
                }
            }
            Ok(response)
        })
    }
}

impl<S, ReqBody, ResBody, R, I, T> Service<Request<ReqBody>>
    for TowerHttpClientSpanService<S, R, I, T>
where
    S: Service<Request<ReqBody>, Response = Response<ResBody>>,
    S::Future: Send + 'static,
    S::Error: Send + 'static,
    ReqBody: Send + 'static,
    ResBody: Send + 'static,
    R: Fn(&Request<ReqBody>) -> String + Clone + Send + Sync + 'static,
    I: Fn() -> TowerRequestIds + Clone + Send + Sync + 'static,
    T: Fn() -> String + Clone + Send + Sync + 'static,
{
    type Response = Response<ResBody>;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, mut request: Request<ReqBody>) -> Self::Future {
        let started = Instant::now();
        let method = request.method().as_str().to_string();
        let existing_traceparent = request
            .headers()
            .get("traceparent")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let route_template = (self.route_template)(&request);
        let request_ids = (self.request_ids)();
        let timestamp = (self.timestamp)();
        let metadata = self.metadata.clone();
        let client = Arc::clone(&self.client);
        let span_event_id_prefix = self.span_event_id_prefix.clone();

        let prepared = tower_http_client_span(TowerHttpClientSpanInput {
            route_template: route_template.clone(),
            method: method.clone(),
            request_ids: request_ids.clone(),
            existing_traceparent: existing_traceparent.clone(),
            status_code: None,
            duration_ms: None,
            error_type: None,
            metadata: metadata.clone(),
        });
        if let Ok(events) = prepared.as_ref()
            && let Ok(value) = HeaderValue::from_str(&events.outgoing_traceparent)
        {
            request.headers_mut().insert("traceparent", value);
        }

        let future = self.inner.call(request);
        Box::pin(async move {
            let result = future.await;
            let duration_ms = started.elapsed().as_secs_f64() * 1000.0;
            let status_code = result
                .as_ref()
                .ok()
                .map(|response| response.status().as_u16());
            let error_type = result
                .as_ref()
                .err()
                .map(|_| std::any::type_name::<S::Error>().to_string());

            if prepared.is_err() {
                return result;
            }
            let Ok(events) = tower_http_client_span(TowerHttpClientSpanInput {
                route_template,
                method,
                request_ids,
                existing_traceparent,
                status_code,
                duration_ms: Some(duration_ms),
                error_type,
                metadata,
            }) else {
                return result;
            };
            if let Ok(mut client) = client.lock() {
                let span_event_id = event_id(&span_event_id_prefix, &events.span_id);
                let _ = client.span(span_event_id, timestamp, events.span);
            }
            result
        })
    }
}

fn request_telemetry(
    route_template: String,
    method: String,
    request_ids: TowerRequestIds,
    incoming_traceparent: Option<String>,
    status_code: u16,
    duration_ms: f64,
    metadata: Metadata,
) -> Result<HttpRequestTelemetry, SdkError> {
    require_non_empty("tower request trace_id", &request_ids.trace_id)?;
    require_non_empty("tower request span_id", &request_ids.span_id)?;
    let mut telemetry = HttpRequestTelemetry::new(
        route_template,
        method,
        request_ids.trace_id,
        request_ids.span_id,
    )
    .with_status_code(status_code)
    .with_duration_ms(duration_ms)
    .with_metadata(metadata);
    if let Some(traceparent) = incoming_traceparent {
        telemetry = telemetry.with_incoming_traceparent(traceparent);
    }
    Ok(telemetry)
}

struct TowerHttpClientSpanInput {
    route_template: String,
    method: String,
    request_ids: TowerRequestIds,
    existing_traceparent: Option<String>,
    status_code: Option<u16>,
    duration_ms: Option<f64>,
    error_type: Option<String>,
    metadata: Metadata,
}

fn tower_http_client_span(
    input: TowerHttpClientSpanInput,
) -> Result<crate::HttpClientSpanEvents, SdkError> {
    let TowerHttpClientSpanInput {
        route_template,
        method,
        request_ids,
        existing_traceparent,
        status_code,
        duration_ms,
        error_type,
        metadata,
    } = input;
    require_non_empty("tower client trace_id", &request_ids.trace_id)?;
    require_non_empty("tower client span_id", &request_ids.span_id)?;
    let parsed_context = existing_traceparent
        .as_deref()
        .and_then(|traceparent| Traceparent::parse(traceparent).ok());
    let trace_id = parsed_context
        .as_ref()
        .map(|context| context.trace_id.as_str())
        .unwrap_or_else(|| request_ids.trace_id.trim());
    let parent_span_id = parsed_context
        .as_ref()
        .map(|context| context.parent_span_id.as_str())
        .or(request_ids.parent_span_id.as_deref());
    let trace_flags = parsed_context
        .as_ref()
        .map(|context| context.trace_flags.as_str())
        .unwrap_or("01");

    let mut span =
        HttpClientSpan::new(route_template, method, request_ids.span_id).with_metadata(metadata);
    if let Some(status_code) = status_code {
        span = span.with_status_code(status_code);
    }
    if let Some(duration_ms) = duration_ms {
        span = span.with_duration_ms(duration_ms);
    }
    if let Some(error_type) = error_type {
        span = span.with_error_type(error_type);
    }
    span.build_from_trace_parts(trace_id, parent_span_id, trace_flags)
}

fn event_id(prefix: &str, span_id: &str) -> String {
    format!("{}_{}", prefix.trim(), span_id)
}
