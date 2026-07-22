use super::{
    AutomaticDeliveryConfig, ClientInner, DeliveryCodeCategory, DeliveryOutcome,
    DeliveryPauseReason,
};
use crate::{SdkError, Transport, TransportResponse};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, Weak};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(super) struct AutomaticDelivery {
    config: AutomaticDeliveryConfig,
    transport: Mutex<Box<dyn Transport + Send>>,
    scheduler: Mutex<SchedulerState>,
    wake: Condvar,
}

struct SchedulerState {
    active: bool,
    running: bool,
    stop_requested: bool,
    wake_pending: bool,
    wake_coalesced: bool,
    manual_deliveries: usize,
    first_pending_at: Option<Instant>,
    retry_at: Option<Instant>,
    next_retry_delay: Duration,
    consecutive_failures: u32,
    pause_reason: DeliveryPauseReason,
    worker: Option<JoinHandle<()>>,
}

enum WorkerAction {
    Deliver,
    Stop,
    DeadlineOverflow,
}

#[derive(Clone, Copy)]
pub(super) struct AutomaticHealth {
    pub enabled: bool,
    pub running: bool,
    pub wake_coalesced: bool,
    pub consecutive_failures: u32,
    pub pause_reason: DeliveryPauseReason,
    pub next_retry_delay: Duration,
}

impl AutomaticHealth {
    pub(super) const fn disabled() -> Self {
        Self {
            enabled: false,
            running: false,
            wake_coalesced: false,
            consecutive_failures: 0,
            pause_reason: DeliveryPauseReason::None,
            next_retry_delay: Duration::ZERO,
        }
    }
}

impl AutomaticDelivery {
    pub(super) fn new(
        transport: Box<dyn Transport + Send>,
        config: AutomaticDeliveryConfig,
    ) -> Self {
        Self {
            config,
            transport: Mutex::new(transport),
            scheduler: Mutex::new(SchedulerState {
                active: config.enabled,
                running: false,
                stop_requested: false,
                wake_pending: false,
                wake_coalesced: false,
                manual_deliveries: 0,
                first_pending_at: None,
                retry_at: None,
                next_retry_delay: Duration::ZERO,
                consecutive_failures: 0,
                pause_reason: DeliveryPauseReason::None,
                worker: None,
            }),
            wake: Condvar::new(),
        }
    }

    pub(super) fn notify_retained(
        self: &Arc<Self>,
        client: &Arc<ClientInner>,
        pending_events: usize,
    ) -> Result<(), SdkError> {
        let mut state = self.lock_scheduler()?;
        if !state.active {
            return Ok(());
        }
        if !state.running {
            state.running = true;
            state.stop_requested = false;
            let automatic = Arc::clone(self);
            let client = Arc::downgrade(client);
            match thread::Builder::new()
                .name("logbrew-delivery".to_string())
                .spawn(move || automatic.run(client))
            {
                Ok(worker) => state.worker = Some(worker),
                Err(_) => {
                    state.running = false;
                    return Err(SdkError::new(
                        "scheduler_error",
                        "automatic delivery worker could not start",
                    ));
                }
            }
        }
        let interval_started = state.first_pending_at.is_none();
        state.first_pending_at.get_or_insert_with(Instant::now);
        if interval_started {
            self.wake.notify_one();
        }
        if pending_events >= self.config.threshold {
            if state.wake_pending || client.delivery_in_flight() {
                state.wake_coalesced = true;
            }
            state.wake_pending = true;
            self.wake.notify_one();
        }
        Ok(())
    }

    pub(super) fn health(&self) -> AutomaticHealth {
        let state = self.scheduler_even_if_poisoned();
        AutomaticHealth {
            enabled: state.active,
            running: state.running,
            wake_coalesced: state.wake_coalesced,
            consecutive_failures: state.consecutive_failures,
            pause_reason: state.pause_reason,
            next_retry_delay: state.next_retry_delay,
        }
    }

