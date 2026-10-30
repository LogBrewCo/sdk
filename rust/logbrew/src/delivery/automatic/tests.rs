use super::{
    AutomaticDelivery, AutomaticDeliveryConfig, pause_reason, rate_limit_delay, retry_delay,
};
use crate::{
    DeliveryCodeCategory, DeliveryOutcome, DeliveryPauseReason, LogBrewClient, SdkError, Transport,
    TransportError, TransportResponse,
};
use alloc::sync::Arc;
use core::time::Duration;
use std::thread;
use std::time::Instant;

struct NoopTransport;

impl Transport for NoopTransport {
    fn send(&mut self, _api_key: &str, _body: &[u8]) -> Result<TransportResponse, TransportError> {
        Ok(TransportResponse::new(202))
    }
}

fn wait_until(timeout: Duration, condition: impl Fn() -> bool) {
    let deadline = Instant::now().checked_add(timeout).unwrap();
    while !condition() {
        assert!(Instant::now() < deadline, "condition timed out");
        thread::sleep(Duration::from_millis(2));
    }
}

fn manual_client() -> LogBrewClient {
    LogBrewClient::builder("rust", "0.1.1")
        .api_key("key")
        .build()
        .unwrap()
}

#[test]
fn interval_deadline_overflow_fails_closed_without_worker_panic() {
    let client = manual_client();
    let automatic = Arc::new(AutomaticDelivery::new(
        Box::new(NoopTransport),
        AutomaticDeliveryConfig {
            interval: Duration::MAX,
            threshold: usize::MAX,
            ..AutomaticDeliveryConfig::default()
        },
    ));

    automatic.notify_retained(&client.inner, 1).unwrap();
    wait_until(Duration::from_secs(1), || !automatic.health().running);

    let health = automatic.health();
    assert!(!health.enabled);
    assert_eq!(health.pause_reason, DeliveryPauseReason::State);
    assert_eq!(health.next_retry_delay, Duration::ZERO);
    assert_eq!(
        client.delivery_health().last_outcome,
        DeliveryOutcome::Failed
    );
    assert_eq!(
        client.delivery_health().last_code,
        DeliveryCodeCategory::State
    );
    automatic.stop_and_join().unwrap();
}

#[test]
fn retry_deadline_overflow_fails_closed_without_panic() {
    let client = manual_client();
    let automatic = AutomaticDelivery::new(
        Box::new(NoopTransport),
        AutomaticDeliveryConfig {
            retry_base_delay: Duration::MAX,
            retry_max_delay: Duration::MAX,
            ..AutomaticDeliveryConfig::default()
        },
    );
    let result = Err(SdkError::new("network_failure", "fixed"));

    automatic.record_automatic_result(&client.inner, &result);

    let health = automatic.health();
    assert!(!health.enabled);
    assert!(!health.running);
    assert_eq!(health.pause_reason, DeliveryPauseReason::State);
    assert_eq!(health.next_retry_delay, Duration::ZERO);
    assert_eq!(
        client.delivery_health().last_outcome,
        DeliveryOutcome::Failed
    );
    assert_eq!(
        client.delivery_health().last_code,
        DeliveryCodeCategory::State
    );
}

#[test]
fn equal_jitter_delay_is_exponential_and_capped() {
    for failures in 1..=12 {
        let delay = retry_delay(
            Duration::from_millis(100),
            Duration::from_millis(800),
            failures,
            17,
        );
        let exponent = failures.saturating_sub(1).min(3);
        let ceiling =
            Duration::from_millis(100 * (1_u64 << exponent)).min(Duration::from_millis(800));
        assert!(delay >= ceiling / 2);
        assert!(delay <= ceiling);
    }
}

#[test]
fn rate_limit_delay_is_clamped_with_bounded_jitter() {
    let second = Duration::from_secs(1);
    let hour = Duration::from_secs(3_600);
    assert_eq!(rate_limit_delay(Duration::ZERO, 0), second);
    assert_eq!(
        rate_limit_delay(Duration::ZERO, 1_000),
        second + second / 10
    );
    assert_eq!(
        rate_limit_delay(Duration::from_secs(120), 500),
        Duration::from_secs(126)
    );
    assert_eq!(
        rate_limit_delay(hour.checked_sub(second).unwrap(), 1_000),
        hour
    );
    assert_eq!(rate_limit_delay(Duration::MAX, 1_000), hour);
}

#[test]
fn overlapping_manual_delivery_keeps_worker_excluded_until_all_callers_finish() {
    let automatic =
        AutomaticDelivery::new(Box::new(NoopTransport), AutomaticDeliveryConfig::default());
    automatic.begin_manual_delivery();
    automatic.begin_manual_delivery();

    assert_eq!(automatic.scheduler.lock().unwrap().manual_deliveries, 2);
}

#[test]
fn deterministic_local_failure_pauses_instead_of_network_retry() {
    assert_eq!(
        pause_reason(
            &SdkError::new("queue_state_error", "fixed"),
            DeliveryCodeCategory::Acknowledgement,
        ),
        DeliveryPauseReason::State
    );
}
