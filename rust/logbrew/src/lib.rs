//! Public Rust client for building, validating, previewing, and flushing LogBrew event batches.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::VecDeque;
use std::fmt;
#[cfg(feature = "http")]
use std::time::Duration;

mod delivery;
mod http_client;
mod http_fields;
mod http_server;
mod metadata_safety;
mod metric;
#[cfg(feature = "opentelemetry-exporter")]
mod opentelemetry_exporter;
mod operation_tracing;
mod product_timeline;
#[cfg(feature = "tower")]
mod tower_layer;
mod traceparent;
#[cfg(feature = "tracing")]
mod tracing_layer;
#[cfg(feature = "hyper")]
pub use http_client::HttpRequestCaptureError;
#[cfg(feature = "reqwest")]
pub use http_client::ReqwestCaptureError;
pub use http_client::{HttpClientSpan, HttpClientSpanEvents};
pub use http_server::{HttpRequestTelemetry, HttpRequestTelemetryEvents};
pub use metric::MetricEvent;
#[cfg(feature = "opentelemetry-exporter")]
pub use opentelemetry_exporter::{
    LogBrewOpenTelemetrySpanExporter, LogBrewOpenTelemetrySpanExporterConfig,
};
pub use operation_tracing::{DependencyOperationKind, DependencyOperationSpan};
pub use product_timeline::{NetworkMilestoneTimeline, ProductActionTimeline, ProductTimeline};
pub use serde_json::Value as MetadataValue;
#[cfg(any(
    feature = "tower",
    feature = "tracing",
    feature = "opentelemetry-exporter"
))]
/// Shared thread-safe client handle used by optional framework and logging integrations.
pub type SharedLogBrewClient = std::sync::Arc<std::sync::Mutex<LogBrewClient>>;
#[cfg(feature = "tower")]
pub use tower_layer::{
    TowerHttpClientSpanLayer, TowerHttpClientSpanService, TowerRequestIds,
    TowerRequestTelemetryLayer, TowerRequestTelemetryService,
};
pub use traceparent::{
    OpenTelemetrySpanContext, Traceparent, TraceparentContext, TraceparentSpanInput,
};
#[cfg(feature = "tracing")]
pub use tracing_layer::LogBrewTracingLayer;
#[cfg(feature = "tracing-opentelemetry")]
pub use tracing_layer::{
    opentelemetry_span_context_from_current_tracing_span,
    opentelemetry_span_context_from_tracing_span,
};

pub(crate) const ACTION_STATUSES: &[&str] = &["queued", "running", "success", "failure"];