    pub(super) fn flush_owned(&self, client: &ClientInner) -> Result<TransportResponse, SdkError> {
        self.with_manual_delivery(client, || self.deliver_with_transport(client, false))
    }

    pub(super) fn shutdown_owned(
        &self,
        client: &ClientInner,
    ) -> Result<TransportResponse, SdkError> {
        self.stop_and_join()?;
        self.deliver_with_transport(client, true)
    }

    pub(super) fn stop_and_join(&self) -> Result<(), SdkError> {
        self.request_stop();
        let worker = {
            let mut state = self.scheduler_even_if_poisoned();
            state.worker.take()
        };
        if let Some(worker) = worker {
            worker.join().map_err(|_| {
                SdkError::new(
                    "scheduler_error",
                    "automatic delivery worker did not stop cleanly",
                )
            })?;
        }
        let mut state = self.scheduler_even_if_poisoned();
        state.running = false;
        Ok(())
    }

    pub(super) fn request_stop(&self) {
        let mut state = self.scheduler_even_if_poisoned();
        state.active = false;
        state.stop_requested = true;
        state.wake_pending = false;
        state.retry_at = None;
        state.next_retry_delay = Duration::ZERO;
        self.wake.notify_all();
    }

    fn run(self: Arc<Self>, client: Weak<ClientInner>) {
        loop {
            let action = {
                let mut state = self
                    .scheduler
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                loop {
                    if state.stop_requested {
                        state.running = false;
                        break WorkerAction::Stop;
                    }
                    if state.manual_deliveries > 0
                        || state.pause_reason != DeliveryPauseReason::None
                    {
                        state = self
                            .wake
                            .wait(state)
                            .unwrap_or_else(PoisonError::into_inner);
                        continue;
                    }

                    let now = Instant::now();
                    let deadline = match state.retry_at {
                        Some(deadline) => Some(deadline),
                        None => match state.first_pending_at {
                            Some(started) => match started.checked_add(self.config.interval) {
                                Some(deadline) => Some(deadline),
                                None => {
                                    fail_closed_scheduler(&mut state);
                                    break WorkerAction::DeadlineOverflow;
                                }
                            },
                            None => None,
                        },
                    };
                    if state.wake_pending && state.retry_at.is_none() {
                        state.wake_pending = false;
                        break WorkerAction::Deliver;
                    }
                    if deadline.is_some_and(|deadline| deadline <= now) {
                        state.retry_at = None;
                        state.next_retry_delay = Duration::ZERO;
                        break WorkerAction::Deliver;
                    }

                    state = match deadline {
                        Some(deadline) => {
                            let timeout = deadline.saturating_duration_since(now);
                            self.wake
                                .wait_timeout(state, timeout)
                                .unwrap_or_else(PoisonError::into_inner)
                                .0
                        }
                        None => self
                            .wake
                            .wait(state)
                            .unwrap_or_else(PoisonError::into_inner),
                    };
                }
            };

            match action {
                WorkerAction::Stop => return,
                WorkerAction::DeadlineOverflow => {
                    if let Some(client) = client.upgrade() {
                        client.record_automatic_state_failure();
                    }
                    return;
                }
                WorkerAction::Deliver => {}
            }
            let Some(client) = client.upgrade() else {
                return;
            };
            let result = self.deliver_with_transport(&client, false);
            self.record_automatic_result(&client, &result);
        }
    }

    fn deliver_with_transport(
        &self,
        client: &ClientInner,
        close_on_success: bool,
    ) -> Result<TransportResponse, SdkError> {
        let mut transport = self
            .transport
            .lock()
            .map_err(|_| SdkError::new("transport_error", "owned transport is unavailable"))?;
        client.deliver(transport.as_mut(), close_on_success)
    }

