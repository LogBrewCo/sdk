mod automatic;
mod queue;

#[cfg(test)]
mod tests;

use crate::telemetry_context::{context_from_value, context_to_value, merge_captured_contexts};
use crate::{
    ActionEvent, EnvironmentEvent, Event, EventBatch, IssueEvent, LogEvent, MetricEvent,
    ReleaseEvent, SdkError, SdkInfo, SpanEvent, TelemetryContext, TelemetryTraceContext, Transport,
    TransportError, TransportResponse, current_telemetry_context, require_non_empty,
    require_timestamp, validate_telemetry_context,
};
use alloc::sync::Arc;
use automatic::{AutomaticDelivery, AutomaticHealth};
use core::fmt;
use core::sync::atomic::{AtomicUsize, Ordering};
use core::time::Duration;
use queue::{DeliveryQueue, FrozenPrefix, QueueAdmissionError, REQUEST_SUFFIX, serialize_bounded};
use serde_json::{Map, Value};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Instant;

/// Default maximum number of events retained in the shared queue.
pub const DEFAULT_MAX_QUEUE_EVENTS: usize = 1_000;

/// Default maximum compact UTF-8 bytes retained for queued events.
pub const DEFAULT_MAX_QUEUE_BYTES: usize = 4 * 1024 * 1024;

/// Default maximum number of events included in one delivery batch.
pub const DEFAULT_MAX_BATCH_EVENTS: usize = 100;

/// Default maximum exact UTF-8 request-body bytes for one delivery batch.
pub const DEFAULT_MAX_REQUEST_BODY_BYTES: usize = 256 * 1024;

/// Delay after the first queued event before automatic delivery sends; later events share that request.
pub const DEFAULT_AUTOMATIC_DELIVERY_INTERVAL: Duration = Duration::from_secs(1);

/// Pending event count that starts an automatic delivery before the interval ends.
pub const DEFAULT_AUTOMATIC_DELIVERY_THRESHOLD: usize = 100;

/// First retry delay after a failed automatic delivery.
pub const DEFAULT_AUTOMATIC_RETRY_BASE_DELAY: Duration = Duration::from_secs(5);

/// Longest retry delay between failed automatic deliveries.
pub const DEFAULT_AUTOMATIC_RETRY_MAX_DELAY: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
/// Configuration for an explicit client-owned automatic delivery worker.
pub struct AutomaticDeliveryConfig {
    /// Whether the background worker delivers queued events.
    pub enabled: bool,
    /// Longest time the first pending event waits before delivery starts.
    pub interval: Duration,
    /// Pending event count that starts delivery before the interval ends.
    pub threshold: usize,
    /// First retry delay after a failed delivery; later retries double it.
    pub retry_base_delay: Duration,
    /// Upper bound for the retry delay.
    pub retry_max_delay: Duration,
}

