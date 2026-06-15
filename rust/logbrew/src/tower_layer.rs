use crate::{HttpRequestTelemetry, LogBrewClient, Metadata, SdkError, require_non_empty};
use http_types::{HeaderValue, Request, Response};
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Instant,
};
use tower::{Layer, Service};

/// Shared client handle used by the optional Tower request telemetry layer.
pub type SharedLogBrewClient = Arc<Mutex<LogBrewClient>>;

/// App-provided trace and span identifiers for one Tower request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TowerRequestIds {
    /// Fallback trace ID used when there is no valid incoming W3C traceparent.
    pub trace_id: String,
    /// Child span ID used for the LogBrew request span and outgoing traceparent.
    pub span_id: String,
}

impl TowerRequestIds {
    /// Create request IDs from app-owned trace and span generators.
    pub fn new(trace_id: impl Into<String>, span_id: impl Into<String>) -> Self {
        Self {
            trace_id: trace_id.into(),
            span_id: span_id.into(),
        }
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

fn event_id(prefix: &str, span_id: &str) -> String {
    format!("{}_{}", prefix.trim(), span_id)
}
