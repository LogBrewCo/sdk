use logbrew::{
    AutomaticDeliveryConfig, DeliveryOutcome, DeliveryPauseReason, LogBrewClient, LogEvent,
    Transport, TransportError, TransportResponse,
};
use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

const TIMESTAMP: &str = "2026-06-02T10:00:00Z";

#[derive(Clone)]
struct SharedTransport {
    state: Arc<(Mutex<TransportState>, Condvar)>,
}

struct TransportState {
    scripted: VecDeque<Result<TransportResponse, TransportError>>,
    bodies: Vec<Vec<u8>>,
    worker_threads: HashSet<thread::ThreadId>,
    block_next: bool,
    released: bool,
}

impl SharedTransport {
    fn scripted(results: Vec<Result<u16, TransportError>>) -> Self {
        Self::responses(
            results
                .into_iter()
                .map(|result| result.map(TransportResponse::new))
                .collect(),
        )
    }

    fn responses(results: Vec<Result<TransportResponse, TransportError>>) -> Self {
        Self {
            state: Arc::new((
                Mutex::new(TransportState {
                    scripted: results.into(),
                    bodies: Vec::new(),
                    worker_threads: HashSet::new(),
                    block_next: false,
                    released: false,
                }),
                Condvar::new(),
            )),
        }
    }

    fn always_accept() -> Self {
        Self::scripted(Vec::new())
    }

    fn block_next(&self) {
        self.state.0.lock().unwrap().block_next = true;
    }

    fn release(&self) {
        let mut state = self.state.0.lock().unwrap();
        state.released = true;
        self.state.1.notify_all();
    }

    fn bodies(&self) -> Vec<Vec<u8>> {
        self.state.0.lock().unwrap().bodies.clone()
    }

    fn worker_count(&self) -> usize {
        self.state.0.lock().unwrap().worker_threads.len()
    }
}

impl Transport for SharedTransport {
    fn send(&mut self, _api_key: &str, body: &[u8]) -> Result<TransportResponse, TransportError> {
        let mut state = self.state.0.lock().unwrap();
        state.bodies.push(body.to_vec());
        state.worker_threads.insert(thread::current().id());
        self.state.1.notify_all();
        if state.block_next {
            state.block_next = false;
            while !state.released {
                state = self.state.1.wait(state).unwrap();
            }
        }
        state
            .scripted
            .pop_front()
            .unwrap_or(Ok(TransportResponse::new(202)))
    }
}

fn config(interval: Duration, threshold: usize) -> AutomaticDeliveryConfig {
    AutomaticDeliveryConfig {
        enabled: true,
        interval,
        threshold,
        retry_base_delay: Duration::from_millis(10),
        retry_max_delay: Duration::from_millis(40),
    }
}

fn automatic_client(transport: SharedTransport, config: AutomaticDeliveryConfig) -> LogBrewClient {
    LogBrewClient::builder("logbrew-rust", "0.1.1")
        .api_key("LOGBREW_API_KEY")
        .max_retries(0)
        .build_with_owned_transport(transport, config)
        .unwrap()
}

fn queue_log(client: &mut LogBrewClient, id: &str) {
    client
        .log(id, TIMESTAMP, LogEvent::new("automatic", "info"))
        .unwrap();
}

fn wait_until(timeout: Duration, condition: impl Fn() -> bool) {
    let deadline = Instant::now() + timeout;
    while !condition() {
        assert!(Instant::now() < deadline, "condition timed out");
        thread::sleep(Duration::from_millis(2));
    }
}

#[test]
fn worker_starts_lazily_and_threshold_wakes_once() {
    let transport = SharedTransport::always_accept();
    let mut client = automatic_client(transport.clone(), config(Duration::from_secs(10), 2));
    assert!(!client.delivery_health().automatic_running);

    queue_log(&mut client, "evt_1");
    wait_until(Duration::from_secs(1), || {
        client.delivery_health().automatic_running
    });
    assert!(transport.bodies().is_empty());

    queue_log(&mut client, "evt_2");
    wait_until(Duration::from_secs(1), || client.pending_events() == 0);
    assert_eq!(transport.bodies().len(), 1);
    assert_eq!(transport.worker_count(), 1);
}

#[test]
fn interval_delivers_below_threshold() {
    let transport = SharedTransport::always_accept();
    let mut client = automatic_client(transport.clone(), config(Duration::from_millis(20), 10));
    queue_log(&mut client, "evt_interval");

    wait_until(Duration::from_secs(1), || client.pending_events() == 0);
    assert_eq!(transport.bodies().len(), 1);
}

