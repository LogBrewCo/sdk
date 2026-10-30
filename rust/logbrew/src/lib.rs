//! Public Rust client for building, validating, previewing, and flushing LogBrew event batches.

extern crate alloc;

mod delivery;
mod http_client;
mod http_fields;
mod http_server;
mod issue_diagnostics;
mod metadata_safety;
mod metric;

#[cfg(feature = "opentelemetry-exporter")]
mod opentelemetry_exporter;

mod operation_tracing;
mod product_timeline;
mod telemetry_context;

#[cfg(feature = "tower")]
mod tower_layer;

mod traceparent;

#[cfg(feature = "tracing")]
mod tracing_layer;

#[cfg(test)]
#[cfg(feature = "http")]
mod retry_after_tests;

use alloc::collections::VecDeque;
#[cfg(any(
    feature = "tower",
    feature = "tracing",
    feature = "opentelemetry-exporter"
))]
use alloc::sync::Arc;
use core::any::Any;
use core::error::Error;
use core::fmt;
use core::time::Duration;
pub use delivery::{
    AutomaticDeliveryConfig, ClientBuilder, DEFAULT_AUTOMATIC_DELIVERY_INTERVAL,
    DEFAULT_AUTOMATIC_DELIVERY_THRESHOLD, DEFAULT_AUTOMATIC_RETRY_BASE_DELAY,
    DEFAULT_AUTOMATIC_RETRY_MAX_DELAY, DEFAULT_MAX_BATCH_EVENTS, DEFAULT_MAX_QUEUE_BYTES,
    DEFAULT_MAX_QUEUE_EVENTS, DEFAULT_MAX_REQUEST_BODY_BYTES, DeliveryCodeCategory,
    DeliveryHealthSnapshot, DeliveryOutcome, DeliveryPauseReason, LogBrewClient,
};
#[cfg(feature = "hyper")]
pub use http_client::HttpRequestCaptureError;
#[cfg(feature = "reqwest")]
pub use http_client::ReqwestCaptureError;
pub use http_client::{HttpClientSpan, HttpClientSpanEvents};
pub use http_server::{HttpRequestTelemetry, HttpRequestTelemetryEvents};
pub use issue_diagnostics::{
    IssueBreadcrumb, IssueBreadcrumbBuffer, IssueException, IssueExceptionChain,
    IssueExceptionChainEntry, IssueExceptionMechanism, IssueExceptionMessageState,
    IssueExceptionRelationship, IssueExceptionStackFramesState, IssueStackFrame,
};
pub use metric::MetricEvent;
#[cfg(feature = "opentelemetry-exporter")]
pub use opentelemetry_exporter::{
    LogBrewOpenTelemetrySpanExporter, LogBrewOpenTelemetrySpanExporterConfig,
};
pub use operation_tracing::{DependencyOperationKind, DependencyOperationSpan};
pub use product_timeline::{NetworkMilestoneTimeline, ProductActionTimeline, ProductTimeline};
use serde::{Deserialize, Serialize};
pub use serde_json::Value as MetadataValue;
use serde_json::{Map, Value};
use std::panic::PanicHookInfo;
#[cfg(any(
    feature = "tower",
    feature = "tracing",
    feature = "opentelemetry-exporter"
))]
use std::sync::Mutex;
#[cfg(feature = "http")]
use std::time::SystemTime;
#[cfg(feature = "http")]
use std::time::UNIX_EPOCH;
pub use telemetry_context::{
    TELEMETRY_CONTEXT_SCHEMA_VERSION, TelemetryApplication, TelemetryContext,
    TelemetryContextFuture, TelemetryContextGuard, TelemetryDeployment, TelemetryDevice,
    TelemetryNamedVersion, TelemetryOperatingSystem, TelemetryResource, TelemetrySessionContext,
    TelemetrySubjectContext, TelemetrySubjectKind, TelemetryTraceContext,
    activate_telemetry_context, current_telemetry_context, merge_telemetry_contexts,
    validate_telemetry_context, with_telemetry_context, with_telemetry_context_async,
};
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
#[cfg(feature = "http")]
use ureq::http::Response;

