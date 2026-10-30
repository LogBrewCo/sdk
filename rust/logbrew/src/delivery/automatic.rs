#[cfg(test)]
mod tests;

use super::{
    AutomaticDeliveryConfig, ClientInner, DeliveryCodeCategory, DeliveryOutcome,
    DeliveryPauseReason, RateLimitWait,
};
use crate::{SdkError, Transport, TransportResponse};
use alloc::sync::{Arc, Weak};
use core::time::Duration;
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::thread::JoinHandle;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

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
    wake_flags: WakeFlags,
    manual_deliveries: usize,
    first_pending_at: Option<Instant>,
    retry_at: Option<Instant>,
    next_retry_delay: Duration,
    consecutive_failures: u32,
    pause_reason: DeliveryPauseReason,
    worker: Option<JoinHandle<()>>,
}

struct WakeFlags {
    pending: bool,
    coalesced: bool,
}

enum WorkerAction {
    DeadlineOverflow,
    Deliver,
    Stop,
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
    fn begin_manual_delivery(&self) {
        let mut state = self.scheduler_even_if_poisoned();
        state.manual_deliveries = state.manual_deliveries.saturating_add(1);
        state.pause_reason = DeliveryPauseReason::None;
        state.retry_at = None;
        state.next_retry_delay = Duration::ZERO;
        drop(state);
        self.wake.notify_all();
    }

    fn deliver_with_transport(
        &self,
        client: &ClientInner,
        close_on_success: bool,
    ) -> Result<TransportResponse, SdkError> {
        let mut transport = self
            .transport
            .lock()
            .map_err(|_error| SdkError::new("transport_error", "owned transport is unavailable"))?;
        client.deliver(transport.as_mut(), close_on_success)
    }

    fn finish_manual_delivery(
        &self,
        client: &ClientInner,
        result: &Result<TransportResponse, SdkError>,
    ) {
        self.record_result(client, result, true);
        let mut state = self.scheduler_even_if_poisoned();
        state.manual_deliveries = state.manual_deliveries.saturating_sub(1);
        drop(state);
        self.wake.notify_all();
    }

    pub(super) fn flush_owned(&self, client: &ClientInner) -> Result<TransportResponse, SdkError> {
        self.with_manual_delivery(client, || self.deliver_with_transport(client, false))
    }

    pub(super) fn health(&self) -> AutomaticHealth {
        let state = self.scheduler_even_if_poisoned();
        AutomaticHealth {
            enabled: state.active,
            running: state.running,
            wake_coalesced: state.wake_flags.coalesced,
            consecutive_failures: state.consecutive_failures,
            pause_reason: state.pause_reason,
            next_retry_delay: state.next_retry_delay,
        }
    }