#[test]
fn interval_rearms_after_a_complete_drain() {
    let transport = SharedTransport::always_accept();
    let mut client = automatic_client(transport.clone(), config(Duration::from_millis(20), 10));
    queue_log(&mut client, "evt_threshold");
    assert_eq!(client.flush_owned().unwrap().accepted_events, 1);
    assert_eq!(transport.bodies().len(), 1);

    queue_log(&mut client, "evt_rearmed_interval");
    wait_until(Duration::from_secs(1), || client.pending_events() == 0);
    assert_eq!(transport.bodies().len(), 2);
}

#[test]
fn exhausted_retry_reuses_identical_prefix_then_accepts() {
    let transport = SharedTransport::scripted(vec![Ok(503), Ok(202)]);
    let mut client = automatic_client(transport.clone(), config(Duration::from_secs(10), 1));
    queue_log(&mut client, "evt_retry");

    wait_until(Duration::from_secs(1), || client.pending_events() == 0);
    let bodies = transport.bodies();
    assert_eq!(bodies.len(), 2);
    assert_eq!(bodies[0], bodies[1]);
    assert_eq!(client.delivery_health().consecutive_failures, 0);
}

#[test]
fn terminal_pause_requires_explicit_owned_flush_recovery() {
    let transport = SharedTransport::scripted(vec![Ok(401), Ok(202)]);
    let mut client = automatic_client(transport.clone(), config(Duration::from_millis(20), 1));
    queue_log(&mut client, "evt_paused");
    wait_until(Duration::from_secs(1), || {
        client.delivery_health().pause_reason == DeliveryPauseReason::Authentication
    });
    queue_log(&mut client, "evt_later");
    thread::sleep(Duration::from_millis(50));
    assert_eq!(transport.bodies().len(), 1);

    let response = client.flush_owned().unwrap();
    assert_eq!(response.accepted_events, 2);
    assert_eq!(client.pending_events(), 0);
    assert_eq!(
        client.delivery_health().pause_reason,
        DeliveryPauseReason::None
    );
}

#[test]
fn terminal_rejection_pauses_with_a_fixed_reason() {
    let transport = SharedTransport::scripted(vec![Ok(403)]);
    let mut client = automatic_client(transport, config(Duration::from_secs(10), 1));
    queue_log(&mut client, "evt_rejected");

    wait_until(Duration::from_secs(1), || {
        client.delivery_health().pause_reason == DeliveryPauseReason::Rejected
    });
    assert_eq!(
        client.delivery_health().last_outcome,
        DeliveryOutcome::Paused
    );
    assert_eq!(client.pending_events(), 1);
}

#[test]
fn retryable_network_and_timeout_exhaustion_schedule_bounded_retry() {
    for failure in [Err(TransportError::network("offline")), Ok(408), Ok(503)] {
        let transport = SharedTransport::scripted(vec![failure]);
        let mut retry_config = config(Duration::from_secs(10), 1);
        retry_config.retry_base_delay = Duration::from_millis(500);
        retry_config.retry_max_delay = Duration::from_millis(500);
        let mut client = automatic_client(transport, retry_config);
        queue_log(&mut client, "evt_retryable");

        wait_until(Duration::from_secs(1), || {
            client.delivery_health().last_outcome == DeliveryOutcome::RetryScheduled
        });
        let health = client.delivery_health();
        assert_eq!(health.pause_reason, DeliveryPauseReason::None);
        assert!(health.next_retry_delay >= Duration::from_millis(250));
        assert!(health.next_retry_delay <= Duration::from_millis(500));
        assert_eq!(health.pending_events, 1);
    }
}

#[test]
fn capture_during_io_is_coalesced_and_delivered_after_snapshot() {
    let transport = SharedTransport::always_accept();
    transport.block_next();
    let mut client = automatic_client(transport.clone(), config(Duration::from_secs(10), 1));
    queue_log(&mut client, "evt_first");
    wait_until(Duration::from_secs(1), || {
        client.delivery_health().delivery_in_flight
    });

    queue_log(&mut client, "evt_later");
    assert!(client.delivery_health().wake_coalesced);
    transport.release();

    wait_until(Duration::from_secs(1), || client.pending_events() == 0);
    assert_eq!(transport.bodies().len(), 2);
}