/// Build a privacy-bounded frame for the current Rust source location.
///
/// The generated frame keeps only the source basename, positive line and
/// column coordinates, and the compile-time Rust module path. Add a function
/// name and `inApp` classification explicitly when those are useful.
#[macro_export]
macro_rules! issue_stack_frame {
    () => {
        $crate::IssueStackFrame::new(file!(), line!(), column!()).with_module(module_path!())
    };
}

pub(crate) const ACTION_STATUSES: &[&str] = &["queued", "running", "success", "failure"];

#[cfg(feature = "http")]
/// Default LogBrew HTTP intake endpoint used by `HttpTransportConfig`.
pub const DEFAULT_HTTP_ENDPOINT: &str = "https://api.logbrew.co/v1/events";

#[cfg(any(
    feature = "tower",
    feature = "tracing",
    feature = "opentelemetry-exporter"
))]
/// Shared thread-safe client handle used by optional framework and logging integrations.
pub type SharedLogBrewClient = Arc<Mutex<LogBrewClient>>;

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

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
/// Public event batch preview shape returned by `preview_json`.
pub struct EventBatch {
    /// SDK identity metadata attached to the batch.
    pub sdk: SdkInfo,
    /// Validated events currently queued in the batch.
    pub events: Vec<Event>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
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
    /// Readable `Retry-After` delay from a `429` response.
    pub retry_after: Option<Duration>,
    /// String `code` field from a `429` JSON response body.
    pub error_code: Option<String>,
}