/// Public metadata map type accepted by LogBrew event builders.
pub type Metadata = Map<String, Value>;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
/// Public SDK identity emitted with every LogBrew event batch.
pub struct SdkInfo {
    /// SDK or application name attached to emitted batches.
    pub name: String,
    /// Language identifier for this public SDK implementation.
    pub language: String,
    /// SDK or application version attached to emitted batches.
    pub version: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
/// Public event batch preview shape returned by `preview_json`.
pub struct EventBatch {
    /// SDK identity metadata attached to the batch.
    pub sdk: SdkInfo,
    /// Validated events currently queued in the batch.
    pub events: Vec<Event>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
/// Public event shape buffered, previewed, and flushed by the client.
pub struct Event {
    #[serde(rename = "type")]
    /// Stable LogBrew event type such as `release` or `span`.
    pub event_type: String,
    /// RFC 3339 timestamp for the event including timezone information.
    pub timestamp: String,
    /// Caller-supplied stable identifier for the event.
    pub id: String,
    /// Event payload fields for the given event type.
    pub attributes: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Response returned after a transport accepts or skips a queued flush.
pub struct TransportResponse {
    /// Final HTTP-like status returned by the transport.
    pub status_code: u16,
    /// Number of transport attempts used for the flush.
    pub attempts: u32,
    /// Number of accepted request batches represented by this response.
    pub batches: u32,
    /// Number of queued events acknowledged by accepted request batches.
    pub accepted_events: usize,
}

impl TransportResponse {
    /// Create a transport response before client-owned delivery totals are applied.
    pub const fn new(status_code: u16) -> Self {
        Self {
            status_code,
            attempts: 1,
            batches: 0,
            accepted_events: 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Transport-layer failure with a stable public code and retry hint.
pub struct TransportError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl TransportError {
    /// Create a retryable network failure that preserves queued events.
    pub fn network(message: impl Into<String>) -> Self {
        Self {
            code: "network_failure",
            message: message.into(),
            retryable: true,
        }
    }

    /// Create a transport failure with an explicit code and retryability flag.
    pub fn other(code: &'static str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
        }
    }
}

/// Public transport interface used by `flush` and `shutdown`.
pub trait Transport {
    fn send(&mut self, api_key: &str, body: &[u8]) -> Result<TransportResponse, TransportError>;
}

#[cfg(feature = "http")]
/// Default LogBrew HTTP intake endpoint used by `HttpTransportConfig`.
pub const DEFAULT_HTTP_ENDPOINT: &str = "https://api.logbrew.co/v1/events";

#[cfg(feature = "http")]
#[derive(Clone, Debug)]
/// Configuration for the feature-gated blocking HTTP transport.
pub struct HttpTransportConfig {
    /// Absolute HTTP or HTTPS endpoint that accepts LogBrew event batches.
    pub endpoint: String,
    /// Additional request headers sent with every batch.
    pub headers: Vec<(String, String)>,
    /// End-to-end timeout for each HTTP delivery attempt.
    pub timeout: Option<Duration>,
    /// Optional preconfigured ureq agent for app-owned network settings.
    pub agent: Option<ureq::Agent>,
}

#[cfg(feature = "http")]
impl Default for HttpTransportConfig {
    fn default() -> Self {
        Self {
            endpoint: DEFAULT_HTTP_ENDPOINT.to_string(),
            headers: Vec::new(),
            timeout: Some(Duration::from_secs(10)),
            agent: None,
        }
    }
}

#[cfg(feature = "http")]
#[derive(Clone, Debug)]
/// Blocking HTTP transport that sends queued batches to a LogBrew intake endpoint.
pub struct HttpTransport {
    endpoint: String,
    headers: Vec<(String, String)>,
    agent: ureq::Agent,
}

#[cfg(feature = "http")]
impl HttpTransport {
    /// Build a blocking HTTP transport from public configuration.
    pub fn new(config: HttpTransportConfig) -> Result<Self, SdkError> {
        validate_http_config(&config)?;
        let agent = config.agent.unwrap_or_else(|| {
            let agent_config = ureq::Agent::config_builder()
                .timeout_global(config.timeout)
                .build();
            ureq::Agent::new_with_config(agent_config)
        });

        Ok(Self {
            endpoint: config.endpoint,
            headers: config.headers,
            agent,
        })
    }

    /// Return the configured endpoint used for future send attempts.
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// Return the additional request headers configured for this transport.
    pub fn headers(&self) -> &[(String, String)] {
        &self.headers
    }
}

#[cfg(feature = "http")]
impl Transport for HttpTransport {
    fn send(&mut self, api_key: &str, body: &[u8]) -> Result<TransportResponse, TransportError> {
        if api_key.trim().is_empty() {
            return Err(TransportError::other(
                "unauthenticated",
                "api_key must be non-empty",
                false,
            ));
        }

        let mut request = self
            .agent
            .post(&self.endpoint)
            .header("authorization", format!("Bearer {api_key}"))
            .header("content-type", "application/json");
        for (name, value) in &self.headers {
            request = request.header(name.as_str(), value.as_str());
        }

        match request.send(body) {
            Ok(response) => Ok(TransportResponse::new(response.status().as_u16())),
            Err(ureq::Error::StatusCode(status_code)) => Ok(TransportResponse::new(status_code)),
            Err(error) => Err(TransportError::network(format!(
                "http transport failed: {error}"
            ))),
        }
    }
}

#[cfg(feature = "http")]
fn validate_http_config(config: &HttpTransportConfig) -> Result<(), SdkError> {
    let endpoint = config.endpoint.trim();
    if endpoint.is_empty() {
        return Err(SdkError::new("config_error", "endpoint must be non-empty"));
    }
    if !(endpoint.starts_with("http://") || endpoint.starts_with("https://")) {
        return Err(SdkError::new(
            "config_error",
            "endpoint must start with http:// or https://",
        ));
    }
    if config.timeout.is_some_and(|timeout| timeout.is_zero()) {
        return Err(SdkError::new("config_error", "timeout must be positive"));
    }
    for (name, value) in &config.headers {
        if name.trim().is_empty() {
            return Err(SdkError::new(
                "config_error",
                "header name must be non-empty",
            ));
        }
        if name.contains('\r') || name.contains('\n') {
            return Err(SdkError::new(
                "config_error",
                "header name must not contain line breaks",
            ));
        }
        if value.contains('\r') || value.contains('\n') {
            return Err(SdkError::new(
                "config_error",
                "header value must not contain line breaks",
            ));
        }
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Stable public SDK error with parseable code and message fields.
pub struct SdkError {
    pub code: &'static str,
    pub message: String,
}

impl SdkError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for SdkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for SdkError {}

fn require_non_empty(label: &str, value: &str) -> Result<(), SdkError> {
    if value.trim().is_empty() {
        return Err(SdkError::new(
            "validation_error",
            format!("{label} must be non-empty"),
        ));
    }
    Ok(())
}

fn require_allowed_value(label: &str, value: &str, allowed: &[&str]) -> Result<(), SdkError> {
    require_non_empty(label, value)?;
    if allowed.contains(&value) {
        return Ok(());
    }
    Err(SdkError::new(
        "validation_error",
        format!("{label} must be one of: {}", allowed.join(", ")),
    ))
}

fn normalize_severity(label: &str, value: &str) -> Result<&'static str, SdkError> {
    require_allowed_value(
        label,
        value,
        &[
            "trace", "debug", "info", "warn", "warning", "error", "fatal", "critical",
        ],
    )?;
    Ok(match value {
        "trace" | "debug" | "info" => "info",
        "warn" | "warning" => "warning",
        "error" => "error",
        "fatal" | "critical" => "critical",
        _ => "info",
    })
}

fn require_timestamp(timestamp: &str) -> Result<(), SdkError> {
    if timestamp.ends_with('Z') {
        return Ok(());
    }
    if let Some(time_portion) = timestamp.split('T').nth(1) {
        if time_portion.contains('+') {
            return Ok(());
        }
        if let Some(index) = time_portion.rfind('-')
            && index > 0
        {
            return Ok(());
        }
    }
    Err(SdkError::new(
        "validation_error",
        format!("timestamp must include a timezone offset: {timestamp}"),
    ))
}

fn metadata_entry(map: &mut Map<String, Value>, metadata: Option<Map<String, Value>>) {
    if let Some(metadata) = metadata {
        map.insert("metadata".to_string(), Value::Object(metadata));
    }
}

fn insert_string(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        map.insert(key.to_string(), Value::String(value));
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Public release-event builder for stable LogBrew release payload fields.
pub struct ReleaseEvent {
    version: String,
    commit: Option<String>,
    notes: Option<String>,
    metadata: Option<Map<String, Value>>,
}

impl ReleaseEvent {
    /// Create a release event with its required version field.
    pub fn new(version: impl Into<String>) -> Self {
        Self {
            version: version.into(),
            commit: None,
            notes: None,
            metadata: None,
        }
    }

    /// Add an optional commit identifier to the release payload.
    pub fn with_commit(mut self, commit: impl Into<String>) -> Self {
        self.commit = Some(commit.into());
        self
    }

    /// Add optional release notes to the release payload.
    pub fn with_notes(mut self, notes: impl Into<String>) -> Self {
        self.notes = Some(notes.into());
        self
    }

    /// Attach optional metadata to the release payload.
    pub fn with_metadata(mut self, metadata: Map<String, Value>) -> Self {
        self.metadata = Some(metadata);
        self
    }

    fn attributes(self) -> Result<Map<String, Value>, SdkError> {
        require_non_empty("release version", &self.version)?;
        if let Some(commit) = &self.commit {
            require_non_empty("release commit", commit)?;
        }
        let mut map = Map::new();
        map.insert("version".to_string(), Value::String(self.version));
        insert_string(&mut map, "commit", self.commit);
        insert_string(&mut map, "notes", self.notes);
        metadata_entry(&mut map, self.metadata);
        Ok(map)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Public environment-event builder for stable LogBrew environment payload fields.
pub struct EnvironmentEvent {
    name: String,
    region: Option<String>,
    metadata: Option<Map<String, Value>>,
}

impl EnvironmentEvent {
    /// Create an environment event with its required name field.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            region: None,
            metadata: None,
        }
    }

    /// Add an optional region to the environment payload.
    pub fn with_region(mut self, region: impl Into<String>) -> Self {
        self.region = Some(region.into());
        self
    }

    /// Attach optional metadata to the environment payload.
    pub fn with_metadata(mut self, metadata: Map<String, Value>) -> Self {
        self.metadata = Some(metadata);
        self
    }

    fn attributes(self) -> Result<Map<String, Value>, SdkError> {
        require_non_empty("environment name", &self.name)?;
        let mut map = Map::new();
        map.insert("name".to_string(), Value::String(self.name));
        insert_string(&mut map, "region", self.region);
        metadata_entry(&mut map, self.metadata);
        Ok(map)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Public issue-event builder for stable LogBrew issue payload fields.
pub struct IssueEvent {
    title: String,
    level: String,
    message: Option<String>,
    metadata: Option<Map<String, Value>>,
}

impl IssueEvent {
    /// Create an issue event with its required title and level fields.
    pub fn new(title: impl Into<String>, level: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            level: level.into(),
            message: None,
            metadata: None,
        }
    }

    /// Add an optional message to the issue payload.
    pub fn with_message(mut self, message: impl Into<String>) -> Self {
        self.message = Some(message.into());
        self
    }

    /// Attach optional metadata to the issue payload.
    pub fn with_metadata(mut self, metadata: Map<String, Value>) -> Self {
        self.metadata = Some(metadata);
        self
    }

    fn attributes(self) -> Result<Map<String, Value>, SdkError> {
        require_non_empty("issue title", &self.title)?;
        let level = normalize_severity("issue level", &self.level)?;
        let mut map = Map::new();
        map.insert("title".to_string(), Value::String(self.title));
        map.insert("level".to_string(), Value::String(level.to_string()));
        insert_string(&mut map, "message", self.message);
        metadata_entry(&mut map, self.metadata);
        Ok(map)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Public log-event builder for stable LogBrew log payload fields.
pub struct LogEvent {
    message: String,
    level: String,
    logger: Option<String>,
    metadata: Option<Map<String, Value>>,
}

impl LogEvent {
    /// Create a log event with its required message and level fields.
    pub fn new(message: impl Into<String>, level: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            level: level.into(),
            logger: None,
            metadata: None,
        }
    }

    /// Add an optional logger name to the log payload.
    pub fn with_logger(mut self, logger: impl Into<String>) -> Self {
        self.logger = Some(logger.into());
        self
    }

    /// Attach optional metadata to the log payload.
    pub fn with_metadata(mut self, metadata: Map<String, Value>) -> Self {
        self.metadata = Some(metadata);
        self
    }

    fn attributes(self) -> Result<Map<String, Value>, SdkError> {
        require_non_empty("log message", &self.message)?;
        let level = normalize_severity("log level", &self.level)?;
        let mut map = Map::new();
        map.insert("message".to_string(), Value::String(self.message));
        map.insert("level".to_string(), Value::String(level.to_string()));
        insert_string(&mut map, "logger", self.logger);
        metadata_entry(&mut map, self.metadata);
        Ok(map)
    }
}

#[derive(Clone, Debug, PartialEq)]
/// Public span-event builder for stable LogBrew span payload fields.
pub struct SpanEvent {
    name: String,
    trace_id: String,
    span_id: String,
    parent_span_id: Option<String>,
    status: String,
    duration_ms: Option<f64>,
    metadata: Option<Map<String, Value>>,
}

impl SpanEvent {
    /// Create a span event with its required name, trace, span, and status fields.
    pub fn new(
        name: impl Into<String>,
        trace_id: impl Into<String>,
        span_id: impl Into<String>,
        status: impl Into<String>,
    ) -> Self {
        Self {
            name: name.into(),
            trace_id: trace_id.into(),
            span_id: span_id.into(),
            parent_span_id: None,
            status: status.into(),
            duration_ms: None,
            metadata: None,
        }
    }

    /// Add an optional parent span identifier to the span payload.
    pub fn with_parent_span_id(mut self, parent_span_id: impl Into<String>) -> Self {
        self.parent_span_id = Some(parent_span_id.into());
        self
    }

    /// Add an optional non-negative duration to the span payload.
    pub fn with_duration_ms(mut self, duration_ms: f64) -> Self {
        self.duration_ms = Some(duration_ms);
        self
    }

    /// Attach optional metadata to the span payload.
    pub fn with_metadata(mut self, metadata: Map<String, Value>) -> Self {
        self.metadata = Some(metadata);
        self
    }

    fn attributes(self) -> Result<Map<String, Value>, SdkError> {
        require_non_empty("span name", &self.name)?;
        require_non_empty("span trace_id", &self.trace_id)?;
        require_non_empty("span span_id", &self.span_id)?;
        require_allowed_value("span status", &self.status, &["ok", "error"])?;
        if let Some(parent_span_id) = &self.parent_span_id {
            require_non_empty("span parent_span_id", parent_span_id)?;
        }
        if let Some(duration_ms) = self.duration_ms
            && duration_ms < 0.0
        {
            return Err(SdkError::new(
                "validation_error",
                "span duration_ms must be non-negative",
            ));
        }
        let mut map = Map::new();
        map.insert("name".to_string(), Value::String(self.name));
        map.insert("traceId".to_string(), Value::String(self.trace_id));
        map.insert("spanId".to_string(), Value::String(self.span_id));
        map.insert("status".to_string(), Value::String(self.status));
        insert_string(&mut map, "parentSpanId", self.parent_span_id);
        if let Some(duration_ms) = self.duration_ms {
            map.insert("durationMs".to_string(), Value::from(duration_ms));
        }
        metadata_entry(&mut map, self.metadata);
        Ok(map)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Public action-event builder for stable LogBrew action payload fields.
pub struct ActionEvent {
    name: String,
    status: String,
    metadata: Option<Map<String, Value>>,
}

impl ActionEvent {
    /// Create an action event with its required name and status fields.
    pub fn new(name: impl Into<String>, status: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            status: status.into(),
            metadata: None,
        }
    }

    /// Attach optional metadata to the action payload.
    pub fn with_metadata(mut self, metadata: Map<String, Value>) -> Self {
        self.metadata = Some(metadata);
        self
    }

    fn attributes(self) -> Result<Map<String, Value>, SdkError> {
        require_non_empty("action name", &self.name)?;
        require_allowed_value("action status", &self.status, ACTION_STATUSES)?;
        let mut map = Map::new();
        map.insert("name".to_string(), Value::String(self.name));
        map.insert("status".to_string(), Value::String(self.status));
        metadata_entry(&mut map, self.metadata);
        Ok(map)
    }
}

#[derive(Clone, Debug, Default)]
/// Scripted in-memory transport for previewing, accepting, or failing flushes.
pub struct RecordingTransport {
    scripted: VecDeque<Result<u16, TransportError>>,
    sent_bodies: Vec<Vec<u8>>,
}

impl RecordingTransport {
    /// Create a transport that accepts queued flushes with a `202` response.
    pub fn always_accept() -> Self {
        Self {
            scripted: VecDeque::from([Ok(202)]),
            sent_bodies: Vec::new(),
        }
    }

    /// Create a transport from public status codes or transport failures.
    pub fn scripted(scripted: Vec<Result<u16, TransportError>>) -> Self {
        Self {
            scripted: VecDeque::from(scripted),
            sent_bodies: Vec::new(),
        }
    }

    /// Return every request body sent through this transport instance.
    pub fn sent_bodies(&self) -> &[Vec<u8>] {
        &self.sent_bodies
    }

    /// Return the most recent request body sent through this transport.
    pub fn last_body(&self) -> Option<&[u8]> {
        self.sent_bodies.last().map(Vec::as_slice)
    }
}

impl Transport for RecordingTransport {
    fn send(&mut self, api_key: &str, body: &[u8]) -> Result<TransportResponse, TransportError> {
        if api_key.trim().is_empty() {
            return Err(TransportError::other(
                "unauthenticated",
                "api_key must be non-empty",
                false,
            ));
        }

        self.sent_bodies.push(body.to_vec());
        let status = self.scripted.pop_front().unwrap_or(Ok(202))?;
        Ok(TransportResponse::new(status))
    }
}
pub use delivery::{
    AutomaticDeliveryConfig, ClientBuilder, DEFAULT_AUTOMATIC_DELIVERY_INTERVAL,
    DEFAULT_AUTOMATIC_DELIVERY_THRESHOLD, DEFAULT_AUTOMATIC_RETRY_BASE_DELAY,
    DEFAULT_AUTOMATIC_RETRY_MAX_DELAY, DEFAULT_MAX_BATCH_EVENTS, DEFAULT_MAX_QUEUE_BYTES,
    DEFAULT_MAX_QUEUE_EVENTS, DEFAULT_MAX_REQUEST_BODY_BYTES, DeliveryCodeCategory,
    DeliveryHealthSnapshot, DeliveryOutcome, DeliveryPauseReason, LogBrewClient,
};