#[test]
fn disabled_automatic_mode_keeps_explicit_owned_transport_workflow() {
    let transport = SharedTransport::always_accept();
    let mut disabled = config(Duration::from_millis(10), 1);
    disabled.enabled = false;
    let mut client = automatic_client(transport.clone(), disabled);
    queue_log(&mut client, "evt_manual");
    thread::sleep(Duration::from_millis(30));
    assert!(!client.delivery_health().automatic_running);
    assert!(transport.bodies().is_empty());

    assert_eq!(client.flush_owned().unwrap().accepted_events, 1);
}

#[test]
fn disabled_automatic_mode_failed_owned_flush_does_not_schedule_retry() {
    let transport = SharedTransport::scripted(vec![Ok(503)]);
    let mut disabled = config(Duration::from_secs(10), 1);
    disabled.enabled = false;
    let mut client = automatic_client(transport, disabled);
    queue_log(&mut client, "evt_disabled_retry");

    assert_eq!(client.flush_owned().unwrap_err().code, "transport_error");
    let health = client.delivery_health();
    assert_eq!(health.last_outcome, DeliveryOutcome::Failed);
    assert_eq!(health.pause_reason, DeliveryPauseReason::None);
    assert_eq!(health.next_retry_delay, Duration::ZERO);
    assert_eq!(health.consecutive_failures, 0);
    assert_eq!(health.pending_events, 1);
}

#[test]
fn failed_owned_shutdown_reopens_and_successful_retry_closes() {
    let transport =
        SharedTransport::scripted(vec![Err(TransportError::network("unavailable")), Ok(202)]);
    let mut client = automatic_client(transport, config(Duration::from_secs(10), 100));
    queue_log(&mut client, "evt_before_shutdown");

    assert_eq!(client.shutdown_owned().unwrap_err().code, "network_failure");
    assert!(!client.delivery_health().closed);
    assert!(!client.delivery_health().automatic_running);
    queue_log(&mut client, "evt_after_failure");

    assert_eq!(client.shutdown_owned().unwrap().accepted_events, 2);
    assert!(client.delivery_health().closed);
    assert_eq!(
        client
            .log("evt_closed", TIMESTAMP, LogEvent::new("closed", "info"))
            .unwrap_err()
            .code,
        "shutdown_error"
    );
}

#[test]
fn clones_share_one_worker_and_final_owner_stops_it_without_delivery() {
    let transport = SharedTransport::always_accept();
    let mut first = automatic_client(transport.clone(), config(Duration::from_secs(10), 100));
    let second = first.clone();
    queue_log(&mut first, "evt_retained");
    wait_until(Duration::from_secs(1), || {
        first.delivery_health().automatic_running
    });

    drop(first);
    assert!(second.delivery_health().automatic_running);
    drop(second);
    thread::sleep(Duration::from_millis(30));
    assert!(transport.bodies().is_empty());
}

#[test]
fn automatic_health_is_fixed_and_content_free() {
    let fixture = "DO_NOT_EXPOSE_AUTOMATIC_MATERIAL";
    let transport = SharedTransport::scripted(vec![Ok(429)]);
    let mut client = LogBrewClient::builder("logbrew-rust", "0.1.1")
        .api_key(fixture)
        .max_retries(0)
        .build_with_owned_transport(transport, config(Duration::from_secs(10), 1))
        .unwrap();
    client
        .log(
            "evt_private_identifier",
            TIMESTAMP,
            LogEvent::new("private payload", "info"),
        )
        .unwrap();
    wait_until(Duration::from_secs(1), || {
        client.delivery_health().pause_reason == DeliveryPauseReason::Quota
    });

    let health = client.delivery_health();
    assert!(health.automatic_enabled);
    assert!(health.automatic_running);
    assert_eq!(health.pause_reason, DeliveryPauseReason::Quota);
    assert_eq!(health.last_outcome, DeliveryOutcome::Paused);
    for forbidden in [fixture, "evt_private_identifier", "private payload", "429"] {
        assert!(!format!("{health:?}").contains(forbidden));
    }
}