    pub(super) fn with_manual_delivery<F>(
        &self,
        client: &ClientInner,
        deliver: F,
    ) -> Result<TransportResponse, SdkError>
    where
        F: FnOnce() -> Result<TransportResponse, SdkError>,
    {
        self.begin_manual_delivery()?;
        let result = deliver();
        self.finish_manual_delivery(client, &result);
        result
    }

    fn begin_manual_delivery(&self) -> Result<(), SdkError> {
        let mut state = self.scheduler_even_if_poisoned();
        state.manual_deliveries = state.manual_deliveries.saturating_add(1);
        state.pause_reason = DeliveryPauseReason::None;
        state.retry_at = None;
        state.next_retry_delay = Duration::ZERO;
        self.wake.notify_all();
        Ok(())
    }

    fn finish_manual_delivery(
        &self,
        client: &ClientInner,
        result: &Result<TransportResponse, SdkError>,
    ) {
        self.record_result(client, result, true);
        let mut state = self.scheduler_even_if_poisoned();
        state.manual_deliveries = state.manual_deliveries.saturating_sub(1);
        self.wake.notify_all();
    }

    fn record_automatic_result(
        &self,
        client: &ClientInner,
        result: &Result<TransportResponse, SdkError>,
    ) {
        self.record_result(client, result, false);
    }

    fn record_result(
        &self,
        client: &ClientInner,
        result: &Result<TransportResponse, SdkError>,
        manual: bool,
    ) {
        let pending_events = client.pending_events();
        let mut scheduler_failed = false;
        let mut state = self.scheduler_even_if_poisoned();
        match result {
            Ok(_) => {
                state.consecutive_failures = 0;
                state.pause_reason = DeliveryPauseReason::None;
                state.retry_at = None;
                state.next_retry_delay = Duration::ZERO;
                state.first_pending_at = (pending_events > 0).then(Instant::now);
                state.wake_coalesced = false;
                if pending_events >= self.config.threshold && state.active && !manual {
                    state.wake_pending = true;
                }
            }
            Err(_) if manual && !state.active => {
                state.consecutive_failures = 0;
                state.pause_reason = DeliveryPauseReason::None;
                state.retry_at = None;
                state.next_retry_delay = Duration::ZERO;
                state.first_pending_at = None;
                state.wake_pending = false;
                state.wake_coalesced = false;
            }
            Err(error) if error.code == "queue_busy_error" => {
                state.wake_pending = true;
                state.wake_coalesced = true;
            }
            Err(error) => {
                state.consecutive_failures = state.consecutive_failures.saturating_add(1);
                state.first_pending_at = (pending_events > 0).then(Instant::now);
                let pause_reason = pause_reason(error, client.last_code());
                if pause_reason != DeliveryPauseReason::None {
                    state.pause_reason = pause_reason;
                    state.retry_at = None;
                    state.next_retry_delay = Duration::ZERO;
                    client.record_automatic_outcome(DeliveryOutcome::Paused);
                } else {
                    let delay = retry_delay(
                        self.config.retry_base_delay,
                        self.config.retry_max_delay,
                        state.consecutive_failures,
                        jitter_seed(),
                    );
                    match Instant::now().checked_add(delay) {
                        Some(deadline) => {
                            state.next_retry_delay = delay;
                            state.retry_at = Some(deadline);
                            client.record_automatic_outcome(DeliveryOutcome::RetryScheduled);
                        }
                        None => {
                            fail_closed_scheduler(&mut state);
                            scheduler_failed = true;
                        }
                    }
                }
            }
        }
        self.wake.notify_all();
        drop(state);
        if scheduler_failed {
            client.record_automatic_state_failure();
        }
    }

