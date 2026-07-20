use super::*;

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