#[test]
fn automatic_configuration_rejects_zero_and_inverted_bounds() {
    for invalid in [
        AutomaticDeliveryConfig {
            interval: Duration::ZERO,
            ..AutomaticDeliveryConfig::default()
        },
        AutomaticDeliveryConfig {
            threshold: 0,
            ..AutomaticDeliveryConfig::default()
        },
        AutomaticDeliveryConfig {
            retry_base_delay: Duration::ZERO,
            ..AutomaticDeliveryConfig::default()
        },
        AutomaticDeliveryConfig {
            retry_base_delay: Duration::from_secs(2),
            retry_max_delay: Duration::from_secs(1),
            ..AutomaticDeliveryConfig::default()
        },
        AutomaticDeliveryConfig {
            interval: Duration::MAX,
            ..AutomaticDeliveryConfig::default()
        },
        AutomaticDeliveryConfig {
            retry_base_delay: Duration::MAX,
            retry_max_delay: Duration::MAX,
            ..AutomaticDeliveryConfig::default()
        },
    ] {
        let error = LogBrewClient::builder("rust", "0.1.1")
            .api_key("key")
            .build_with_owned_transport(SharedTransport::always_accept(), invalid)
            .unwrap_err();
        assert_eq!(error.code, "config_error");
    }
}

#[test]
fn owned_transport_is_required_for_owned_operations() {
    let mut client = LogBrewClient::builder("rust", "0.1.1")
        .api_key("key")
        .build()
        .unwrap();
    queue_log(&mut client, "evt_manual");
    assert_eq!(client.flush_owned().unwrap_err().code, "transport_error");
    assert_eq!(client.shutdown_owned().unwrap_err().code, "transport_error");
    assert_eq!(client.pending_events(), 1);
}

#[test]
fn worker_retry_delay_stays_bounded_after_exhaustion() {
    let transport = SharedTransport::scripted(vec![Ok(503), Ok(503), Ok(503)]);
    let mut retry_config = config(Duration::from_secs(10), 1);
    retry_config.retry_base_delay = Duration::from_millis(200);
    retry_config.retry_max_delay = Duration::from_millis(200);
    let mut client = automatic_client(transport, retry_config);
    queue_log(&mut client, "evt_retry_bounds");
    wait_until(Duration::from_secs(1), || {
        client.delivery_health().consecutive_failures == 1
    });

    let health = client.delivery_health();
    assert!(health.next_retry_delay >= Duration::from_millis(100));
    assert!(health.next_retry_delay <= Duration::from_millis(200));
}

#[test]
fn shutdown_waits_for_active_worker_then_drains_the_start_snapshot_once() {
    let transport = SharedTransport::always_accept();
    transport.block_next();
    let mut client = automatic_client(transport.clone(), config(Duration::from_secs(10), 1));
    queue_log(&mut client, "evt_active");
    wait_until(Duration::from_secs(1), || {
        client.delivery_health().delivery_in_flight
    });
    queue_log(&mut client, "evt_shutdown_snapshot");

    let mut shutting_down = client.clone();
    let handle = thread::spawn(move || shutting_down.shutdown_owned());
    thread::sleep(Duration::from_millis(20));
    transport.release();
    let response = handle.join().unwrap().unwrap();

    assert_eq!(response.accepted_events, 1);
    assert!(client.delivery_health().closed);
    assert_eq!(transport.bodies().len(), 2);
}

#[test]
fn owned_transport_drop_releases_resources_after_final_client_owner() {
    struct DropTransport(mpsc::Sender<()>);

    impl Drop for DropTransport {
        fn drop(&mut self) {
            let _ = self.0.send(());
        }
    }

    impl Transport for DropTransport {
        fn send(
            &mut self,
            _api_key: &str,
            _body: &[u8],
        ) -> Result<TransportResponse, TransportError> {
            Ok(TransportResponse::new(202))
        }
    }

    let (sender, receiver) = mpsc::channel();
    let mut client = LogBrewClient::builder("rust", "0.1.1")
        .api_key("key")
        .build_with_owned_transport(DropTransport(sender), config(Duration::from_secs(10), 100))
        .unwrap();
    queue_log(&mut client, "evt_retained");
    drop(client);
    receiver.recv_timeout(Duration::from_secs(1)).unwrap();
}

fn event_count(body: &[u8]) -> usize {
    let batch: serde_json::Value = serde_json::from_slice(body).unwrap();
    batch["events"].as_array().unwrap().len()
}

#[test]
fn default_interval_delivers_a_single_event_within_about_one_second() {
    let transport = SharedTransport::always_accept();
    let mut client = automatic_client(transport.clone(), AutomaticDeliveryConfig::default());
    let captured_at = Instant::now();
    queue_log(&mut client, "evt_latency_001");

    wait_until(Duration::from_millis(1500), || {
        !transport.bodies().is_empty()
    });

    assert!(captured_at.elapsed() >= Duration::from_millis(900));
    client.shutdown_owned().unwrap();
}