    fn lock_scheduler(&self) -> Result<MutexGuard<'_, SchedulerState>, SdkError> {
        self.scheduler.lock().map_err(|_error| {
            SdkError::new("scheduler_error", "automatic delivery state is unavailable")
        })
    }

    #[cfg(test)]
    pub(super) fn manual_deliveries_for_test(&self) -> usize {
        self.scheduler_even_if_poisoned().manual_deliveries
    }

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
                wake_flags: WakeFlags {
                    pending: false,
                    coalesced: false,
                },
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

    fn next_action(&self) -> WorkerAction {
        let mut state = self
            .scheduler
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        loop {
            if state.stop_requested {
                state.running = false;
                return WorkerAction::Stop;
            }
            if state.manual_deliveries > 0 || state.pause_reason != DeliveryPauseReason::None {
                state = self
                    .wake
                    .wait(state)
                    .unwrap_or_else(PoisonError::into_inner);
                continue;
            }

            let now = Instant::now();
            let deadline = match self.next_deadline(&state) {
                Ok(deadline) => deadline,
                Err(action) => {
                    fail_closed_scheduler(&mut state);
                    return action;
                }
            };
            if state.wake_flags.pending && state.retry_at.is_none() {
                state.wake_flags.pending = false;
                return WorkerAction::Deliver;
            }
            if deadline.is_some_and(|due| due <= now) {
                state.retry_at = None;
                state.next_retry_delay = Duration::ZERO;
                return WorkerAction::Deliver;
            }

            state = match deadline {
                Some(due) => {
                    self.wake
                        .wait_timeout(state, due.saturating_duration_since(now))
                        .unwrap_or_else(PoisonError::into_inner)
                        .0
                }
                None => self
                    .wake
                    .wait(state)
                    .unwrap_or_else(PoisonError::into_inner),
            };
        }
    }

    fn next_deadline(&self, state: &SchedulerState) -> Result<Option<Instant>, WorkerAction> {
        match (state.retry_at, state.first_pending_at) {
            (Some(deadline), _) => Ok(Some(deadline)),
            (None, Some(started)) => started
                .checked_add(self.config.interval)
                .map(Some)
                .ok_or(WorkerAction::DeadlineOverflow),
            (None, None) => Ok(None),
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
            let weak_client = Arc::downgrade(client);
            if let Ok(worker) = thread::Builder::new()
                .name("logbrew-delivery".to_owned())
                .spawn(move || automatic.run(&weak_client))
            {
                state.worker = Some(worker);
            } else {
                state.running = false;
                return Err(SdkError::new(
                    "scheduler_error",
                    "automatic delivery worker could not start",
                ));
            }
        }
        let interval_started = state.first_pending_at.is_none();
        if interval_started {
            state.first_pending_at = Some(Instant::now());
        }
        if interval_started {
            self.wake.notify_one();
        }
        if pending_events >= self.config.threshold {
            if state.wake_flags.pending || client.delivery_in_flight() {
                state.wake_flags.coalesced = true;
            }
            state.wake_flags.pending = true;
            drop(state);
            self.wake.notify_one();
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn poison_scheduler_for_test(&self) {
        use core::panic::AssertUnwindSafe;
        use std::panic::{catch_unwind, resume_unwind};
        let unwound = catch_unwind(AssertUnwindSafe(|| {
            let _guard = self.scheduler_even_if_poisoned();
            resume_unwind(Box::new("poison scheduler"));
        }));
        drop(unwound);
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
        match *result {
            Ok(_) => {
                state.consecutive_failures = 0;
                state.pause_reason = DeliveryPauseReason::None;
                state.retry_at = None;
                state.next_retry_delay = Duration::ZERO;
                state.first_pending_at = (pending_events > 0).then(Instant::now);
                state.wake_flags.coalesced = false;
                if pending_events >= self.config.threshold && state.active && !manual {
                    state.wake_flags.pending = true;
                }
            }
            Err(_) if manual && !state.active => {
                state.consecutive_failures = 0;
                state.pause_reason = DeliveryPauseReason::None;
                state.retry_at = None;
                state.next_retry_delay = Duration::ZERO;
                state.first_pending_at = None;
                state.wake_flags.pending = false;
                state.wake_flags.coalesced = false;
            }
            Err(ref error) if error.code == "queue_busy_error" => {
                state.wake_flags.pending = true;
                state.wake_flags.coalesced = true;
            }
            Err(ref error) => {
                state.consecutive_failures = state.consecutive_failures.saturating_add(1);
                state.first_pending_at = (pending_events > 0).then(Instant::now);
                let rate_limit_wait = client.rate_limit_wait();
                let pause_reason = if rate_limit_wait == RateLimitWait::NotLimited {
                    pause_reason(error, client.last_code())
                } else {
                    DeliveryPauseReason::None
                };
                if pause_reason == DeliveryPauseReason::None {
                    let backoff = retry_delay(
                        self.config.retry_base_delay,
                        self.config.retry_max_delay,
                        state.consecutive_failures,
                        jitter_seed(),
                    );
                    let delay = match rate_limit_wait {
                        RateLimitWait::NotLimited => backoff,
                        RateLimitWait::Backoff => rate_limit_delay(backoff, jitter_seed()),
                        RateLimitWait::RetryAfter(retry_after) => {
                            rate_limit_delay(retry_after, jitter_seed())
                        }
                    };
                    if let Some(deadline) = Instant::now().checked_add(delay) {
                        state.next_retry_delay = delay;
                        state.retry_at = Some(deadline);
                        client.record_automatic_outcome(DeliveryOutcome::RetryScheduled);
                    } else {
                        fail_closed_scheduler(&mut state);
                        scheduler_failed = true;
                    }
                } else {
                    state.pause_reason = pause_reason;
                    state.retry_at = None;
                    state.next_retry_delay = Duration::ZERO;
                    client.record_automatic_outcome(DeliveryOutcome::Paused);
                }
            }
        }
        self.wake.notify_all();
        drop(state);
        if scheduler_failed {
            client.record_automatic_state_failure();
        }
    }

    pub(super) fn request_stop(&self) {
        let mut state = self.scheduler_even_if_poisoned();
        state.active = false;
        state.stop_requested = true;
        state.wake_flags.pending = false;
        state.retry_at = None;
        state.next_retry_delay = Duration::ZERO;
        drop(state);
        self.wake.notify_all();
    }

    fn run(self: Arc<Self>, client: &Weak<ClientInner>) {
        loop {
            match self.next_action() {
                WorkerAction::Stop => return,
                WorkerAction::DeadlineOverflow => {
                    if let Some(inner) = client.upgrade() {
                        inner.record_automatic_state_failure();
                    }
                    return;
                }
                WorkerAction::Deliver => {}
            }
            let Some(inner) = client.upgrade() else {
                return;
            };
            let result = self.deliver_with_transport(&inner, false);
            self.record_automatic_result(&inner, &result);
        }
    }

    #[cfg(test)]
    pub(super) fn running_for_test(&self) -> bool {
        self.scheduler_even_if_poisoned().running
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
        if let Some(handle) = worker {
            handle.join().map_err(|_error| {
                SdkError::new(
                    "scheduler_error",
                    "automatic delivery worker did not stop cleanly",
                )
            })?;
        }
        let mut state = self.scheduler_even_if_poisoned();
        state.running = false;
        drop(state);
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn stop_requested_for_test(&self) -> bool {
        self.scheduler_even_if_poisoned().stop_requested
    }

    pub(super) fn with_manual_delivery<F>(
        &self,
        client: &ClientInner,
        deliver: F,
    ) -> Result<TransportResponse, SdkError>
    where
        F: FnOnce() -> Result<TransportResponse, SdkError>,
    {
        self.begin_manual_delivery();
        let result = deliver();
        self.finish_manual_delivery(client, &result);
        result
    }
}

const fn fail_closed_scheduler(state: &mut SchedulerState) {
    state.active = false;
    state.running = false;
    state.stop_requested = true;
    state.wake_flags.pending = false;
    state.wake_flags.coalesced = false;
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
            DeliveryCodeCategory::None
            | DeliveryCodeCategory::QueueFull
            | DeliveryCodeCategory::EventTooLarge
            | DeliveryCodeCategory::Network
            | DeliveryCodeCategory::Server => DeliveryPauseReason::None,
        }
    }
}

