use super::*;

fn queue_with_two_events() -> DeliveryQueue {
    let mut queue = DeliveryQueue::new(2, 64);
    queue.push(br#"{"id":"first"}"#.to_vec()).unwrap();
    queue.push(br#"{"id":"second"}"#.to_vec()).unwrap();
    queue
}

#[test]
fn failed_prefix_serialization_keeps_the_queue_unchanged() {
    let queue = queue_with_two_events();
    let before_bytes = queue.event_bytes;

    let error = queue
        .freeze(2, b"{\"events\":[", 2, 8)
        .expect_err("the request limit should reject the prefix");

    assert_eq!(error.code, "serialization_error");
    assert_eq!(queue.len(), 2);
    assert_eq!(queue.event_bytes, before_bytes);
    assert_eq!(queue.events[0].bytes, br#"{"id":"first"}"#);
    assert_eq!(queue.events[1].bytes, br#"{"id":"second"}"#);
}

#[test]
fn failed_acknowledgement_keeps_the_queue_unchanged() {
    let mut queue = queue_with_two_events();
    let before_bytes = queue.event_bytes;
    let mismatched = FrozenPrefix {
        first_sequence: 1,
        last_sequence: 3,
        event_count: 2,
        body: Vec::new(),
    };

    let error = queue
        .acknowledge(&mismatched)
        .expect_err("a contradictory prefix should fail");

    assert_eq!(error.code, "queue_state_error");
    assert_eq!(queue.len(), 2);
    assert_eq!(queue.event_bytes, before_bytes);
    assert_eq!(queue.events[0].sequence, 1);
    assert_eq!(queue.events[1].sequence, 2);
}
