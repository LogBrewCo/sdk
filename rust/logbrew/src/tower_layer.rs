use crate::http_fields::{normalize_method, sanitize_route_template};
use crate::{
    HttpClientSpan, HttpRequestTelemetry, IssueBreadcrumb, IssueEvent, IssueException,
    IssueExceptionMechanism, Metadata, SdkError, SharedLogBrewClient, TelemetryContext,
    TelemetryNamedVersion, TelemetryResource, TelemetryTraceContext, Traceparent,
    activate_telemetry_context, merge_telemetry_contexts, require_non_empty,
};
use http_types::{HeaderValue, Request, Response};
use serde_json::Value;
use std::{
    future::{Future, poll_fn},
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

/// Tower `Layer` that scopes handler events to a request and queues its span and duration metric.
#[derive(Clone)]
pub struct TowerRequestTelemetryLayer<R, I, T> {
    client: SharedLogBrewClient,
    route_template: R,
    request_ids: I,
    timestamp: T,
    metadata: Metadata,
    span_event_id_prefix: String,
    metric_event_id_prefix: String,
    capture_error_issues: bool,
    error_issue_event_id_prefix: String,
    context: Option<TelemetryContext>,
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
            capture_error_issues: false,
            error_issue_event_id_prefix: "evt_tower_request_issue".to_string(),
            context: None,
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

    /// Opt in to one typed issue when the wrapped Tower service returns an error.
    ///
    /// The issue contains the concrete Rust error type, `tower.service`
    /// mechanism, handled state, one request breadcrumb, and exact request-span
    /// correlation. It does not format the error or capture request values.
    pub fn with_error_issues(mut self) -> Self {
        self.capture_error_issues = true;
        self
    }

    /// Override the error-issue event ID prefix appended with the request span ID.
    pub fn with_error_issue_event_id_prefix(mut self, prefix: impl Into<String>) -> Self {
        self.error_issue_event_id_prefix = prefix.into();
        self
    }

    /// Attach shared service, deployment, application, session, subject, or tag context.
    pub fn with_context(mut self, context: TelemetryContext) -> Self {
        self.context = Some(context);
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
            capture_error_issues: self.capture_error_issues,
            error_issue_event_id_prefix: self.error_issue_event_id_prefix.clone(),
            context: self.context.clone(),
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
    capture_error_issues: bool,
    error_issue_event_id_prefix: String,
    context: Option<TelemetryContext>,
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
    context: Option<TelemetryContext>,
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
            context: None,
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

    /// Attach shared service, deployment, application, session, subject, or tag context.
    pub fn with_context(mut self, context: TelemetryContext) -> Self {
        self.context = Some(context);
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
            context: self.context.clone(),
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
    context: Option<TelemetryContext>,
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
        let mut telemetry = TowerRequestTelemetryInput {
            route_template: (self.route_template)(&request),
            method: request.method().as_str().to_string(),
            request_ids: (self.request_ids)(),
            incoming_traceparent: request
                .headers()
                .get("traceparent")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string),
            status_code: None,
            duration_ms: None,
            error_type: None,
            metadata: self.metadata.clone(),
            context: self.context.clone(),
        };
        let timestamp = (self.timestamp)();
        let client = Arc::clone(&self.client);
        let span_event_id_prefix = self.span_event_id_prefix.clone();
        let metric_event_id_prefix = self.metric_event_id_prefix.clone();
        let capture_error_issues = self.capture_error_issues;
        let error_issue_event_id_prefix = self.error_issue_event_id_prefix.clone();
        let request_context = request_events(&telemetry)
            .ok()
            .and_then(|events| events.span.context);
        let guard = request_context
            .clone()
            .and_then(|context| activate_telemetry_context(context).ok());
        let mut future = Box::pin(self.inner.call(request));
        drop(guard);

        Box::pin(async move {
            let mut result =
                poll_fn(|cx| poll_with_context(future.as_mut(), request_context.as_ref(), cx))
                    .await;
            telemetry.duration_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
            telemetry.status_code = result
                .as_ref()
                .ok()
                .map(|response| response.status().as_u16());
            telemetry.error_type = result
                .as_ref()
                .err()
                .map(|_| crate::issue_diagnostics::error_type_name::<S::Error>());
            let Ok(events) = request_events(&telemetry) else {
                return result;
            };

            if let Ok(response) = result.as_mut()
                && let Ok(value) = HeaderValue::from_str(&events.outgoing_traceparent)
            {
                response.headers_mut().insert("traceparent", value);
            }
            if let Ok(mut client) = client.lock() {
                let span_event_id = event_id(&span_event_id_prefix, &events.span_id);
                let metric_event_id = event_id(&metric_event_id_prefix, &events.span_id);
                let issue = telemetry.error_type.as_deref().and_then(|error_type| {
                    capture_error_issues
                        .then(|| tower_error_issue(error_type, &timestamp, &telemetry, &events))
                });
                let span_id = events.span_id.clone();
                let _ = client.span(span_event_id, timestamp.clone(), events.span);
                if let Some(metric) = events.metric {
                    let _ = client.metric(metric_event_id, timestamp.clone(), metric);
                }
                if let Some(Ok(issue)) = issue {
                    let issue_event_id = event_id(&error_issue_event_id_prefix, &span_id);
                    let _ = client.issue(issue_event_id, timestamp, issue);
                }
            }
            result
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
        let context = self.context.clone();

        let prepared = tower_http_client_span(TowerHttpClientSpanInput {
            route_template: route_template.clone(),
            method: method.clone(),
            request_ids: request_ids.clone(),
            existing_traceparent: existing_traceparent.clone(),
            status_code: None,
            duration_ms: None,
            error_type: None,
            metadata: metadata.clone(),
            context: context.clone(),
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
                context,
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

struct TowerRequestTelemetryInput {
    route_template: String,
    method: String,
    request_ids: TowerRequestIds,
    incoming_traceparent: Option<String>,
    status_code: Option<u16>,
    duration_ms: Option<f64>,
    error_type: Option<String>,
    metadata: Metadata,
    context: Option<TelemetryContext>,
}

fn request_events(
    input: &TowerRequestTelemetryInput,
) -> Result<crate::HttpRequestTelemetryEvents, SdkError> {
    require_non_empty("tower request trace_id", &input.request_ids.trace_id)?;
    require_non_empty("tower request span_id", &input.request_ids.span_id)?;
    let mut telemetry = HttpRequestTelemetry::new(
        input.route_template.clone(),
        input.method.clone(),
        input.request_ids.trace_id.clone(),
        input.request_ids.span_id.clone(),
    )
    .with_metadata(input.metadata.clone())
    .with_context(tower_base_context(input.context.as_ref())?);
    if let Some(duration_ms) = input.duration_ms {
        telemetry = telemetry.with_duration_ms(duration_ms);
    }
    if let Some(status_code) = input.status_code {
        telemetry = telemetry.with_status_code(status_code);
    }
    if let Some(error_type) = &input.error_type {
        telemetry = telemetry.with_error_type(error_type);
    }
    if let Some(traceparent) = &input.incoming_traceparent {
        telemetry = telemetry.with_incoming_traceparent(traceparent);
    }
    telemetry.build()
}

fn poll_with_context<F: Future>(
    future: Pin<&mut F>,
    context: Option<&TelemetryContext>,
    cx: &mut Context<'_>,
) -> Poll<F::Output> {
    let guard = context
        .cloned()
        .and_then(|context| activate_telemetry_context(context).ok());
    let result = future.poll(cx);
    drop(guard);
    result
}

fn tower_error_issue(
    error_type: &str,
    timestamp: &str,
    input: &TowerRequestTelemetryInput,
    events: &crate::HttpRequestTelemetryEvents,
) -> Result<IssueEvent, SdkError> {
    let error_type = crate::issue_diagnostics::require_exception_type(error_type)?;
    let route_template =
        sanitize_route_template("tower request route_template", input.route_template.clone())?;
    let method = normalize_method("tower request method", &input.method)?;
    let grouping_key = format!("rust.tower.service:{error_type}:{method} {route_template}")
        .chars()
        .take(1024)
        .collect::<String>();

    let breadcrumb_data = Metadata::from_iter([
        (
            "routeTemplate".to_string(),
            Value::String(route_template.clone()),
        ),
        ("method".to_string(), Value::String(method.clone())),
    ]);
    let breadcrumb = IssueBreadcrumb::new(timestamp, "http.request")
        .with_type("http")
        .with_level("error")
        .with_data(breadcrumb_data);

    let mut metadata = [
        ("source", "rust_tower"),
        ("exceptionType", error_type.as_str()),
        ("errorName", error_type.as_str()),
        ("mechanism", "tower.service"),
        ("traceId", events.trace_id.as_str()),
        ("spanId", events.span_id.as_str()),
        ("routeTemplate", route_template.as_str()),
        ("method", method.as_str()),
        ("issueGroupingKey", grouping_key.as_str()),
        ("issueGroupingSource", "error_type_and_route"),
        ("issueEvidenceCompleteness", "partial"),
        ("issueMissingEvidence", "stackFrames"),
        (
            "issueRedactedEvidence",
            "exception.message,stack.text,request.values",
        ),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_string(), Value::String(value.to_string())))
    .collect::<Metadata>();
    metadata.insert("handled".to_string(), Value::Bool(false));

    let base_context = tower_base_context(None)?;
    let mut trace = TelemetryTraceContext::new(&events.trace_id)
        .with_span_id(&events.span_id)
        .with_sampled(events.sampled);
    if let Some(parent_span_id) = events.parent_span_id.as_deref() {
        trace = trace.with_parent_span_id(parent_span_id);
    }
    let context = crate::telemetry_context::merge_captured_contexts([
        Some(base_context),
        Some(TelemetryContext::new().with_trace(trace)),
        input.context.clone(),
    ])?
    .expect("Tower issue context is always populated");

    Ok(IssueEvent::new(error_type.clone(), "error")
        .with_exception(
            IssueException::new(error_type)
                .with_mechanism(IssueExceptionMechanism::new("tower.service", false)),
        )
        .with_breadcrumb(breadcrumb)
        .with_metadata(metadata)
        .with_context(context))
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
    context: Option<TelemetryContext>,
}

fn tower_http_client_span(
    input: TowerHttpClientSpanInput,
) -> Result<crate::HttpClientSpanEvents, SdkError> {
    require_non_empty("tower client trace_id", &input.request_ids.trace_id)?;
    require_non_empty("tower client span_id", &input.request_ids.span_id)?;
    let parsed_context = input
        .existing_traceparent
        .as_deref()
        .and_then(|traceparent| Traceparent::parse(traceparent).ok());
    let trace_id = parsed_context
        .as_ref()
        .map(|context| context.trace_id.as_str())
        .unwrap_or_else(|| input.request_ids.trace_id.trim());
    let parent_span_id = parsed_context
        .as_ref()
        .map(|context| context.parent_span_id.as_str())
        .or(input.request_ids.parent_span_id.as_deref());
    let trace_flags = parsed_context
        .as_ref()
        .map(|context| context.trace_flags.as_str())
        .unwrap_or("01");

    let mut span = HttpClientSpan::new(
        input.route_template,
        input.method,
        input.request_ids.span_id,
    )
    .with_metadata(input.metadata)
    .with_context(tower_base_context(input.context.as_ref())?);
    if let Some(status_code) = input.status_code {
        span = span.with_status_code(status_code);
    }
    if let Some(duration_ms) = input.duration_ms {
        span = span.with_duration_ms(duration_ms);
    }
    if let Some(error_type) = input.error_type {
        span = span.with_error_type(error_type);
    }
    span.build_from_trace_parts(trace_id, parent_span_id, trace_flags)
}

fn tower_base_context(context: Option<&TelemetryContext>) -> Result<TelemetryContext, SdkError> {
    let framework = TelemetryContext::new().with_resource(
        TelemetryResource::new().with_framework(TelemetryNamedVersion::new("tower")),
    );
    Ok(merge_telemetry_contexts(Some(&framework), context)?
        .expect("Tower framework context is always populated"))
}

fn event_id(prefix: &str, span_id: &str) -> String {
    format!("{}_{}", prefix.trim(), span_id)
}
