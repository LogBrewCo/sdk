use crate::{
    ActionEvent, EnvironmentEvent, Event, EventBatch, IssueEvent, LogEvent, MetricEvent,
    ReleaseEvent, SdkError, SdkInfo, SpanEvent, Transport, TransportResponse, require_non_empty,
    require_timestamp,
};
use serde_json::{Map, Value};
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

mod queue;
use queue::{DeliveryQueue, FrozenPrefix, QueueAdmissionError, REQUEST_SUFFIX, serialize_bounded};

pub const DEFAULT_MAX_QUEUE_EVENTS: usize = 1_000;
pub const DEFAULT_MAX_QUEUE_BYTES: usize = 4 * 1024 * 1024;
pub const DEFAULT_MAX_BATCH_EVENTS: usize = 100;
pub const DEFAULT_MAX_REQUEST_BODY_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
/// Fixed delivery lifecycle outcome exposed by [`DeliveryHealthSnapshot`].
pub enum DeliveryOutcome {
    Idle,
    Queued,
    Delivered,
    Dropped,
    Failed,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
/// Content-free delivery result category exposed by [`DeliveryHealthSnapshot`].
pub enum DeliveryCodeCategory {
    None,
    QueueFull,
    EventTooLarge,
    Network,
    Authentication,
    Server,
    Rejected,
    Serialization,
    Acknowledgement,
    State,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
/// Immutable content-free snapshot of local queue and delivery state.
pub struct DeliveryHealthSnapshot {
    pub pending_events: usize,
    pub pending_event_bytes: usize,
    pub dropped_events: u64,
    pub closed: bool,
    pub attempts: u64,
    pub batches: u64,
    pub accepted_events: u64,
    pub last_outcome: DeliveryOutcome,
    pub last_code: DeliveryCodeCategory,
}

#[derive(Clone)]
/// Builder for constructing a public LogBrew client from SDK identity and delivery limits.
pub struct ClientBuilder {
    sdk_name: String,
    sdk_version: String,
    api_key: Option<String>,
    max_retries: u32,
    max_queue_events: usize,
    max_queue_bytes: usize,
    max_batch_events: usize,
    max_request_body_bytes: usize,
}

impl fmt::Debug for ClientBuilder {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClientBuilder")
            .field("sdk_name", &self.sdk_name)
            .field("sdk_version", &self.sdk_version)
            .field("max_retries", &self.max_retries)
            .field("max_queue_events", &self.max_queue_events)
            .field("max_queue_bytes", &self.max_queue_bytes)
            .field("max_batch_events", &self.max_batch_events)
            .field("max_request_body_bytes", &self.max_request_body_bytes)
            .finish_non_exhaustive()
    }
}

impl ClientBuilder {
    pub fn api_key(mut self, api_key: impl Into<String>) -> Self {
        self.api_key = Some(api_key.into());
        self
    }

    pub fn max_retries(mut self, max_retries: u32) -> Self {
        self.max_retries = max_retries;
        self
    }

    pub fn max_queue_events(mut self, max_queue_events: usize) -> Self {
        self.max_queue_events = max_queue_events;
        self
    }

    pub fn max_queue_bytes(mut self, max_queue_bytes: usize) -> Self {
        self.max_queue_bytes = max_queue_bytes;
        self
    }

    pub fn max_batch_events(mut self, max_batch_events: usize) -> Self {
        self.max_batch_events = max_batch_events;
        self
    }

    pub fn max_request_body_bytes(mut self, max_request_body_bytes: usize) -> Self {
        self.max_request_body_bytes = max_request_body_bytes;
        self
    }

