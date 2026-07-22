use super::*;
use crate::{LogEvent, Transport, TransportError, TransportResponse};
use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

#[test]
fn health_counters_saturate_without_wrapping() {
    let mut state = ClientState::new(1, 1);
    state.dropped_events = u64::MAX;
    state.attempts = u64::MAX;
    state.batches = u64::MAX;
    state.accepted_events = u64::MAX;

    state.record_drop(DeliveryCodeCategory::QueueFull);
    state.add_totals(DeliveryTotals {
        attempts: 1,
        batches: 1,
        accepted_events: 1,
    });

    assert_eq!(state.dropped_events, u64::MAX);
    assert_eq!(state.attempts, u64::MAX);
    assert_eq!(state.batches, u64::MAX);
    assert_eq!(state.accepted_events, u64::MAX);
}

const TIMESTAMP: &str = "2026-06-02T10:00:00Z";

#[derive(Clone)]
struct SharedTransport {
    state: Arc<(Mutex<TransportState>, Condvar)>,
}

struct TransportState {
    scripted: VecDeque<Result<u16, TransportError>>,
    bodies: Vec<Vec<u8>>,
    worker_threads: HashSet<thread::ThreadId>,
    block_next: bool,
    released: bool,
    dropped: Option<mpsc::Sender<()>>,
}

impl SharedTransport {
    fn scripted(results: Vec<Result<u16, TransportError>>) -> Self {
        Self {
            state: Arc::new((
                Mutex::new(TransportState {
                    scripted: results.into(),
                    bodies: Vec::new(),
                    worker_threads: HashSet::new(),
                    block_next: false,
                    released: false,
                    dropped: None,
                }),
                Condvar::new(),
            )),
        }
    }

    fn with_drop_signal(results: Vec<Result<u16, TransportError>>) -> (Self, mpsc::Receiver<()>) {
        let (sender, receiver) = mpsc::channel();
        let transport = Self::scripted(results);
        transport.state.0.lock().unwrap().dropped = Some(sender);
        (transport, receiver)
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
}

impl Drop for SharedTransport {
    fn drop(&mut self) {
        if let Some(sender) = self.state.0.lock().unwrap().dropped.take() {
            let _ = sender.send(());
        }
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
        match state.scripted.pop_front().unwrap_or(Ok(202)) {
            Ok(status) => Ok(TransportResponse::new(status)),
            Err(error) => Err(error),
        }
    }
}

fn automatic_client(transport: SharedTransport, config: AutomaticDeliveryConfig) -> LogBrewClient {
    LogBrewClient::builder("logbrew-rust", "0.1.1")
        .api_key("LOGBREW_API_KEY")
        .max_retries(0)
        .build_with_owned_transport(transport, config)
        .unwrap()
}

fn wait_until(timeout: Duration, condition: impl Fn() -> bool) {
    let deadline = Instant::now() + timeout;
    while !condition() {
        assert!(Instant::now() < deadline, "condition timed out");
        thread::sleep(Duration::from_millis(2));
    }
}

#[test]
fn retained_event_stays_successful_when_scheduler_notification_fails() {
    let transport = SharedTransport::always_accept();
    let mut client = automatic_client(
        transport.clone(),
        AutomaticDeliveryConfig {
            enabled: true,
            interval: Duration::from_secs(5),
            threshold: 1,
            retry_base_delay: Duration::from_millis(10),
            retry_max_delay: Duration::from_millis(40),
        },
    );
    let automatic = client.inner.automatic.as_ref().unwrap().clone();
    automatic.poison_scheduler_for_test();

    client
        .log(
            "evt_retained",
            TIMESTAMP,
            LogEvent::new("automatic", "info"),
        )
        .unwrap();

    assert_eq!(client.pending_events(), 1);
    let health = client.delivery_health();
    assert_eq!(health.last_outcome, DeliveryOutcome::Failed);
    assert_eq!(health.last_code, DeliveryCodeCategory::State);

    let flush = client.flush_owned().unwrap();
    assert_eq!(flush.accepted_events, 1);
    assert_eq!(client.pending_events(), 0);
    assert_eq!(transport.bodies().len(), 1);

    client
        .log(
            "evt_recovered_automatic",
            TIMESTAMP,
            LogEvent::new("automatic", "info"),
        )
        .unwrap();
    wait_until(Duration::from_secs(1), || client.pending_events() == 0);
    assert_eq!(transport.bodies().len(), 2);

    let shutdown = client.shutdown_owned().unwrap();
    assert_eq!(shutdown.accepted_events, 0);
    assert!(client.delivery_health().closed);
}

#[test]
fn external_flush_marks_manual_exclusion_until_it_finishes() {
    let owned_transport = SharedTransport::always_accept();
    let mut client = automatic_client(
        owned_transport.clone(),
        AutomaticDeliveryConfig {
            enabled: true,
            interval: Duration::from_secs(10),
            threshold: 2,
            retry_base_delay: Duration::from_millis(10),
            retry_max_delay: Duration::from_millis(40),
        },
    );
    client
        .log("evt_first", TIMESTAMP, LogEvent::new("automatic", "info"))
        .unwrap();

    let external_transport = SharedTransport::always_accept();
    external_transport.block_next();
    let mut flushing = client.clone();
    let external_clone = external_transport.clone();
    let handle = thread::spawn(move || {
        let mut transport = external_clone;
        flushing.flush(&mut transport)
    });

    wait_until(Duration::from_secs(1), || {
        client.delivery_health().delivery_in_flight
    });
    client
        .log("evt_second", TIMESTAMP, LogEvent::new("automatic", "info"))
        .unwrap();

    let automatic = client.inner.automatic.as_ref().unwrap().clone();
    wait_until(Duration::from_secs(1), || {
        automatic.manual_deliveries_for_test() == 1
    });
    assert!(owned_transport.bodies().is_empty());

    external_transport.release();
    let response = handle.join().unwrap().unwrap();
    assert_eq!(response.accepted_events, 1);
    wait_until(Duration::from_secs(1), || client.pending_events() == 0);
    assert_eq!(owned_transport.bodies().len(), 1);
}

#[test]
fn final_owner_drop_requests_stop_without_waiting_for_blocked_transport() {
    let (transport, dropped) = SharedTransport::with_drop_signal(Vec::new());
    transport.block_next();
    let mut client = automatic_client(
        transport.clone(),
        AutomaticDeliveryConfig {
            enabled: true,
            interval: Duration::from_secs(10),
            threshold: 1,
            retry_base_delay: Duration::from_millis(10),
            retry_max_delay: Duration::from_millis(40),
        },
    );
    client
        .log("evt_blocked", TIMESTAMP, LogEvent::new("automatic", "info"))
        .unwrap();
    wait_until(Duration::from_secs(1), || {
        client.delivery_health().delivery_in_flight
    });

    let automatic = client.inner.automatic.as_ref().unwrap().clone();
    let (sender, receiver) = mpsc::channel();
    let handle = thread::spawn(move || {
        drop(client);
        let _ = sender.send(());
    });

    let returned_promptly = receiver.recv_timeout(Duration::from_millis(50)).is_ok();
    assert!(automatic.stop_requested_for_test());

    transport.release();
    handle.join().unwrap();
    wait_until(Duration::from_secs(1), || !automatic.running_for_test());
    drop(automatic);
    dropped.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(returned_promptly, "final drop blocked on owned transport");
}