impl Default for AutomaticDeliveryConfig {
    #[inline]
    fn default() -> Self {
        Self {
            enabled: true,
            interval: DEFAULT_AUTOMATIC_DELIVERY_INTERVAL,
            threshold: DEFAULT_AUTOMATIC_DELIVERY_THRESHOLD,
            retry_base_delay: DEFAULT_AUTOMATIC_RETRY_BASE_DELAY,
            retry_max_delay: DEFAULT_AUTOMATIC_RETRY_MAX_DELAY,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
/// Fixed delivery lifecycle outcome exposed by [`DeliveryHealthSnapshot`].
pub enum DeliveryOutcome {
    /// The client closed after acknowledging its shutdown snapshot.
    Closed,
    /// One or more queued events were accepted by the transport.
    Delivered,
    /// An event was rejected by a configured queue bound.
    Dropped,
    /// Delivery failed and unaccepted work remains queued.
    Failed,
    /// No delivery or admission result has been recorded.
    Idle,
    /// Automatic delivery paused until the next manual flush.
    Paused,
    /// An event was retained in the bounded queue.
    Queued,
    /// A failed delivery scheduled a retry.
    RetryScheduled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
/// Fixed reason why client-owned automatic delivery is paused.
pub enum DeliveryPauseReason {
    /// LogBrew rejected the API key.
    Authentication,
    /// Automatic delivery is not paused.
    None,
    /// The project quota is exhausted.
    Quota,
    /// LogBrew rejected the batch.
    Rejected,
    /// Local queue, serialization, or acknowledgement state failed.
    State,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
/// Content-free delivery result category exposed by [`DeliveryHealthSnapshot`].
pub enum DeliveryCodeCategory {
    /// The accepted prefix could not be acknowledged safely.
    Acknowledgement,
    /// Delivery was rejected for authentication.
    Authentication,
    /// One event exceeded the configured event or request-body bound.
    EventTooLarge,
    /// The transport reported a network failure.
    Network,
    /// No delivery result category has been recorded.
    None,
    /// Queue event or byte capacity rejected an event.
    QueueFull,
    /// Delivery was rejected without a retryable server response.
    Rejected,
    /// An event or delivery batch could not be serialized within its bound.
    Serialization,
    /// Delivery failed with a retryable server response.
    Server,
    /// Local delivery state could not be accessed safely.
    State,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
/// Immutable content-free snapshot of local queue and delivery state.
pub struct DeliveryHealthSnapshot {
    /// Number of events currently retained in the bounded queue.
    pub pending_events: usize,
    /// Exact compact UTF-8 event bytes currently retained in the queue.
    pub pending_event_bytes: usize,
    /// Saturating count of events rejected by queue bounds.
    pub dropped_events: u64,
    /// Whether successful shutdown has closed the client to later captures.
    pub closed: bool,
    /// Saturating count of transport attempts.
    pub attempts: u64,
    /// Saturating count of accepted delivery batches.
    pub batches: u64,
    /// Saturating count of accepted events.
    pub accepted_events: u64,
    /// Most recent fixed delivery lifecycle outcome.
    pub last_outcome: DeliveryOutcome,
    /// Most recent content-free delivery result category.
    pub last_code: DeliveryCodeCategory,
    /// Whether automatic delivery is enabled.
    pub automatic_enabled: bool,
    /// Whether the automatic delivery worker is running.
    pub automatic_running: bool,
    /// Whether a delivery is in progress.
    pub delivery_in_flight: bool,
    /// Whether a threshold wake joined a delivery that was already pending or running.
    pub wake_coalesced: bool,
    /// Failed automatic deliveries since the last success.
    pub consecutive_failures: u32,
    /// Why automatic delivery is paused.
    pub pause_reason: DeliveryPauseReason,
    /// Delay before the next scheduled retry, or zero when none is scheduled.
    pub next_retry_delay: Duration,
}

#[derive(Clone)]
/// Builder for constructing a bounded LogBrew client from SDK identity and delivery settings.
pub struct ClientBuilder {
    sdk_name: String,
    sdk_version: String,
    api_key: Option<String>,
    max_retries: u32,
    max_queue_events: usize,
    max_queue_bytes: usize,
    max_batch_events: usize,
    max_request_body_bytes: usize,
    context: Option<TelemetryContext>,
    capture_runtime_context: bool,
}

impl fmt::Debug for ClientBuilder {
    #[inline]
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClientBuilder")
            .field("sdk_name", &self.sdk_name)
            .field("sdk_version", &self.sdk_version)
            .field("max_retries", &self.max_retries)
            .field("max_queue_events", &self.max_queue_events)
            .field("max_queue_bytes", &self.max_queue_bytes)
            .field("max_batch_events", &self.max_batch_events)
            .field("max_request_body_bytes", &self.max_request_body_bytes)
            .field("has_context", &self.context.is_some())
            .field("capture_runtime_context", &self.capture_runtime_context)
            .finish_non_exhaustive()
    }
}

impl ClientBuilder {
    /// Set the API key used by flush and shutdown transport calls.
    #[must_use]
    #[inline]
    pub fn api_key<ApiKey>(mut self, api_key: ApiKey) -> Self
    where
        ApiKey: Into<String>,
    {
        self.api_key = Some(api_key.into());
        self
    }

    /// Build a bounded LogBrew client from the configured public settings.
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when a configured setting is invalid.
    #[inline]
    pub fn build(self) -> Result<LogBrewClient, SdkError> {
        self.build_client(None)
    }

    fn build_client(
        self,
        automatic: Option<Arc<AutomaticDelivery>>,
    ) -> Result<LogBrewClient, SdkError> {
        let api_key = self
            .api_key
            .ok_or_else(|| SdkError::new("config_error", "api_key is required"))?;
        require_non_empty("api_key", &api_key)?;
        require_non_empty("sdk name", &self.sdk_name)?;
        require_non_empty("sdk version", &self.sdk_version)?;
        validate_limit("max_queue_events", self.max_queue_events)?;
        validate_limit("max_queue_bytes", self.max_queue_bytes)?;
        validate_limit("max_batch_events", self.max_batch_events)?;
        validate_limit("max_request_body_bytes", self.max_request_body_bytes)?;
        let sdk = SdkInfo {
            name: self.sdk_name,
            language: "rust".to_owned(),
            version: self.sdk_version,
        };
        let sdk_json = serialize_bounded(&sdk, self.max_request_body_bytes).map_err(|_error| {
            SdkError::new(
                "config_error",
                "SDK identity exceeds the request body limit",
            )
        })?;
        let request_prefix = request_prefix(&sdk_json)?;
        let envelope_bytes = request_prefix
            .len()
            .checked_add(REQUEST_SUFFIX.len())
            .ok_or_else(|| SdkError::new("config_error", "delivery limits are too large"))?;
        if envelope_bytes >= self.max_request_body_bytes {
            return Err(SdkError::new(
                "config_error",
                "max_request_body_bytes is too small for the SDK batch envelope",
            ));
        }
        let max_event_bytes = self
            .max_queue_bytes
            .min(self.max_request_body_bytes.saturating_sub(envelope_bytes));
        let runtime_context = self
            .capture_runtime_context
            .then(TelemetryContext::runtime_defaults);
        let context = merge_captured_contexts([runtime_context, self.context])?;

        Ok(LogBrewClient {
            inner: Arc::new(ClientInner {
                sdk,
                api_key,
                max_retries: self.max_retries,
                max_batch_events: self.max_batch_events,
                max_request_body_bytes: self.max_request_body_bytes,
                max_event_bytes,
                request_prefix,
                context,
                automatic,
                client_owners: AtomicUsize::new(1),
                state: Mutex::new(ClientState::new(
                    self.max_queue_events,
                    self.max_queue_bytes,
                )),
            }),
        })
    }

    /// Build a client with an explicit owned transport and optional automatic worker.
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when a configured setting or the automatic delivery configuration is invalid.
    #[inline]
    pub fn build_with_owned_transport<T>(
        self,
        transport: T,
        config: AutomaticDeliveryConfig,
    ) -> Result<LogBrewClient, SdkError>
    where
        T: Transport + Send + 'static,
    {
        validate_automatic_config(config)?;
        self.build_client(Some(Arc::new(AutomaticDelivery::new(
            Box::new(transport),
            config,
        ))))
    }

    /// Enable or disable conservative Rust runtime/OS/architecture defaults.
    #[must_use]
    #[inline]
    pub const fn capture_runtime_context(mut self, enabled: bool) -> Self {
        self.capture_runtime_context = enabled;
        self
    }

    /// Attach privacy-bounded base context merged into every captured signal.
    #[must_use]
    #[inline]
    pub fn context(mut self, context: TelemetryContext) -> Self {
        self.context = Some(context);
        self
    }

    /// Set the maximum number of events included in one delivery batch.
    #[must_use]
    #[inline]
    pub const fn max_batch_events(mut self, max_batch_events: usize) -> Self {
        self.max_batch_events = max_batch_events;
        self
    }

    /// Set the maximum compact UTF-8 bytes retained for queued events.
    #[must_use]
    #[inline]
    pub const fn max_queue_bytes(mut self, max_queue_bytes: usize) -> Self {
        self.max_queue_bytes = max_queue_bytes;
        self
    }

    /// Set the maximum number of events retained in the shared queue.
    #[must_use]
    #[inline]
    pub const fn max_queue_events(mut self, max_queue_events: usize) -> Self {
        self.max_queue_events = max_queue_events;
        self
    }

    /// Set the maximum exact UTF-8 request-body bytes for one delivery batch.
    #[must_use]
    #[inline]
    pub const fn max_request_body_bytes(mut self, max_request_body_bytes: usize) -> Self {
        self.max_request_body_bytes = max_request_body_bytes;
        self
    }

    /// Override the retry budget used for retryable transport failures.
    #[must_use]
    #[inline]
    pub const fn max_retries(mut self, max_retries: u32) -> Self {
        self.max_retries = max_retries;
        self
    }
}

/// Synchronous client with one shared bounded delivery queue across clones.
pub struct LogBrewClient {
    inner: Arc<ClientInner>,
}

impl Clone for LogBrewClient {
    #[inline]
    fn clone(&self) -> Self {
        let _previous_owners = self.inner.client_owners.fetch_add(1, Ordering::Relaxed);
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl Drop for LogBrewClient {
    #[inline]
    fn drop(&mut self) {
        if self.inner.client_owners.fetch_sub(1, Ordering::AcqRel) == 1
            && let Some(automatic) = self.inner.automatic.as_ref()
        {
            automatic.request_stop();
        }
    }
}

impl fmt::Debug for LogBrewClient {
    #[inline]
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LogBrewClient")
            .field("sdk", &self.inner.sdk)
            .field("delivery_health", &self.delivery_health())
            .finish_non_exhaustive()
    }
}

impl LogBrewClient {
    /// Queue an explicit app-owned action event after validation.
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when the client is closed, the queue is full, or an event field fails validation.
    #[inline]
    pub fn action<IdInput, TimestampInput>(
        &mut self,
        id: IdInput,
        timestamp: TimestampInput,
        action: ActionEvent,
    ) -> Result<(), SdkError>
    where
        IdInput: Into<String>,
        TimestampInput: Into<String>,
    {
        self.push_event("action", id.into(), timestamp.into(), action.attributes()?)
    }

    /// Create a builder from public SDK identity values like name and version.
    #[inline]
    pub fn builder<SdkName, SdkVersion>(sdk_name: SdkName, sdk_version: SdkVersion) -> ClientBuilder
    where
        SdkName: Into<String>,
        SdkVersion: Into<String>,
    {
        ClientBuilder {
            sdk_name: sdk_name.into(),
            sdk_version: sdk_version.into(),
            api_key: None,
            max_retries: 2,
            max_queue_events: DEFAULT_MAX_QUEUE_EVENTS,
            max_queue_bytes: DEFAULT_MAX_QUEUE_BYTES,
            max_batch_events: DEFAULT_MAX_BATCH_EVENTS,
            max_request_body_bytes: DEFAULT_MAX_REQUEST_BODY_BYTES,
            context: None,
            capture_runtime_context: true,
        }
    }

    /// Return an immutable content-free snapshot of bounded delivery state and counters.
    #[inline]
    pub fn delivery_health(&self) -> DeliveryHealthSnapshot {
        let automatic = self
            .inner
            .automatic
            .as_ref()
            .map_or_else(AutomaticHealth::disabled, |automatic| automatic.health());
        self.state_even_if_poisoned().health_snapshot(automatic)
    }

    /// Queue an explicit app-owned environment event after validation.
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when the client is closed, the queue is full, or an event field fails validation.
    #[inline]
    pub fn environment<IdInput, TimestampInput>(
        &mut self,
        id: IdInput,
        timestamp: TimestampInput,
        environment: EnvironmentEvent,
    ) -> Result<(), SdkError>
    where
        IdInput: Into<String>,
        TimestampInput: Into<String>,
    {
        self.push_event(
            "environment",
            id.into(),
            timestamp.into(),
            environment.attributes()?,
        )
    }

    /// Flush queued events through a transport while preserving retry semantics.
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when the client is closed, the queue is busy, or delivery fails; undelivered events stay queued.
    #[inline]
    pub fn flush<T>(&mut self, transport: &mut T) -> Result<TransportResponse, SdkError>
    where
        T: Transport,
    {
        if let Some(automatic) = self.inner.automatic.as_ref() {
            automatic.with_manual_delivery(&self.inner, || self.inner.deliver(transport, false))
        } else {
            self.inner.deliver(transport, false)
        }
    }

    /// Flush queued work through the configured owned transport and clear any pause/backoff.
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when no owned transport is configured or delivery fails; undelivered events stay queued.
    #[inline]
    pub fn flush_owned(&mut self) -> Result<TransportResponse, SdkError> {
        let automatic =
            self.inner.automatic.as_ref().ok_or_else(|| {
                SdkError::new("transport_error", "owned transport is not configured")
            })?;
        automatic.flush_owned(&self.inner)
    }

    /// Queue an explicit app-owned issue event after validation.
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when the client is closed, the queue is full, or an event field fails validation.
    #[inline]
    pub fn issue<IdInput, TimestampInput>(
        &mut self,
        id: IdInput,
        timestamp: TimestampInput,
        issue: IssueEvent,
    ) -> Result<(), SdkError>
    where
        IdInput: Into<String>,
        TimestampInput: Into<String>,
    {
        self.push_event("issue", id.into(), timestamp.into(), issue.attributes()?)
    }

    fn lock_state(&self) -> Result<MutexGuard<'_, ClientState>, SdkError> {
        self.inner
            .state
            .lock()
            .map_err(|_error| SdkError::new("queue_state_error", "delivery state is unavailable"))
    }

    /// Queue an explicit app-owned log event after validation.
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when the client is closed, the queue is full, or an event field fails validation.
    #[inline]
    pub fn log<IdInput, TimestampInput>(
        &mut self,
        id: IdInput,
        timestamp: TimestampInput,
        log: LogEvent,
    ) -> Result<(), SdkError>
    where
        IdInput: Into<String>,
        TimestampInput: Into<String>,
    {
        self.push_event("log", id.into(), timestamp.into(), log.attributes()?)
    }

    /// Queue an explicit app-owned metric event with validated low-cardinality fields.
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when the client is closed, the queue is full, or an event field fails validation.
    #[inline]
    pub fn metric<Id, Timestamp>(
        &mut self,
        id: Id,
        timestamp: Timestamp,
        metric: MetricEvent,
    ) -> Result<(), SdkError>
    where
        Id: Into<String>,
        Timestamp: Into<String>,
    {
        self.push_event("metric", id.into(), timestamp.into(), metric.attributes()?)
    }

    /// Return the queued event count currently buffered in memory.
    #[must_use]
    #[inline]
    pub fn pending_events(&self) -> usize {
        self.state_even_if_poisoned().queue.len()
    }

    /// Return the queued event batch as stable, pretty-printed JSON.
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when the queue state is unavailable or the events cannot be serialized.
    #[inline]
    pub fn preview_json(&self) -> Result<String, SdkError> {
        let state = self.lock_state()?;
        let events = state.queue.events()?;
        drop(state);
        serde_json::to_string_pretty(&EventBatch {
            sdk: self.inner.sdk.clone(),
            events,
        })
        .map_err(|_error| {
            SdkError::new(
                "serialization_error",
                "queued events could not be previewed",
            )
        })
    }

    fn push_event(
        &self,
        event_type: &str,
        id: String,
        timestamp: String,
        mut attributes: Map<String, Value>,
    ) -> Result<(), SdkError> {
        self.require_open_for_capture()?;
        require_non_empty("event id", &id)?;
        require_timestamp(&timestamp)?;
        let event_context = attributes
            .remove("context")
            .map(context_from_value)
            .transpose()?;
        let signal_context = span_signal_context(event_type, &attributes);
        let context = merge_captured_contexts([
            self.inner.context.clone(),
            current_telemetry_context(),
            signal_context,
            event_context,
        ])?;
        if let Some(merged) = context {
            drop(attributes.insert("context".to_owned(), context_to_value(&merged)?));
        }
        let event = Event {
            event_type: event_type.to_owned(),
            timestamp,
            id,
            attributes,
        };
        let event_bytes = match serialize_bounded(&event, self.inner.max_event_bytes) {
            Ok(event_bytes) => event_bytes,
            Err(error) => {
                self.lock_state()?
                    .record_drop(if error.code == "event_too_large" {
                        DeliveryCodeCategory::EventTooLarge
                    } else {
                        DeliveryCodeCategory::Serialization
                    });

                return Err(error);
            }
        };

        let pending_events = {
            let mut state = self.lock_state()?;
            state.require_open_for_capture()?;
            match state.queue.push(event_bytes) {
                Ok(()) => {
                    state.last_outcome = DeliveryOutcome::Queued;
                    state.last_code = DeliveryCodeCategory::None;
                    state.queue.len()
                }
                Err(QueueAdmissionError::Full) => {
                    state.record_drop(DeliveryCodeCategory::QueueFull);
                    return Err(SdkError::new("queue_full", "delivery queue is full"));
                }
                Err(QueueAdmissionError::Unavailable) => {
                    state.record_drop(DeliveryCodeCategory::State);
                    drop(state);
                    return Err(SdkError::new(
                        "queue_unavailable",
                        "delivery queue could not retain the event",
                    ));
                }
            }
        };
        if let Some(automatic) = self.inner.automatic.as_ref()
            && let Err(error) = automatic.notify_retained(&self.inner, pending_events)
        {
            drop(error);
            let mut state = self.lock_state()?;
            state.last_outcome = DeliveryOutcome::Failed;
            state.last_code = DeliveryCodeCategory::State;
            drop(state);
        }
        Ok(())
    }

    /// Queue an explicit app-owned release event after validation.
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when the client is closed, the queue is full, or an event field fails validation.
    #[inline]
    pub fn release<IdInput, TimestampInput>(
        &mut self,
        id: IdInput,
        timestamp: TimestampInput,
        release: ReleaseEvent,
    ) -> Result<(), SdkError>
    where
        IdInput: Into<String>,
        TimestampInput: Into<String>,
    {
        self.push_event(
            "release",
            id.into(),
            timestamp.into(),
            release.attributes()?,
        )
    }

    fn require_open_for_capture(&self) -> Result<(), SdkError> {
        self.lock_state()?.require_open_for_capture()
    }

    /// Flush queued events, then mark the client closed so later writes fail.
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when the client is closed, the queue is busy, or delivery fails; undelivered events stay queued.
    #[inline]
    pub fn shutdown<T>(&mut self, transport: &mut T) -> Result<TransportResponse, SdkError>
    where
        T: Transport,
    {
        if let Some(automatic) = self.inner.automatic.as_ref() {
            automatic.stop_and_join()?;
        }
        self.inner.deliver(transport, true)
    }

    /// Stop automatic scheduling, drain its start snapshot once, and close on success.
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when no owned transport is configured or delivery fails; undelivered events stay queued.
    #[inline]
    pub fn shutdown_owned(&mut self) -> Result<TransportResponse, SdkError> {
        let automatic =
            self.inner.automatic.as_ref().ok_or_else(|| {
                SdkError::new("transport_error", "owned transport is not configured")
            })?;
        automatic.shutdown_owned(&self.inner)
    }

    /// Queue an explicit app-owned span event after validation.
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when the client is closed, the queue is full, or an event field fails validation.
    #[inline]
    pub fn span<IdInput, TimestampInput>(
        &mut self,
        id: IdInput,
        timestamp: TimestampInput,
        span: SpanEvent,
    ) -> Result<(), SdkError>
    where
        IdInput: Into<String>,
        TimestampInput: Into<String>,
    {
        self.push_event("span", id.into(), timestamp.into(), span.attributes()?)
    }

    fn state_even_if_poisoned(&self) -> MutexGuard<'_, ClientState> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

struct ClientInner {
    sdk: SdkInfo,
    api_key: String,
    max_retries: u32,
    max_batch_events: usize,
    max_request_body_bytes: usize,
    max_event_bytes: usize,
    request_prefix: Vec<u8>,
    context: Option<TelemetryContext>,
    automatic: Option<Arc<AutomaticDelivery>>,
    client_owners: AtomicUsize,
    state: Mutex<ClientState>,
}

impl ClientInner {
    fn acknowledge(&self, prefix: &Arc<FrozenPrefix>) -> Result<(), SdkError> {
        let mut state = self.lock_state()?;
        let Some(current) = state.frozen_prefix.as_ref() else {
            return Err(SdkError::new(
                "queue_state_error",
                "delivery prefix acknowledgement is unavailable",
            ));
        };
        if !Arc::ptr_eq(current, prefix) {
            return Err(SdkError::new(
                "queue_state_error",
                "delivery prefix acknowledgement did not match",
            ));
        }
        state.queue.acknowledge(prefix)?;
        state.frozen_prefix = None;
        drop(state);
        Ok(())
    }

    fn classify_attempt(
        &self,
        attempt: Result<TransportResponse, TransportError>,
        can_retry: bool,
    ) -> AttemptOutcome {
        match attempt {
            Ok(response) if (200..300).contains(&response.status_code) => {
                AttemptOutcome::Accepted(response.status_code)
            }
            Ok(response) if response.status_code == 401 => AttemptOutcome::Failed(
                SdkError::new("unauthenticated", "transport rejected the API key"),
                DeliveryCodeCategory::Authentication,
            ),
            Ok(response) if response.status_code == 429 => {
                let code = response.error_code.as_deref();
                let timed = code != Some("usage_limit_exceeded")
                    && (response.retry_after.is_some() || code == Some("rate_limited"));
                self.state_even_if_poisoned().rate_limit_wait = match (timed, response.retry_after)
                {
                    (false, _) => RateLimitWait::NotLimited,
                    (true, None) => RateLimitWait::Backoff,
                    (true, Some(retry_after)) => RateLimitWait::RetryAfter(retry_after),
                };
                AttemptOutcome::Failed(
                    SdkError::new("quota_exhausted", "transport temporarily rejected delivery"),
                    if timed {
                        DeliveryCodeCategory::Server
                    } else {
                        DeliveryCodeCategory::Rejected
                    },
                )
            }
            Ok(response) => {
                let server_error = response.status_code == 408 || response.status_code >= 500;
                if server_error && can_retry {
                    AttemptOutcome::Retry
                } else {
                    AttemptOutcome::Failed(
                        SdkError::new("transport_error", "transport did not accept delivery"),
                        if server_error {
                            DeliveryCodeCategory::Server
                        } else {
                            DeliveryCodeCategory::Rejected
                        },
                    )
                }
            }
            Err(error) if error.retryable && can_retry => AttemptOutcome::Retry,
            Err(error) => {
                let category = if error.code == "network_failure" {
                    DeliveryCodeCategory::Network
                } else {
                    DeliveryCodeCategory::Rejected
                };
                AttemptOutcome::Failed(SdkError::new(error.code, error.message), category)
            }
        }
    }

    fn deliver<T>(
        &self,
        transport: &mut T,
        close_on_success: bool,
    ) -> Result<TransportResponse, SdkError>
    where
        T: Transport + ?Sized,
    {
        let snapshot_end = {
            let mut state = self.lock_state()?;
            state.begin_delivery(close_on_success)?;
            state.queue.last_sequence()
        };

        let result = self.deliver_snapshot(transport, snapshot_end);
        let mut state = self.lock_state()?;
        state.delivery_in_flight = false;
        state.add_totals(result.totals());
        match result {
            DeliveryResult::Accepted(response) => {
                state.closing = false;
                let outcome = if close_on_success {
                    state.closed = true;
                    Some(DeliveryOutcome::Closed)
                } else {
                    (response.accepted_events > 0).then_some(DeliveryOutcome::Delivered)
                };
                if let Some(last_outcome) = outcome {
                    state.last_outcome = last_outcome;
                    state.last_code = DeliveryCodeCategory::None;
                }
                Ok(response)
            }
            DeliveryResult::Failed(failure) => {
                state.closing = false;
                state.last_outcome = DeliveryOutcome::Failed;
                state.last_code = failure.category;
                drop(state);
                Err(failure.error)
            }
        }
    }

    fn deliver_prefix<T>(
        &self,
        transport: &mut T,
        prefix: &Arc<FrozenPrefix>,
        totals: &mut DeliveryTotals,
    ) -> Result<u16, (SdkError, DeliveryCodeCategory)>
    where
        T: Transport + ?Sized,
    {
        let max_attempts = self.max_retries.saturating_add(1);
        let mut batch_attempts = 0_u32;
        loop {
            batch_attempts = batch_attempts.saturating_add(1);
            totals.attempts = totals.attempts.saturating_add(1);
            let can_retry = batch_attempts < max_attempts;
            match self.classify_attempt(transport.send(&self.api_key, prefix.body()), can_retry) {
                AttemptOutcome::Accepted(status_code) => {
                    self.acknowledge(prefix)
                        .map_err(|error| (error, DeliveryCodeCategory::Acknowledgement))?;
                    return Ok(status_code);
                }
                AttemptOutcome::Retry => {}
                AttemptOutcome::Failed(error, category) => return Err((error, category)),
            }
        }
    }

    fn deliver_snapshot<T>(&self, transport: &mut T, snapshot_end: Option<u64>) -> DeliveryResult
    where
        T: Transport + ?Sized,
    {
        let Some(end) = snapshot_end else {
            return DeliveryResult::Accepted(TransportResponse {
                attempts: 0,
                ..TransportResponse::new(204)
            });
        };
        let mut totals = DeliveryTotals::default();
        let mut final_status = 204;

        loop {
            let prefix = match self.next_prefix(end) {
                Ok(Some(prefix)) => prefix,
                Ok(None) => {
                    return DeliveryResult::Accepted(TransportResponse {
                        attempts: totals.attempts,
                        batches: totals.batches,
                        accepted_events: totals.accepted_events,
                        ..TransportResponse::new(final_status)
                    });
                }
                Err(error) => {
                    return DeliveryResult::Failed(DeliveryFailure {
                        error,
                        category: DeliveryCodeCategory::Serialization,
                        totals,
                    });
                }
            };
            match self.deliver_prefix(transport, &prefix, &mut totals) {
                Ok(status_code) => {
                    final_status = status_code;
                    totals.batches = totals.batches.saturating_add(1);
                    totals.accepted_events =
                        totals.accepted_events.saturating_add(prefix.event_count());
                }
                Err((error, category)) => {
                    return DeliveryResult::Failed(DeliveryFailure {
                        error,
                        category,
                        totals,
                    });
                }
            }
        }
    }

    fn delivery_in_flight(&self) -> bool {
        self.state_even_if_poisoned().delivery_in_flight
    }

    fn last_code(&self) -> DeliveryCodeCategory {
        self.state_even_if_poisoned().last_code
    }

    fn lock_state(&self) -> Result<MutexGuard<'_, ClientState>, SdkError> {
        self.state
            .lock()
            .map_err(|_error| SdkError::new("queue_state_error", "delivery state is unavailable"))
    }

    fn next_prefix(&self, snapshot_end: u64) -> Result<Option<Arc<FrozenPrefix>>, SdkError> {
        let mut state = self.lock_state()?;
        if let Some(prefix) = state.frozen_prefix.as_ref() {
            return Ok(Some(Arc::clone(prefix)));
        }
        let prefix = state.queue.freeze(
            snapshot_end,
            &self.request_prefix,
            self.max_batch_events,
            self.max_request_body_bytes,
        )?;
        state.frozen_prefix.clone_from(&prefix);
        drop(state);
        Ok(prefix)
    }

    fn pending_events(&self) -> usize {
        self.state_even_if_poisoned().queue.len()
    }

    fn rate_limit_wait(&self) -> RateLimitWait {
        self.state_even_if_poisoned().rate_limit_wait
    }

    fn record_automatic_outcome(&self, outcome: DeliveryOutcome) {
        self.state_even_if_poisoned().last_outcome = outcome;
    }

    fn record_automatic_state_failure(&self) {
        let mut state = self.state_even_if_poisoned();
        state.last_outcome = DeliveryOutcome::Failed;
        state.last_code = DeliveryCodeCategory::State;
    }

    fn state_even_if_poisoned(&self) -> MutexGuard<'_, ClientState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[derive(Debug)]
struct ClientState {
    queue: DeliveryQueue,
    frozen_prefix: Option<Arc<FrozenPrefix>>,
    closing: bool,
    closed: bool,
    delivery_in_flight: bool,
    dropped_events: u64,
    attempts: u64,
    batches: u64,
    accepted_events: u64,
    last_outcome: DeliveryOutcome,
    last_code: DeliveryCodeCategory,
    rate_limit_wait: RateLimitWait,
}

impl ClientState {
    fn add_totals(&mut self, totals: DeliveryTotals) {
        self.attempts = self.attempts.saturating_add(u64::from(totals.attempts));
        self.batches = self.batches.saturating_add(u64::from(totals.batches));
        self.accepted_events = self
            .accepted_events
            .saturating_add(u64::try_from(totals.accepted_events).unwrap_or(u64::MAX));
    }

    fn begin_delivery(&mut self, close_on_success: bool) -> Result<(), SdkError> {
        self.require_open_for_capture()?;
        if self.delivery_in_flight {
            return Err(SdkError::new(
                "queue_busy_error",
                "delivery is already in progress",
            ));
        }
        self.delivery_in_flight = true;
        self.closing = close_on_success;
        self.rate_limit_wait = RateLimitWait::NotLimited;
        Ok(())
    }

    fn health_snapshot(&self, automatic: AutomaticHealth) -> DeliveryHealthSnapshot {
        DeliveryHealthSnapshot {
            pending_events: self.queue.len(),
            pending_event_bytes: self.queue.event_bytes(),
            dropped_events: self.dropped_events,
            closed: self.closed,
            attempts: self.attempts,
            batches: self.batches,
            accepted_events: self.accepted_events,
            last_outcome: self.last_outcome,
            last_code: self.last_code,
            automatic_enabled: automatic.enabled,
            automatic_running: automatic.running,
            delivery_in_flight: self.delivery_in_flight,
            wake_coalesced: automatic.wake_coalesced,
            consecutive_failures: automatic.consecutive_failures,
            pause_reason: automatic.pause_reason,
            next_retry_delay: automatic.next_retry_delay,
        }
    }

    const fn new(max_queue_events: usize, max_queue_bytes: usize) -> Self {
        Self {
            queue: DeliveryQueue::new(max_queue_events, max_queue_bytes),
            frozen_prefix: None,
            closing: false,
            closed: false,
            delivery_in_flight: false,
            dropped_events: 0,
            attempts: 0,
            batches: 0,
            accepted_events: 0,
            last_outcome: DeliveryOutcome::Idle,
            last_code: DeliveryCodeCategory::None,
            rate_limit_wait: RateLimitWait::NotLimited,
        }
    }

    const fn record_drop(&mut self, category: DeliveryCodeCategory) {
        self.dropped_events = self.dropped_events.saturating_add(1);
        self.last_outcome = DeliveryOutcome::Dropped;
        self.last_code = category;
    }

    fn require_open_for_capture(&self) -> Result<(), SdkError> {
        if self.closed || self.closing {
            return Err(SdkError::new(
                "shutdown_error",
                "client is already shut down",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct DeliveryTotals {
    attempts: u32,
    batches: u32,
    accepted_events: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RateLimitWait {
    Backoff,
    NotLimited,
    RetryAfter(Duration),
}

enum AttemptOutcome {
    Accepted(u16),
    Failed(SdkError, DeliveryCodeCategory),
    Retry,
}

enum DeliveryResult {
    Accepted(TransportResponse),
    Failed(DeliveryFailure),
}

impl DeliveryResult {
    const fn totals(&self) -> DeliveryTotals {
        match *self {
            Self::Accepted(ref response) => DeliveryTotals {
                attempts: response.attempts,
                batches: response.batches,
                accepted_events: response.accepted_events,
            },
            Self::Failed(ref failure) => failure.totals,
        }
    }
}

struct DeliveryFailure {
    error: SdkError,
    category: DeliveryCodeCategory,
    totals: DeliveryTotals,
}

fn validate_automatic_config(config: AutomaticDeliveryConfig) -> Result<(), SdkError> {
    if config.interval.is_zero() {
        return Err(SdkError::new(
            "config_error",
            "automatic delivery interval must be positive",
        ));
    }
    validate_deadline("automatic delivery interval", config.interval)?;
    validate_limit("automatic delivery threshold", config.threshold)?;
    if config.retry_base_delay.is_zero() {
        return Err(SdkError::new(
            "config_error",
            "automatic retry base delay must be positive",
        ));
    }
    validate_deadline("automatic retry base delay", config.retry_base_delay)?;
    validate_deadline("automatic retry maximum delay", config.retry_max_delay)?;
    if config.retry_max_delay < config.retry_base_delay {
        return Err(SdkError::new(
            "config_error",
            "automatic retry maximum delay must not be shorter than its base delay",
        ));
    }
    Ok(())
}

fn validate_limit(name: &str, value: usize) -> Result<(), SdkError> {
    if value == 0 {
        return Err(SdkError::new(
            "config_error",
            format!("{name} must be positive"),
        ));
    }
    Ok(())
}

fn validate_deadline(name: &str, value: Duration) -> Result<(), SdkError> {
    if Instant::now().checked_add(value).is_none() {
        return Err(SdkError::new(
            "config_error",
            format!("{name} exceeds the supported scheduling range"),
        ));
    }
    Ok(())
}

fn request_prefix(sdk_json: &[u8]) -> Result<Vec<u8>, SdkError> {
    let mut prefix = Vec::new();
    let capacity = b"{\"sdk\":"
        .len()
        .checked_add(sdk_json.len())
        .and_then(|size| size.checked_add(b",\"events\":[".len()))
        .ok_or_else(|| SdkError::new("serialization_error", "SDK batch envelope is too large"))?;
    prefix.try_reserve_exact(capacity).map_err(|_error| {
        SdkError::new(
            "serialization_error",
            "SDK batch envelope could not be allocated",
        )
    })?;
    prefix.extend_from_slice(b"{\"sdk\":");
    prefix.extend_from_slice(sdk_json);
    prefix.extend_from_slice(b",\"events\":[");
    Ok(prefix)
}

fn span_signal_context(
    event_type: &str,
    attributes: &Map<String, Value>,
) -> Option<TelemetryContext> {
    if event_type != "span" {
        return None;
    }
    let trace_id = attributes.get("traceId")?.as_str()?;
    let span_id = attributes.get("spanId")?.as_str()?;
    let mut trace = TelemetryTraceContext::new(trace_id).with_span_id(span_id);
    if let Some(parent_span_id) = attributes.get("parentSpanId").and_then(Value::as_str) {
        trace = trace.with_parent_span_id(parent_span_id);
    }
    validate_telemetry_context(&TelemetryContext::new().with_trace(trace)).ok()
}