    pub fn build(self) -> Result<LogBrewClient, SdkError> {
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
            language: "rust".to_string(),
            version: self.sdk_version,
        };
        let sdk_json = serialize_bounded(&sdk, self.max_request_body_bytes).map_err(|_| {
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
            .min(self.max_request_body_bytes - envelope_bytes);

        Ok(LogBrewClient {
            inner: Arc::new(ClientInner {
                sdk,
                api_key,
                max_retries: self.max_retries,
                max_batch_events: self.max_batch_events,
                max_request_body_bytes: self.max_request_body_bytes,
                max_event_bytes,
                request_prefix,
                state: Mutex::new(ClientState::new(
                    self.max_queue_events,
                    self.max_queue_bytes,
                )),
            }),
        })
    }
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

fn request_prefix(sdk_json: &[u8]) -> Result<Vec<u8>, SdkError> {
    let mut prefix = Vec::new();
    let capacity = b"{\"sdk\":"
        .len()
        .checked_add(sdk_json.len())
        .and_then(|size| size.checked_add(b",\"events\":[".len()))
        .ok_or_else(|| SdkError::new("serialization_error", "SDK batch envelope is too large"))?;
    prefix.try_reserve_exact(capacity).map_err(|_| {
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

#[derive(Clone)]
/// Synchronous client with one shared bounded delivery queue across clones.
pub struct LogBrewClient {
    inner: Arc<ClientInner>,
}

impl fmt::Debug for LogBrewClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LogBrewClient")
            .field("sdk", &self.inner.sdk)
            .field("delivery_health", &self.delivery_health())
            .finish_non_exhaustive()
    }
}

impl LogBrewClient {
    pub fn builder(sdk_name: impl Into<String>, sdk_version: impl Into<String>) -> ClientBuilder {
        ClientBuilder {
            sdk_name: sdk_name.into(),
            sdk_version: sdk_version.into(),
            api_key: None,
            max_retries: 2,
            max_queue_events: DEFAULT_MAX_QUEUE_EVENTS,
            max_queue_bytes: DEFAULT_MAX_QUEUE_BYTES,
            max_batch_events: DEFAULT_MAX_BATCH_EVENTS,
            max_request_body_bytes: DEFAULT_MAX_REQUEST_BODY_BYTES,
        }
    }

    pub fn pending_events(&self) -> usize {
        self.state_even_if_poisoned().queue.len()
    }

    pub fn delivery_health(&self) -> DeliveryHealthSnapshot {
        self.state_even_if_poisoned().health_snapshot()
    }

    pub fn preview_json(&self) -> Result<String, SdkError> {
        let state = self.lock_state()?;
        let events = state.queue.events()?;
        serde_json::to_string_pretty(&EventBatch {
            sdk: self.inner.sdk.clone(),
            events,
        })
        .map_err(|_| {
            SdkError::new(
                "serialization_error",
                "queued events could not be previewed",
            )
        })
    }

    pub fn release(
        &mut self,
        id: impl Into<String>,
        timestamp: impl Into<String>,
        release: ReleaseEvent,
    ) -> Result<(), SdkError> {
        self.push_event(
            "release",
            id.into(),
            timestamp.into(),
            release.attributes()?,
        )
    }

    pub fn environment(
        &mut self,
        id: impl Into<String>,
        timestamp: impl Into<String>,
        environment: EnvironmentEvent,
    ) -> Result<(), SdkError> {
        self.push_event(
            "environment",
            id.into(),
            timestamp.into(),
            environment.attributes()?,
        )
    }

    pub fn issue(
        &mut self,
        id: impl Into<String>,
        timestamp: impl Into<String>,
        issue: IssueEvent,
    ) -> Result<(), SdkError> {
        self.push_event("issue", id.into(), timestamp.into(), issue.attributes()?)
    }

    pub fn log(
        &mut self,
        id: impl Into<String>,
        timestamp: impl Into<String>,
        log: LogEvent,
    ) -> Result<(), SdkError> {
        self.push_event("log", id.into(), timestamp.into(), log.attributes()?)
    }

    pub fn span(
        &mut self,
        id: impl Into<String>,
        timestamp: impl Into<String>,
        span: SpanEvent,
    ) -> Result<(), SdkError> {
        self.push_event("span", id.into(), timestamp.into(), span.attributes()?)
    }

    pub fn action(
        &mut self,
        id: impl Into<String>,
        timestamp: impl Into<String>,
        action: ActionEvent,
    ) -> Result<(), SdkError> {
        self.push_event("action", id.into(), timestamp.into(), action.attributes()?)
    }

    pub fn metric(
        &mut self,
        id: impl Into<String>,
        timestamp: impl Into<String>,
        metric: MetricEvent,
    ) -> Result<(), SdkError> {
        self.push_event("metric", id.into(), timestamp.into(), metric.attributes()?)
    }

    pub fn flush<T: Transport>(
        &mut self,
        transport: &mut T,
    ) -> Result<TransportResponse, SdkError> {
        self.deliver(transport, false)
    }

    pub fn shutdown<T: Transport>(
        &mut self,
        transport: &mut T,
    ) -> Result<TransportResponse, SdkError> {
        self.deliver(transport, true)
    }

    fn push_event(
        &mut self,
        event_type: &str,
        id: String,
        timestamp: String,
        attributes: Map<String, Value>,
    ) -> Result<(), SdkError> {
        self.require_open_for_capture()?;
        require_non_empty("event id", &id)?;
        require_timestamp(&timestamp)?;
        let event = Event {
            event_type: event_type.to_string(),
            timestamp,
            id,
            attributes,
        };
        let event_bytes = match serialize_bounded(&event, self.inner.max_event_bytes) {
            Ok(event_bytes) => event_bytes,
            Err(error) => {
                let mut state = self.lock_state()?;
                state.record_drop(if error.code == "event_too_large" {
                    DeliveryCodeCategory::EventTooLarge
                } else {
                    DeliveryCodeCategory::Serialization
                });
                return Err(error);
            }
        };

        let mut state = self.lock_state()?;
        state.require_open_for_capture()?;
        match state.queue.push(event_bytes) {
            Ok(()) => {
                state.last_outcome = DeliveryOutcome::Queued;
                state.last_code = DeliveryCodeCategory::None;
                Ok(())
            }
            Err(QueueAdmissionError::Full) => {
                state.record_drop(DeliveryCodeCategory::QueueFull);
                Err(SdkError::new("queue_full", "delivery queue is full"))
            }
            Err(QueueAdmissionError::Unavailable) => {
                state.record_drop(DeliveryCodeCategory::State);
                Err(SdkError::new(
                    "queue_unavailable",
                    "delivery queue could not retain the event",
                ))
            }
        }
    }

    fn require_open_for_capture(&self) -> Result<(), SdkError> {
        self.lock_state()?.require_open_for_capture()
    }

    fn deliver<T: Transport>(
        &self,
        transport: &mut T,
        close_on_success: bool,
    ) -> Result<TransportResponse, SdkError> {
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
                if close_on_success {
                    state.closed = true;
                    state.last_outcome = DeliveryOutcome::Closed;
                    state.last_code = DeliveryCodeCategory::None;
                } else if response.accepted_events > 0 {
                    state.last_outcome = DeliveryOutcome::Delivered;
                    state.last_code = DeliveryCodeCategory::None;
                }
                Ok(response)
            }
            DeliveryResult::Failed(failure) => {
                state.closing = false;
                state.last_outcome = DeliveryOutcome::Failed;
                state.last_code = failure.category;
                Err(failure.error)
            }
        }
    }

    fn deliver_snapshot<T: Transport>(
        &self,
        transport: &mut T,
        snapshot_end: Option<u64>,
    ) -> DeliveryResult {
        let Some(snapshot_end) = snapshot_end else {
            return DeliveryResult::Accepted(TransportResponse {
                status_code: 204,
                attempts: 0,
                batches: 0,
                accepted_events: 0,
            });
        };
        let mut totals = DeliveryTotals::default();
        let mut final_status = 204;

        loop {
            let prefix = match self.next_prefix(snapshot_end) {
                Ok(Some(prefix)) => prefix,
                Ok(None) => {
                    return DeliveryResult::Accepted(TransportResponse {
                        status_code: final_status,
                        attempts: totals.attempts,
                        batches: totals.batches,
                        accepted_events: totals.accepted_events,
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

            let max_attempts = self.inner.max_retries.saturating_add(1);
            let mut batch_attempts = 0u32;
            loop {
                batch_attempts = batch_attempts.saturating_add(1);
                totals.attempts = totals.attempts.saturating_add(1);
                match transport.send(&self.inner.api_key, &prefix.body) {
                    Ok(response) if (200..300).contains(&response.status_code) => {
                        if let Err(error) = self.acknowledge(&prefix) {
                            return DeliveryResult::Failed(DeliveryFailure {
                                error,
                                category: DeliveryCodeCategory::Acknowledgement,
                                totals,
                            });
                        }
                        final_status = response.status_code;
                        totals.batches = totals.batches.saturating_add(1);
                        totals.accepted_events =
                            totals.accepted_events.saturating_add(prefix.event_count);
                        break;
                    }
                    Ok(response) if response.status_code == 401 => {
                        return DeliveryResult::Failed(DeliveryFailure {
                            error: SdkError::new(
                                "unauthenticated",
                                "transport rejected the API key",
                            ),
                            category: DeliveryCodeCategory::Authentication,
                            totals,
                        });
                    }
                    Ok(response)
                        if (response.status_code == 408 || response.status_code >= 500)
                            && batch_attempts < max_attempts => {}
                    Ok(response) => {
                        let category = if response.status_code == 408 || response.status_code >= 500
                        {
                            DeliveryCodeCategory::Server
                        } else {
                            DeliveryCodeCategory::Rejected
                        };
                        return DeliveryResult::Failed(DeliveryFailure {
                            error: SdkError::new(
                                "transport_error",
                                format!("unexpected transport status {}", response.status_code),
                            ),
                            category,
                            totals,
                        });
                    }
                    Err(error) if error.retryable && batch_attempts < max_attempts => {}
                    Err(error) => {
                        let category = if error.code == "network_failure" {
                            DeliveryCodeCategory::Network
                        } else {
                            DeliveryCodeCategory::Rejected
                        };
                        return DeliveryResult::Failed(DeliveryFailure {
                            error: SdkError::new(error.code, error.message),
                            category,
                            totals,
                        });
                    }
                }
            }
        }
    }

    fn next_prefix(&self, snapshot_end: u64) -> Result<Option<Arc<FrozenPrefix>>, SdkError> {
        let mut state = self.lock_state()?;
        if let Some(prefix) = &state.frozen_prefix {
            return Ok(Some(prefix.clone()));
        }
        let prefix = state.queue.freeze(
            snapshot_end,
            &self.inner.request_prefix,
            self.inner.max_batch_events,
            self.inner.max_request_body_bytes,
        )?;
        state.frozen_prefix = prefix.clone();
        Ok(prefix)
    }

    fn acknowledge(&self, prefix: &Arc<FrozenPrefix>) -> Result<(), SdkError> {
        let mut state = self.lock_state()?;
        let Some(current) = &state.frozen_prefix else {
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
        Ok(())
    }

    fn lock_state(&self) -> Result<MutexGuard<'_, ClientState>, SdkError> {
        self.inner
            .state
            .lock()
            .map_err(|_| SdkError::new("queue_state_error", "delivery state is unavailable"))
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
    state: Mutex<ClientState>,
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
}

impl ClientState {
    fn new(max_queue_events: usize, max_queue_bytes: usize) -> Self {
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
        }
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
        Ok(())
    }

    fn record_drop(&mut self, category: DeliveryCodeCategory) {
        self.dropped_events = self.dropped_events.saturating_add(1);
        self.last_outcome = DeliveryOutcome::Dropped;
        self.last_code = category;
    }

    fn add_totals(&mut self, totals: DeliveryTotals) {
        self.attempts = self.attempts.saturating_add(u64::from(totals.attempts));
        self.batches = self.batches.saturating_add(u64::from(totals.batches));
        self.accepted_events = self
            .accepted_events
            .saturating_add(totals.accepted_events as u64);
    }

    fn health_snapshot(&self) -> DeliveryHealthSnapshot {
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
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct DeliveryTotals {
    attempts: u32,
    batches: u32,
    accepted_events: usize,
}

enum DeliveryResult {
    Accepted(TransportResponse),
    Failed(DeliveryFailure),
}

impl DeliveryResult {
    fn totals(&self) -> DeliveryTotals {
        match self {
            Self::Accepted(response) => DeliveryTotals {
                attempts: response.attempts,
                batches: response.batches,
                accepted_events: response.accepted_events,
            },
            Self::Failed(failure) => failure.totals,
        }
    }
}

struct DeliveryFailure {
    error: SdkError,
    category: DeliveryCodeCategory,
    totals: DeliveryTotals,
}

#[cfg(test)]
mod tests;