#[test]
fn default_interval_sends_a_burst_as_one_request() {
    let transport = SharedTransport::always_accept();
    let mut client = automatic_client(transport.clone(), AutomaticDeliveryConfig::default());
    for index in 0..20 {
        queue_log(&mut client, &format!("evt_burst_{index:03}"));
    }

    wait_until(Duration::from_millis(1500), || {
        !transport.bodies().is_empty()
    });

    assert_eq!(event_count(&transport.bodies()[0]), 20);
    client.shutdown_owned().unwrap();
}

fn rate_limited(retry_after: Option<Duration>, code: Option<&str>) -> TransportResponse {
    TransportResponse {
        retry_after,
        error_code: code.map(str::to_string),
        ..TransportResponse::new(429)
    }
}

fn wait_for_retry(client: &LogBrewClient) -> Duration {
    wait_until(Duration::from_secs(1), || {
        client.delivery_health().last_outcome == DeliveryOutcome::RetryScheduled
    });
    let health = client.delivery_health();
    assert_eq!(health.pause_reason, DeliveryPauseReason::None);
    assert_eq!(health.pending_events, 1);
    health.next_retry_delay
}

#[test]
fn retry_after_seconds_waits_then_resends_the_same_batch_without_an_app_call() {
    // Retry-After: 1 (delta-seconds) from a 429 response.
    let transport =
        SharedTransport::responses(vec![Ok(rate_limited(Some(Duration::from_secs(1)), None))]);
    let mut client = automatic_client(transport.clone(), config(Duration::from_millis(20), 1));
    queue_log(&mut client, "evt_rate_limited");

    let delay = wait_for_retry(&client);
    assert!(delay >= Duration::from_secs(1) && delay <= Duration::from_millis(1_100));
    thread::sleep(Duration::from_millis(500));
    assert_eq!(transport.bodies().len(), 1);

    wait_until(Duration::from_secs(3), || client.pending_events() == 0);
    let bodies = transport.bodies();
    assert_eq!(bodies.len(), 2);
    assert_eq!(bodies[0], bodies[1]);
    assert_eq!(client.delivery_health().consecutive_failures, 0);
}

#[test]
fn rate_limited_code_without_retry_after_uses_bounded_backoff() {
    let code = Some("rate_limited");
    let transport = SharedTransport::responses(vec![
        Ok(rate_limited(None, code)),
        Ok(rate_limited(None, code)),
    ]);
    let mut client = automatic_client(transport, config(Duration::from_millis(20), 1));
    queue_log(&mut client, "evt_rate_limited_code");

    let delay = wait_for_retry(&client);
    assert!(delay >= Duration::from_secs(1) && delay <= Duration::from_millis(1_100));
    let error = client.flush_owned().unwrap_err();
    assert_eq!(error.code, "quota_exhausted");
    assert_eq!(
        client.delivery_health().last_outcome,
        DeliveryOutcome::RetryScheduled
    );
}

#[test]
fn usage_limit_exceeded_pauses_even_with_retry_after() {
    let transport = SharedTransport::responses(vec![Ok(rate_limited(
        Some(Duration::from_secs(1)),
        Some("usage_limit_exceeded"),
    ))]);
    let mut client = automatic_client(transport.clone(), config(Duration::from_millis(20), 1));
    queue_log(&mut client, "evt_usage_limit");

    wait_until(Duration::from_secs(1), || {
        client.delivery_health().pause_reason == DeliveryPauseReason::Quota
    });
    let health = client.delivery_health();
    assert_eq!(health.last_outcome, DeliveryOutcome::Paused);
    assert_eq!(health.next_retry_delay, Duration::ZERO);
    thread::sleep(Duration::from_millis(1_200));
    assert_eq!(transport.bodies().len(), 1);
}

#[test]
fn rate_limit_wait_is_bounded_between_one_second_and_one_hour() {
    for (retry_after, minimum, maximum) in [
        (Duration::ZERO, 1_000, 1_100),
        (Duration::from_secs(7_200), 3_600_000, 3_600_000),
    ] {
        let transport = SharedTransport::responses(vec![Ok(rate_limited(Some(retry_after), None))]);
        let mut client = automatic_client(transport, config(Duration::from_millis(20), 1));
        queue_log(&mut client, "evt_rate_limit_bounds");

        let delay = wait_for_retry(&client);
        assert!(delay >= Duration::from_millis(minimum));
        assert!(delay <= Duration::from_millis(maximum));
    }
}