    fn lock_scheduler(&self) -> Result<MutexGuard<'_, SchedulerState>, SdkError> {
        self.scheduler.lock().map_err(|_| {
            SdkError::new("scheduler_error", "automatic delivery state is unavailable")
        })
    }

    fn scheduler_even_if_poisoned(&self) -> MutexGuard<'_, SchedulerState> {
        match self.scheduler.lock() {
            Ok(state) => state,
            Err(poisoned) => {
                self.scheduler.clear_poison();
                poisoned.into_inner()
            }
        }
    }

    #[cfg(test)]
    pub(super) fn poison_scheduler_for_test(&self) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = self.scheduler.lock().unwrap();
            panic!("poison scheduler");
        }));
    }

    #[cfg(test)]
    pub(super) fn manual_deliveries_for_test(&self) -> usize {
        self.scheduler_even_if_poisoned().manual_deliveries
    }

    #[cfg(test)]
    pub(super) fn stop_requested_for_test(&self) -> bool {
        self.scheduler_even_if_poisoned().stop_requested
    }

    #[cfg(test)]
    pub(super) fn running_for_test(&self) -> bool {
        self.scheduler_even_if_poisoned().running
    }
}

fn fail_closed_scheduler(state: &mut SchedulerState) {
    state.active = false;
    state.running = false;
    state.stop_requested = true;
    state.wake_pending = false;
    state.wake_coalesced = false;
    state.first_pending_at = None;
    state.retry_at = None;
    state.next_retry_delay = Duration::ZERO;
    state.pause_reason = DeliveryPauseReason::State;
}

fn pause_reason(error: &SdkError, category: DeliveryCodeCategory) -> DeliveryPauseReason {
    if error.code == "quota_exhausted" {
        DeliveryPauseReason::Quota
    } else {
        match category {
            DeliveryCodeCategory::Authentication => DeliveryPauseReason::Authentication,
            DeliveryCodeCategory::Rejected => DeliveryPauseReason::Rejected,
            DeliveryCodeCategory::Serialization
            | DeliveryCodeCategory::Acknowledgement
            | DeliveryCodeCategory::State => DeliveryPauseReason::State,
            _ => DeliveryPauseReason::None,
        }
    }
}

fn retry_delay(base: Duration, maximum: Duration, failures: u32, jitter: u64) -> Duration {
    let exponent = failures.saturating_sub(1).min(31);
    let ceiling = base.saturating_mul(1u32 << exponent).min(maximum);
    let half = ceiling / 2;
    let remaining_nanos = ceiling
        .saturating_sub(half)
        .as_nanos()
        .min(u128::from(u64::MAX)) as u64;
    let jitter_nanos = if remaining_nanos == u64::MAX {
        jitter
    } else {
        jitter % (remaining_nanos + 1)
    };
    half.saturating_add(Duration::from_nanos(jitter_nanos))
}

fn jitter_seed() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.subsec_nanos().into())
}

#[cfg(test)]
mod tests {
    use super::{AutomaticDelivery, AutomaticDeliveryConfig, pause_reason, retry_delay};
    use crate::{
        DeliveryCodeCategory, DeliveryOutcome, DeliveryPauseReason, LogBrewClient, SdkError,
        Transport, TransportError, TransportResponse,
    };
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};

    struct NoopTransport;

    impl Transport for NoopTransport {
        fn send(
            &mut self,
            _api_key: &str,
            _body: &[u8],
        ) -> Result<TransportResponse, TransportError> {
            Ok(TransportResponse::new(202))
        }
    }

    fn wait_until(timeout: Duration, condition: impl Fn() -> bool) {
        let deadline = Instant::now() + timeout;
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
                Duration::from_millis(100 * (1u64 << exponent)).min(Duration::from_millis(800));
            assert!(delay >= ceiling / 2);
            assert!(delay <= ceiling);
        }
    }

    #[test]
    fn overlapping_manual_delivery_keeps_worker_excluded_until_all_callers_finish() {
        let automatic =
            AutomaticDelivery::new(Box::new(NoopTransport), AutomaticDeliveryConfig::default());
        automatic.begin_manual_delivery().unwrap();
        automatic.begin_manual_delivery().unwrap();

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
}