fn retry_delay(base: Duration, maximum: Duration, failures: u32, jitter: u64) -> Duration {
    let exponent = failures.saturating_sub(1).min(31);
    let ceiling = base.saturating_mul(1_u32 << exponent).min(maximum);
    let half = ceiling.checked_div(2).unwrap_or_default();
    let remaining_nanos =
        u64::try_from(ceiling.saturating_sub(half).as_nanos()).unwrap_or(u64::MAX);
    let jitter_nanos = remaining_nanos
        .checked_add(1)
        .and_then(|span| jitter.checked_rem(span))
        .unwrap_or(jitter);
    half.saturating_add(Duration::from_nanos(jitter_nanos))
}

fn rate_limit_delay(delay: Duration, jitter: u64) -> Duration {
    const MAX_RATE_LIMIT_DELAY: Duration = Duration::from_secs(3_600);
    let bounded = delay.clamp(Duration::from_secs(1), MAX_RATE_LIMIT_DELAY);
    let permille = u32::try_from(jitter.checked_rem(1_001).unwrap_or_default()).unwrap_or_default();
    let extra = bounded
        .checked_div(10)
        .and_then(|tenth| tenth.checked_mul(permille))
        .and_then(|scaled| scaled.checked_div(1_000))
        .unwrap_or_default();
    bounded.saturating_add(extra).min(MAX_RATE_LIMIT_DELAY)
}

fn jitter_seed() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.subsec_nanos().into())
}