impl TransportResponse {
    /// Create a transport response before client-owned delivery totals are applied.
    #[must_use]
    #[inline]
    pub const fn new(status_code: u16) -> Self {
        Self {
            status_code,
            attempts: 1,
            batches: 0,
            accepted_events: 0,
            retry_after: None,
            error_code: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Transport-layer failure with a stable public code and retry hint.
pub struct TransportError {
    /// Stable error code.
    pub code: &'static str,
    /// Human-readable error message.
    pub message: String,
    /// Whether a later retry can succeed.
    pub retryable: bool,
}

impl TransportError {
    /// Create a retryable network failure that preserves queued events.
    #[inline]
    pub fn network<MessageInput>(message: MessageInput) -> Self
    where
        MessageInput: Into<String>,
    {
        Self {
            code: "network_failure",
            message: message.into(),
            retryable: true,
        }
    }

    /// Create a transport failure with an explicit code and retryability flag.
    #[inline]
    pub fn other<MessageInput>(code: &'static str, message: MessageInput, retryable: bool) -> Self
    where
        MessageInput: Into<String>,
    {
        Self {
            code,
            message: message.into(),
            retryable,
        }
    }
}

/// Public transport interface used by `flush` and `shutdown`.
pub trait Transport {
    ///
    /// # Errors
    ///
    /// Returns a [`TransportError`] when the request fails or LogBrew rejects the batch.
    fn send(&mut self, api_key: &str, body: &[u8]) -> Result<TransportResponse, TransportError>;
}

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
    #[inline]
    fn default() -> Self {
        Self {
            endpoint: DEFAULT_HTTP_ENDPOINT.to_owned(),
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
    /// Return the configured endpoint used for future send attempts.
    #[must_use]
    #[inline]
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// Return the additional request headers configured for this transport.
    #[must_use]
    #[inline]
    pub fn headers(&self) -> &[(String, String)] {
        &self.headers
    }

    /// Build a blocking HTTP transport from public configuration.
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when the endpoint, timeout, or headers are invalid.
    #[inline]
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
}

#[cfg(feature = "http")]
impl Transport for HttpTransport {
    #[inline]
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
        for header in &self.headers {
            request = request.header(header.0.as_str(), header.1.as_str());
        }

        match request
            .config()
            .http_status_as_error(false)
            .build()
            .send(body)
        {
            Ok(response) => Ok(http_transport_response(response)),
            Err(error) => Err(TransportError::network(format!(
                "http transport failed: {error}"
            ))),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Stable public SDK error with parseable code and message fields.
pub struct SdkError {
    /// Stable error code, such as `validation_error`.
    pub code: &'static str,
    /// Human-readable error message.
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
    #[inline]
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl Error for SdkError {}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Public release-event builder for stable LogBrew release payload fields.
pub struct ReleaseEvent {
    version: String,
    commit: Option<String>,
    notes: Option<String>,
    metadata: Option<Map<String, Value>>,
    context: Option<TelemetryContext>,
}

impl ReleaseEvent {
    fn attributes(self) -> Result<Map<String, Value>, SdkError> {
        require_non_empty("release version", &self.version)?;
        if let Some(commit) = self.commit.as_ref() {
            require_non_empty("release commit", commit)?;
        }
        let mut map = Map::new();
        drop(map.insert("version".to_owned(), Value::String(self.version)));
        insert_string(&mut map, "commit", self.commit);
        insert_string(&mut map, "notes", self.notes);
        metadata_entry(&mut map, self.metadata);
        context_entry(&mut map, self.context)?;
        Ok(map)
    }

    /// Create a release event with its required version field.
    #[inline]
    pub fn new<Version>(version: Version) -> Self
    where
        Version: Into<String>,
    {
        Self {
            version: version.into(),
            commit: None,
            notes: None,
            metadata: None,
            context: None,
        }
    }

    /// Add an optional commit identifier to the release payload.
    #[must_use]
    #[inline]
    pub fn with_commit<Commit>(mut self, commit: Commit) -> Self
    where
        Commit: Into<String>,
    {
        self.commit = Some(commit.into());
        self
    }

    /// Attach an explicit shared telemetry context override.
    #[must_use]
    #[inline]
    pub fn with_context(mut self, context: TelemetryContext) -> Self {
        self.context = Some(context);
        self
    }

    /// Attach optional metadata to the release payload.
    #[must_use]
    #[inline]
    pub fn with_metadata(mut self, metadata: Map<String, Value>) -> Self {
        self.metadata = Some(metadata);
        self
    }

    /// Add optional release notes to the release payload.
    #[must_use]
    #[inline]
    pub fn with_notes<Notes>(mut self, notes: Notes) -> Self
    where
        Notes: Into<String>,
    {
        self.notes = Some(notes.into());
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Public environment-event builder for stable LogBrew environment payload fields.
pub struct EnvironmentEvent {
    name: String,
    region: Option<String>,
    metadata: Option<Map<String, Value>>,
    context: Option<TelemetryContext>,
}

impl EnvironmentEvent {
    fn attributes(self) -> Result<Map<String, Value>, SdkError> {
        require_non_empty("environment name", &self.name)?;
        let mut map = Map::new();
        drop(map.insert("name".to_owned(), Value::String(self.name)));
        insert_string(&mut map, "region", self.region);
        metadata_entry(&mut map, self.metadata);
        context_entry(&mut map, self.context)?;
        Ok(map)
    }

    /// Create an environment event with its required name field.
    #[inline]
    pub fn new<NameInput>(name: NameInput) -> Self
    where
        NameInput: Into<String>,
    {
        Self {
            name: name.into(),
            region: None,
            metadata: None,
            context: None,
        }
    }

    /// Attach an explicit shared telemetry context override.
    #[must_use]
    #[inline]
    pub fn with_context(mut self, context: TelemetryContext) -> Self {
        self.context = Some(context);
        self
    }

    /// Attach optional metadata to the environment payload.
    #[must_use]
    #[inline]
    pub fn with_metadata(mut self, metadata: Map<String, Value>) -> Self {
        self.metadata = Some(metadata);
        self
    }

    /// Add an optional region to the environment payload.
    #[must_use]
    #[inline]
    pub fn with_region<Region>(mut self, region: Region) -> Self
    where
        Region: Into<String>,
    {
        self.region = Some(region.into());
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Public issue-event builder for stable LogBrew issue payload fields.
pub struct IssueEvent {
    title: String,
    level: String,
    message: Option<String>,
    exception: Option<IssueException>,
    exception_chain: Option<IssueExceptionChain>,
    stack_frames: Option<Vec<IssueStackFrame>>,
    stack_frames_truncated: bool,
    breadcrumbs: Option<Vec<IssueBreadcrumb>>,
    breadcrumbs_truncated: bool,
    metadata: Option<Map<String, Value>>,
    context: Option<TelemetryContext>,
}

impl IssueEvent {
    fn attributes(self) -> Result<Map<String, Value>, SdkError> {
        require_non_empty("issue title", &self.title)?;
        let level = normalize_severity("issue level", &self.level)?;
        let mut map = Map::new();
        drop(map.insert("title".to_owned(), Value::String(self.title)));
        drop(map.insert("level".to_owned(), Value::String(level.to_owned())));
        insert_string(&mut map, "message", self.message);
        if let Some(exception) = self.exception.as_ref() {
            drop(map.insert(
                "exception".to_owned(),
                Value::Object(exception.attributes()?),
            ));
        }
        if let Some(stack_frames) = self.stack_frames.as_ref() {
            if stack_frames.is_empty() || stack_frames.len() > issue_diagnostics::MAX_STACK_FRAMES {
                return Err(SdkError::new(
                    "validation_error",
                    "issue stackFrames must contain 1-32 frames",
                ));
            }
            drop(
                map.insert(
                    "stackFrames".to_owned(),
                    Value::Array(
                        stack_frames
                            .iter()
                            .map(|frame| frame.attributes().map(Value::Object))
                            .collect::<Result<Vec<_>, _>>()?,
                    ),
                ),
            );
        }
        if let Some(exception_chain) = self.exception_chain.as_ref() {
            drop(map.insert(
                "exceptionChain".to_owned(),
                Value::Object(exception_chain.attributes(
                    self.exception.as_ref(),
                    self.stack_frames.as_ref(),
                    self.stack_frames_truncated,
                )?),
            ));
        }
        if let Some(breadcrumbs) = self.breadcrumbs.as_ref() {
            if breadcrumbs.is_empty() || breadcrumbs.len() > issue_diagnostics::MAX_BREADCRUMBS {
                return Err(SdkError::new(
                    "validation_error",
                    "issue breadcrumbs must contain 1-64 entries",
                ));
            }
            drop(
                map.insert(
                    "breadcrumbs".to_owned(),
                    Value::Array(
                        breadcrumbs
                            .iter()
                            .map(|breadcrumb| breadcrumb.attributes().map(Value::Object))
                            .collect::<Result<Vec<_>, _>>()?,
                    ),
                ),
            );
        }
        if self.breadcrumbs_truncated {
            drop(map.insert("breadcrumbsTruncated".to_owned(), Value::Bool(true)));
        }
        metadata_entry(&mut map, self.metadata);
        context_entry(&mut map, self.context)?;
        Ok(map)
    }

    /// Create an error-level issue from a handled concrete Rust error.
    ///
    /// The projection includes only the concrete Rust type, mechanism, and
    /// handled state. It does not format the error, so `Display` and `Debug`
    /// text are not captured. Pass a concrete error reference rather than a
    /// trait object when exact type identity is important.
    #[inline]
    pub fn from_error<E>(error: &E) -> Self
    where
        E: Error + ?Sized,
    {
        Self::from_error_with_mechanism(error, "rust.error", true)
    }

    /// Create an error-level issue with an explicit capture mechanism and handled state.
    #[inline]
    pub fn from_error_with_mechanism<E, MechanismTypeInput>(
        error: &E,
        mechanism_type: MechanismTypeInput,
        handled: bool,
    ) -> Self
    where
        E: Error + ?Sized,
        MechanismTypeInput: Into<String>,
    {
        let exception_type = issue_diagnostics::error_type_name::<E>();
        let mechanism = IssueExceptionMechanism::new(mechanism_type, handled);
        let exception =
            IssueException::new(exception_type.clone()).with_mechanism(mechanism.clone());
        let exception_chain =
            IssueExceptionChain::from_error(error, exception_type.clone(), mechanism);
        Self::new(exception_type, "error")
            .with_exception(exception)
            .with_exception_chain(exception_chain)
    }

    /// Build a privacy-safe panic issue from an app-owned panic hook.
    ///
    /// This helper uses the exact panic location when Rust provides one and
    /// never formats the panic payload. It does not install, replace, flush, or
    /// otherwise own the process-global panic hook.
    #[must_use]
    #[inline]
    pub fn from_panic_info(info: &PanicHookInfo<'_>) -> Self {
        let issue = Self::from_panic_payload(info.payload());
        match info.location() {
            Some(location) => issue.with_stack_frame(IssueStackFrame::from_location(location)),
            None => issue,
        }
    }

    /// Create a critical issue from a panic payload without formatting its text.
    #[inline]
    pub fn from_panic_payload(payload: &(dyn Any + Send)) -> Self {
        Self::from_panic_payload_with_mechanism(payload, "rust.panic", false)
    }

    /// Create a panic issue with an explicit capture mechanism and handled state.
    #[inline]
    pub fn from_panic_payload_with_mechanism<MechanismType>(
        payload: &(dyn Any + Send),
        mechanism_type: MechanismType,
        handled: bool,
    ) -> Self
    where
        MechanismType: Into<String>,
    {
        let panic_type = issue_diagnostics::panic_payload_type(payload);
        let mut metadata = Metadata::new();
        drop(metadata.insert("panic".to_owned(), Value::Bool(true)));
        drop(metadata.insert("panicType".to_owned(), Value::String(panic_type.to_owned())));
        drop(metadata.insert(
            "issueGroupingKey".to_owned(),
            Value::String(format!("rust.panic:{panic_type}")),
        ));
        drop(metadata.insert(
            "issueGroupingSource".to_owned(),
            Value::String("panic_payload_type".to_owned()),
        ));
        drop(metadata.insert(
            "issueEvidenceCompleteness".to_owned(),
            Value::String("partial".to_owned()),
        ));
        drop(metadata.insert(
            "issueMissingEvidence".to_owned(),
            Value::String("additionalStackFrames".to_owned()),
        ));
        drop(metadata.insert(
            "issueRedactedEvidence".to_owned(),
            Value::String("panic.message,stack.text,locals".to_owned()),
        ));

        let mechanism = IssueExceptionMechanism::new(mechanism_type, handled);
        Self::new("panic", "critical")
            .with_exception(IssueException::new("panic").with_mechanism(mechanism.clone()))
            .with_exception_chain(IssueExceptionChain::reported_panic(mechanism))
            .with_metadata(metadata)
    }

    /// Create an issue event with its required title and level fields.
    #[inline]
    pub fn new<Title, LevelInput>(title: Title, level: LevelInput) -> Self
    where
        Title: Into<String>,
        LevelInput: Into<String>,
    {
        Self {
            title: title.into(),
            level: level.into(),
            message: None,
            exception: None,
            exception_chain: None,
            stack_frames: None,
            stack_frames_truncated: false,
            breadcrumbs: None,
            breadcrumbs_truncated: false,
            metadata: None,
            context: None,
        }
    }

    /// Append one optional privacy-bounded oldest-to-newest breadcrumb.
    #[must_use]
    #[inline]
    pub fn with_breadcrumb(mut self, breadcrumb: IssueBreadcrumb) -> Self {
        self.breadcrumbs
            .get_or_insert_with(Vec::new)
            .push(breadcrumb);
        self
    }

    /// Attach 1-64 optional privacy-bounded oldest-to-newest breadcrumbs.
    #[must_use]
    #[inline]
    pub fn with_breadcrumbs<I>(mut self, breadcrumbs: I) -> Self
    where
        I: IntoIterator<Item = IssueBreadcrumb>,
    {
        self.breadcrumbs = Some(breadcrumbs.into_iter().collect());
        self
    }

    /// Mark that older breadcrumbs were evicted before this snapshot.
    #[must_use]
    #[inline]
    pub const fn with_breadcrumbs_truncated(mut self, truncated: bool) -> Self {
        self.breadcrumbs_truncated = truncated;
        self
    }

    /// Attach an explicit shared telemetry context override.
    #[must_use]
    #[inline]
    pub fn with_context(mut self, context: TelemetryContext) -> Self {
        self.context = Some(context);
        self
    }

    /// Attach optional structured exception identity.
    #[must_use]
    #[inline]
    pub fn with_exception(mut self, exception: IssueException) -> Self {
        self.exception = Some(exception);
        self
    }

    /// Attach an optional bounded parent-first exception chain.
    #[must_use]
    #[inline]
    pub fn with_exception_chain(mut self, exception_chain: IssueExceptionChain) -> Self {
        self.exception_chain = Some(exception_chain);
        self
    }

    /// Add an optional message to the issue payload.
    #[must_use]
    #[inline]
    pub fn with_message<MessageInput>(mut self, message: MessageInput) -> Self
    where
        MessageInput: Into<String>,
    {
        self.message = Some(message.into());
        self
    }

    /// Attach optional metadata to the issue payload.
    #[must_use]
    #[inline]
    pub fn with_metadata(mut self, metadata: Map<String, Value>) -> Self {
        self.metadata = Some(metadata);
        self
    }

    /// Append one optional privacy-bounded newest-first stack frame.
    #[must_use]
    #[inline]
    pub fn with_stack_frame(mut self, frame: IssueStackFrame) -> Self {
        self.stack_frames.get_or_insert_with(Vec::new).push(frame);
        self
    }

    /// Attach 1-32 optional privacy-bounded newest-first stack frames.
    #[must_use]
    #[inline]
    pub fn with_stack_frames<I>(mut self, frames: I) -> Self
    where
        I: IntoIterator<Item = IssueStackFrame>,
    {
        self.stack_frames = Some(frames.into_iter().collect());
        self
    }

    /// Mark that more stack frames existed than the retained 32-frame payload.
    #[must_use]
    #[inline]
    pub const fn with_stack_frames_truncated(mut self, truncated: bool) -> Self {
        self.stack_frames_truncated = truncated;
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Public log-event builder for stable LogBrew log payload fields.
pub struct LogEvent {
    message: String,
    level: String,
    logger: Option<String>,
    metadata: Option<Map<String, Value>>,
    context: Option<TelemetryContext>,
}

impl LogEvent {
    fn attributes(self) -> Result<Map<String, Value>, SdkError> {
        require_non_empty("log message", &self.message)?;
        let level = normalize_severity("log level", &self.level)?;
        let mut map = Map::new();
        drop(map.insert("message".to_owned(), Value::String(self.message)));
        drop(map.insert("level".to_owned(), Value::String(level.to_owned())));
        insert_string(&mut map, "logger", self.logger);
        metadata_entry(&mut map, self.metadata);
        context_entry(&mut map, self.context)?;
        Ok(map)
    }

    /// Create a log event with its required message and level fields.
    #[inline]
    pub fn new<Message, Level>(message: Message, level: Level) -> Self
    where
        Message: Into<String>,
        Level: Into<String>,
    {
        Self {
            message: message.into(),
            level: level.into(),
            logger: None,
            metadata: None,
            context: None,
        }
    }

    /// Attach an explicit shared telemetry context override.
    #[must_use]
    #[inline]
    pub fn with_context(mut self, context: TelemetryContext) -> Self {
        self.context = Some(context);
        self
    }

    /// Add an optional logger name to the log payload.
    #[must_use]
    #[inline]
    pub fn with_logger<Logger>(mut self, logger: Logger) -> Self
    where
        Logger: Into<String>,
    {
        self.logger = Some(logger.into());
        self
    }

    /// Attach optional metadata to the log payload.
    #[must_use]
    #[inline]
    pub fn with_metadata(mut self, metadata: Map<String, Value>) -> Self {
        self.metadata = Some(metadata);
        self
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
    context: Option<TelemetryContext>,
}

impl SpanEvent {
    fn attributes(self) -> Result<Map<String, Value>, SdkError> {
        require_non_empty("span name", &self.name)?;
        require_non_empty("span trace_id", &self.trace_id)?;
        require_non_empty("span span_id", &self.span_id)?;
        require_allowed_value("span status", &self.status, &["ok", "error"])?;
        if let Some(parent_span_id) = self.parent_span_id.as_ref() {
            require_non_empty("span parent_span_id", parent_span_id)?;
        }
        if let Some(duration_ms) = self.duration_ms
            && duration_ms < 0.0_f64
        {
            return Err(SdkError::new(
                "validation_error",
                "span duration_ms must be non-negative",
            ));
        }
        let mut map = Map::new();
        drop(map.insert("name".to_owned(), Value::String(self.name)));
        drop(map.insert("traceId".to_owned(), Value::String(self.trace_id)));
        drop(map.insert("spanId".to_owned(), Value::String(self.span_id)));
        drop(map.insert("status".to_owned(), Value::String(self.status)));
        insert_string(&mut map, "parentSpanId", self.parent_span_id);
        if let Some(duration_ms) = self.duration_ms {
            drop(map.insert("durationMs".to_owned(), Value::from(duration_ms)));
        }
        metadata_entry(&mut map, self.metadata);
        context_entry(&mut map, self.context)?;
        Ok(map)
    }

    /// Create a span event with its required name, trace, span, and status fields.
    #[inline]
    pub fn new<NameInput, TraceId, SpanId, StatusInput>(
        name: NameInput,
        trace_id: TraceId,
        span_id: SpanId,
        status: StatusInput,
    ) -> Self
    where
        NameInput: Into<String>,
        TraceId: Into<String>,
        SpanId: Into<String>,
        StatusInput: Into<String>,
    {
        Self {
            name: name.into(),
            trace_id: trace_id.into(),
            span_id: span_id.into(),
            parent_span_id: None,
            status: status.into(),
            duration_ms: None,
            metadata: None,
            context: None,
        }
    }

    /// Attach an explicit shared telemetry context override.
    #[must_use]
    #[inline]
    pub fn with_context(mut self, context: TelemetryContext) -> Self {
        self.context = Some(context);
        self
    }

    /// Add an optional non-negative duration to the span payload.
    #[must_use]
    #[inline]
    pub const fn with_duration_ms(mut self, duration_ms: f64) -> Self {
        self.duration_ms = Some(duration_ms);
        self
    }

    /// Attach optional metadata to the span payload.
    #[must_use]
    #[inline]
    pub fn with_metadata(mut self, metadata: Map<String, Value>) -> Self {
        self.metadata = Some(metadata);
        self
    }

    /// Add an optional parent span identifier to the span payload.
    #[must_use]
    #[inline]
    pub fn with_parent_span_id<ParentSpanId>(mut self, parent_span_id: ParentSpanId) -> Self
    where
        ParentSpanId: Into<String>,
    {
        self.parent_span_id = Some(parent_span_id.into());
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Public action-event builder for stable LogBrew action payload fields.
pub struct ActionEvent {
    name: String,
    status: String,
    metadata: Option<Map<String, Value>>,
    context: Option<TelemetryContext>,
}

impl ActionEvent {
    fn attributes(self) -> Result<Map<String, Value>, SdkError> {
        require_non_empty("action name", &self.name)?;
        require_allowed_value("action status", &self.status, ACTION_STATUSES)?;
        let mut map = Map::new();
        drop(map.insert("name".to_owned(), Value::String(self.name)));
        drop(map.insert("status".to_owned(), Value::String(self.status)));
        metadata_entry(&mut map, self.metadata);
        context_entry(&mut map, self.context)?;
        Ok(map)
    }

    /// Create an action event with its required name and status fields.
    #[inline]
    pub fn new<Name, Status>(name: Name, status: Status) -> Self
    where
        Name: Into<String>,
        Status: Into<String>,
    {
        Self {
            name: name.into(),
            status: status.into(),
            metadata: None,
            context: None,
        }
    }

    /// Attach an explicit shared telemetry context override.
    #[must_use]
    #[inline]
    pub fn with_context(mut self, context: TelemetryContext) -> Self {
        self.context = Some(context);
        self
    }

    /// Attach optional metadata to the action payload.
    #[must_use]
    #[inline]
    pub fn with_metadata(mut self, metadata: Map<String, Value>) -> Self {
        self.metadata = Some(metadata);
        self
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
    #[must_use]
    #[inline]
    pub fn always_accept() -> Self {
        Self {
            scripted: VecDeque::from([Ok(202)]),
            sent_bodies: Vec::new(),
        }
    }

    /// Return the most recent request body sent through this transport.
    #[inline]
    pub fn last_body(&self) -> Option<&[u8]> {
        self.sent_bodies.last().map(Vec::as_slice)
    }

    /// Create a transport from public status codes or transport failures.
    #[must_use]
    #[inline]
    pub fn scripted(scripted: Vec<Result<u16, TransportError>>) -> Self {
        Self {
            scripted: VecDeque::from(scripted),
            sent_bodies: Vec::new(),
        }
    }

    /// Return every request body sent through this transport instance.
    #[must_use]
    #[inline]
    pub fn sent_bodies(&self) -> &[Vec<u8>] {
        &self.sent_bodies
    }
}

impl Transport for RecordingTransport {
    #[inline]
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

#[cfg(feature = "http")]
fn http_transport_response(mut response: Response<ureq::Body>) -> TransportResponse {
    let mut result = TransportResponse::new(response.status().as_u16());
    if result.status_code != 429 {
        return result;
    }
    let mut values = response.headers().get_all("retry-after").iter();
    if let (Some(header), None) = (values.next(), values.next()) {
        result.retry_after = header
            .to_str()
            .ok()
            .and_then(|text| parse_retry_after(text, SystemTime::now()));
    }
    result.error_code = response
        .body_mut()
        .with_config()
        .limit(4096)
        .read_to_vec()
        .ok()
        .and_then(|body| serde_json::from_slice::<Value>(&body).ok())
        .and_then(|body| body.get("code")?.as_str().map(str::to_owned));
    result
}

#[cfg(feature = "http")]
fn parse_retry_after(value: &str, now: SystemTime) -> Option<Duration> {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let trimmed = value.trim();
    if !trimmed.is_empty() && trimmed.bytes().all(|byte| byte.is_ascii_digit()) {
        return Some(Duration::from_secs(trimmed.parse().unwrap_or(u64::MAX)));
    }
    let [_, day_text, month_name, year_text, time, "GMT"] =
        trimmed.split(' ').collect::<Vec<_>>()[..]
    else {
        return None;
    };
    let month_index = MONTHS.iter().position(|name| *name == month_name)?;
    let month = i64::try_from(month_index).ok()?.checked_add(1)?;
    let [hour_text, minute_text, second_text] = time.split(':').collect::<Vec<_>>()[..] else {
        return None;
    };
    let [day, year, hour, minute, second] =
        [day_text, year_text, hour_text, minute_text, second_text]
            .map(|part| part.parse::<i64>().ok());
    let days = days_since_unix_epoch(
        year.filter(|candidate| (1970..=9999).contains(candidate))?,
        month,
        day.filter(|candidate| (1..=31).contains(candidate))?,
    )?;
    let target = days
        .checked_mul(86_400)?
        .checked_add(
            hour.filter(|candidate| *candidate < 24)?
                .checked_mul(3_600)?,
        )?
        .checked_add(
            minute
                .filter(|candidate| *candidate < 60)?
                .checked_mul(60)?,
        )?
        .checked_add(second.filter(|candidate| *candidate < 61)?)?;
    let elapsed = now.duration_since(UNIX_EPOCH).ok()?.as_secs();
    Some(Duration::from_secs(
        u64::try_from(target).unwrap_or(0).saturating_sub(elapsed),
    ))
}

#[cfg(feature = "http")]
fn days_since_unix_epoch(year: i64, month: i64, day: i64) -> Option<i64> {
    let shifted_year = if month <= 2 {
        year.checked_sub(1)?
    } else {
        year
    };
    let era = shifted_year.div_euclid(400);
    let year_of_era = shifted_year.checked_sub(era.checked_mul(400)?)?;
    let day_of_year = month
        .checked_add(9)?
        .checked_rem(12)?
        .checked_mul(153)?
        .checked_add(2)?
        .checked_div(5)?
        .checked_add(day)?
        .checked_sub(1)?;
    let day_of_era = year_of_era
        .checked_mul(365)?
        .checked_add(year_of_era.checked_div(4)?)?
        .checked_sub(year_of_era.checked_div(100)?)?
        .checked_add(day_of_year)?;
    era.checked_mul(146_097)?
        .checked_add(day_of_era)?
        .checked_sub(719_468)
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
    for header in &config.headers {
        let name = &header.0;
        let value = &header.1;
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
    if let Some(entries) = metadata {
        drop(map.insert("metadata".to_owned(), Value::Object(entries)));
    }
}

pub(crate) fn context_entry(
    map: &mut Map<String, Value>,
    context: Option<TelemetryContext>,
) -> Result<(), SdkError> {
    if let Some(telemetry) = context {
        drop(map.insert(
            "context".to_owned(),
            telemetry_context::context_to_value(&telemetry)?,
        ));
    }
    Ok(())
}

fn insert_string(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(text) = value {
        drop(map.insert(key.to_owned(), Value::String(text)));
    }
}
