use logbrew::{
    DeliveryCodeCategory, DeliveryHealthSnapshot, DeliveryOutcome, LogBrewClient, LogEvent,
    RecordingTransport, SdkError, Transport, TransportError, TransportResponse,
};
use serde_json::Value;
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::thread;

const TIMESTAMP: &str = "2026-06-02T10:00:00Z";

fn client() -> LogBrewClient {
    LogBrewClient::builder("logbrew-rust", "0.1.1")
        .api_key("LOGBREW_API_KEY")
        .build()
        .expect("client should build")
}

fn queue_log(client: &mut LogBrewClient, id: &str, message: &str) -> Result<(), SdkError> {
    client.log(id, TIMESTAMP, LogEvent::new(message, "info"))
}

fn body_event_ids(body: &[u8]) -> Vec<String> {
    let payload: Value = serde_json::from_slice(body).expect("request body should be JSON");
    payload["events"]
        .as_array()
        .expect("events should be an array")
        .iter()
        .map(|event| {
            event["id"]
                .as_str()
                .expect("event id should be a string")
                .to_string()
        })
        .collect()
}

#[test]
fn builder_validates_all_delivery_limits() {
    for result in [
        LogBrewClient::builder("rust", "0.1.1")
            .api_key("key")
            .max_queue_events(0)
            .build(),
        LogBrewClient::builder("rust", "0.1.1")
            .api_key("key")
            .max_queue_bytes(0)
            .build(),
        LogBrewClient::builder("rust", "0.1.1")
            .api_key("key")
            .max_batch_events(0)
            .build(),
        LogBrewClient::builder("rust", "0.1.1")
            .api_key("key")
            .max_request_body_bytes(0)
            .build(),
    ] {
        let error = result.expect_err("invalid limits should fail");
        assert_eq!(error.code, "config_error");
    }

    let error = LogBrewClient::builder("x".repeat(512), "0.1.1")
        .api_key("key")
        .max_request_body_bytes(128)
        .build()
        .expect_err("SDK identity should obey the request body bound");
    assert_eq!(error.code, "config_error");
}

#[test]
fn admission_tracks_exact_compact_utf8_bytes_and_rejects_oversize_events() {
    let mut measured = client();
    queue_log(&mut measured, "evt_unicode", "café ☕").unwrap();
    let preview: Value = serde_json::from_str(&measured.preview_json().unwrap()).unwrap();
    let expected_event_bytes = serde_json::to_vec(&preview["events"][0]).unwrap().len();
    assert_eq!(
        measured.delivery_health().pending_event_bytes,
        expected_event_bytes
    );

    let mut measuring_transport = RecordingTransport::always_accept();
    measured.flush(&mut measuring_transport).unwrap();
    let exact_body_bytes = measuring_transport.last_body().unwrap().len();

    let mut exact = LogBrewClient::builder("logbrew-rust", "0.1.1")
        .api_key("key")
        .max_request_body_bytes(exact_body_bytes)
        .build()
        .unwrap();
    queue_log(&mut exact, "evt_unicode", "café ☕").unwrap();

    let mut too_small = LogBrewClient::builder("logbrew-rust", "0.1.1")
        .api_key("key")
        .max_request_body_bytes(exact_body_bytes - 1)
        .build()
        .unwrap();
    let error = queue_log(&mut too_small, "evt_unicode", "café ☕").unwrap_err();
    assert_eq!(error.code, "event_too_large");
    assert_eq!(too_small.pending_events(), 0);
    assert_eq!(too_small.delivery_health().dropped_events, 1);
    assert_eq!(
        too_small.delivery_health().last_code,
        DeliveryCodeCategory::EventTooLarge
    );
}

#[test]
fn admission_rejects_full_count_and_byte_queues_without_mutating_retained_work() {
    let mut count_limited = LogBrewClient::builder("rust", "0.1.1")
        .api_key("key")
        .max_queue_events(1)
        .build()
        .unwrap();
    queue_log(&mut count_limited, "evt_first", "first").unwrap();
    let error = queue_log(&mut count_limited, "evt_second", "second").unwrap_err();
    assert_eq!(error.code, "queue_full");
    assert_eq!(count_limited.pending_events(), 1);
    assert_eq!(count_limited.delivery_health().dropped_events, 1);

    let mut measured = client();
    queue_log(&mut measured, "evt_first", "first").unwrap();
    let exact_event_bytes = measured.delivery_health().pending_event_bytes;
    let mut byte_limited = LogBrewClient::builder("rust", "0.1.1")
        .api_key("key")
        .max_queue_bytes(exact_event_bytes)
        .build()
        .unwrap();
    queue_log(&mut byte_limited, "evt_first", "first").unwrap();
    let error = queue_log(&mut byte_limited, "evt_first", "first").unwrap_err();
    assert_eq!(error.code, "queue_full");
    assert_eq!(byte_limited.pending_events(), 1);
    assert_eq!(
        byte_limited.delivery_health().pending_event_bytes,
        exact_event_bytes
    );
}

#[test]
fn multi_batch_delivery_preserves_order_and_reports_honest_totals() {
    let mut client = LogBrewClient::builder("rust", "0.1.1")
        .api_key("key")
        .max_batch_events(2)
        .build()
        .unwrap();
    for index in 1..=5 {
        queue_log(&mut client, &format!("evt_{index}"), "queued").unwrap();
    }

    let mut transport = RecordingTransport::always_accept();
    let response = client.flush(&mut transport).unwrap();

    assert_eq!(response.status_code, 202);
    assert_eq!(response.attempts, 3);
    assert_eq!(response.batches, 3);
    assert_eq!(response.accepted_events, 5);
    assert_eq!(client.pending_events(), 0);
    assert_eq!(
        body_event_ids(&transport.sent_bodies()[0]),
        ["evt_1", "evt_2"]
    );
    assert_eq!(
        body_event_ids(&transport.sent_bodies()[1]),
        ["evt_3", "evt_4"]
    );
    assert_eq!(body_event_ids(&transport.sent_bodies()[2]), ["evt_5"]);
}

#[test]
fn exact_request_body_limit_splits_batches_without_exceeding_the_limit() {
    let mut measuring = LogBrewClient::builder("rust", "0.1.1")
        .api_key("key")
        .max_batch_events(2)
        .build()
        .unwrap();
    queue_log(&mut measuring, "evt_1", "same-size").unwrap();
    queue_log(&mut measuring, "evt_2", "same-size").unwrap();
    let mut measured_transport = RecordingTransport::always_accept();
    measuring.flush(&mut measured_transport).unwrap();
    let two_event_body_bytes = measured_transport.last_body().unwrap().len();

    let mut limited = LogBrewClient::builder("rust", "0.1.1")
        .api_key("key")
        .max_batch_events(10)
        .max_request_body_bytes(two_event_body_bytes)
        .build()
        .unwrap();
    for index in 1..=3 {
        queue_log(&mut limited, &format!("evt_{index}"), "same-size").unwrap();
    }
    let mut transport = RecordingTransport::always_accept();
    let response = limited.flush(&mut transport).unwrap();

    assert_eq!(response.batches, 2);
    assert_eq!(response.accepted_events, 3);
    assert!(
        transport
            .sent_bodies()
            .iter()
            .all(|body| body.len() <= two_event_body_bytes)
    );
    assert_eq!(
        body_event_ids(&transport.sent_bodies()[0]),
        ["evt_1", "evt_2"]
    );
    assert_eq!(body_event_ids(&transport.sent_bodies()[1]), ["evt_3"]);
}

#[test]
fn retry_and_next_flush_reuse_the_exact_failed_prefix_before_later_work() {
    let mut client = LogBrewClient::builder("rust", "0.1.1")
        .api_key("key")
        .max_retries(0)
        .max_batch_events(1)
        .build()
        .unwrap();
    queue_log(&mut client, "evt_first", "first").unwrap();

    let mut failed = RecordingTransport::scripted(vec![Err(TransportError::network("offline"))]);
    let error = client.flush(&mut failed).unwrap_err();
    assert_eq!(error.code, "network_failure");
    queue_log(&mut client, "evt_later", "later").unwrap();

    let mut recovered = RecordingTransport::scripted(vec![Ok(202), Ok(202)]);
    let response = client.flush(&mut recovered).unwrap();
    assert_eq!(response.attempts, 2);
    assert_eq!(response.batches, 2);
    assert_eq!(response.accepted_events, 2);
    assert_eq!(
        failed.last_body(),
        recovered.sent_bodies().first().map(Vec::as_slice)
    );
    assert_eq!(body_event_ids(&recovered.sent_bodies()[0]), ["evt_first"]);
    assert_eq!(body_event_ids(&recovered.sent_bodies()[1]), ["evt_later"]);
}

#[test]
fn accepted_prefix_is_removed_without_clearing_the_failed_batch_or_tail() {
    let mut client = LogBrewClient::builder("rust", "0.1.1")
        .api_key("key")
        .max_retries(0)
        .max_batch_events(1)
        .build()
        .unwrap();
    for index in 1..=3 {
        queue_log(&mut client, &format!("evt_{index}"), "queued").unwrap();
    }

    let mut partial = RecordingTransport::scripted(vec![Ok(202), Ok(503)]);
    let error = client.flush(&mut partial).unwrap_err();
    assert_eq!(error.code, "transport_error");
    assert_eq!(client.pending_events(), 2);
    let health = client.delivery_health();
    assert_eq!(health.attempts, 2);
    assert_eq!(health.batches, 1);
    assert_eq!(health.accepted_events, 1);
    assert_eq!(health.last_outcome, DeliveryOutcome::Failed);
    assert_eq!(health.last_code, DeliveryCodeCategory::Server);

    let failed_body = partial.sent_bodies()[1].clone();
    let mut recovered = RecordingTransport::always_accept();
    let response = client.flush(&mut recovered).unwrap();
    assert_eq!(response.accepted_events, 2);
    assert_eq!(recovered.sent_bodies()[0], failed_body);
    assert_eq!(body_event_ids(&recovered.sent_bodies()[0]), ["evt_2"]);
    assert_eq!(body_event_ids(&recovered.sent_bodies()[1]), ["evt_3"]);
}

struct BlockingTransport {
    observed: SyncSender<Vec<u8>>,
    release: Receiver<()>,
}

impl Transport for BlockingTransport {
    fn send(&mut self, _api_key: &str, body: &[u8]) -> Result<TransportResponse, TransportError> {
        self.observed
            .send(body.to_vec())
            .expect("test should observe request");
        self.release.recv().expect("test should release request");
        Ok(TransportResponse::new(202))
    }
}

#[test]
fn flush_snapshot_does_not_acknowledge_capture_during_transport_io() {
    let mut client = client();
    queue_log(&mut client, "evt_snapshot", "snapshot").unwrap();
    let mut flushing_client = client.clone();
    let (observed_sender, observed_receiver) = sync_channel(1);
    let (release_sender, release_receiver) = sync_channel(1);

    let handle = thread::spawn(move || {
        let mut transport = BlockingTransport {
            observed: observed_sender,
            release: release_receiver,
        };
        flushing_client.flush(&mut transport)
    });

    let sent_body = observed_receiver.recv().unwrap();
    queue_log(&mut client, "evt_during_io", "later").unwrap();
    release_sender.send(()).unwrap();
    let response = handle.join().unwrap().unwrap();

    assert_eq!(response.accepted_events, 1);
    assert_eq!(body_event_ids(&sent_body), ["evt_snapshot"]);
    assert_eq!(client.pending_events(), 1);
    assert!(client.preview_json().unwrap().contains("evt_during_io"));
}

#[test]
fn concurrent_flush_is_rejected_without_disturbing_the_active_snapshot() {
    let mut client = client();
    queue_log(&mut client, "evt_single_flight", "snapshot").unwrap();
    let mut flushing_client = client.clone();
    let (observed_sender, observed_receiver) = sync_channel(1);
    let (release_sender, release_receiver) = sync_channel(1);

    let handle = thread::spawn(move || {
        let mut transport = BlockingTransport {
            observed: observed_sender,
            release: release_receiver,
        };
        flushing_client.flush(&mut transport)
    });

    observed_receiver.recv().unwrap();
    let mut duplicate_transport = RecordingTransport::always_accept();
    let error = client.flush(&mut duplicate_transport).unwrap_err();
    assert_eq!(error.code, "queue_busy_error");
    assert!(duplicate_transport.sent_bodies().is_empty());

    release_sender.send(()).unwrap();
    assert_eq!(handle.join().unwrap().unwrap().accepted_events, 1);
    assert_eq!(client.pending_events(), 0);
}

#[test]
fn terminal_responses_keep_work_and_expose_only_fixed_health_categories() {
    for (status, expected_code) in [
        (401, DeliveryCodeCategory::Authentication),
        (429, DeliveryCodeCategory::Rejected),
    ] {
        let mut client = LogBrewClient::builder("rust", "0.1.1")
            .api_key("key")
            .max_retries(0)
            .build()
            .unwrap();
        queue_log(&mut client, "evt_retained", "retained").unwrap();
        let mut transport = RecordingTransport::scripted(vec![Ok(status)]);

        client.flush(&mut transport).unwrap_err();

        assert_eq!(client.pending_events(), 1);
        assert_eq!(client.delivery_health().last_code, expected_code);
        let health = format!("{:?}", client.delivery_health());
        assert!(!health.contains(&status.to_string()));
    }
}

#[test]
fn failed_shutdown_reopens_and_successful_shutdown_closes_after_snapshot_ack() {
    let mut client = LogBrewClient::builder("rust", "0.1.1")
        .api_key("key")
        .max_retries(0)
        .build()
        .unwrap();
    queue_log(&mut client, "evt_first", "first").unwrap();
    let mut failed = RecordingTransport::scripted(vec![Err(TransportError::network("offline"))]);
    let error = client.shutdown(&mut failed).unwrap_err();
    assert_eq!(error.code, "network_failure");
    assert!(!client.delivery_health().closed);
    queue_log(&mut client, "evt_after_failure", "second").unwrap();

    let mut accepted = RecordingTransport::always_accept();
    let response = client.shutdown(&mut accepted).unwrap();
    assert_eq!(response.accepted_events, 2);
    assert!(client.delivery_health().closed);
    let error = queue_log(&mut client, "evt_after_close", "closed").unwrap_err();
    assert_eq!(error.code, "shutdown_error");
}

#[test]
fn health_snapshot_is_fixed_and_content_free() {
    let fixture_value = "DO_NOT_EXPOSE_CALLER_MATERIAL";
    let mut client = LogBrewClient::builder("rust", "0.1.1")
        .api_key(fixture_value)
        .max_queue_events(1)
        .build()
        .unwrap();
    queue_log(
        &mut client,
        "evt_private_identifier",
        "private payload text",
    )
    .unwrap();
    queue_log(&mut client, "evt_drop", "drop").unwrap_err();

    let health: DeliveryHealthSnapshot = client.delivery_health();
    assert_eq!(health.pending_events, 1);
    assert!(health.pending_event_bytes > 0);
    assert_eq!(health.dropped_events, 1);
    assert!(!health.closed);
    assert_eq!(health.last_outcome, DeliveryOutcome::Dropped);
    assert_eq!(health.last_code, DeliveryCodeCategory::QueueFull);
    assert_eq!(health.attempts, 0);
    assert_eq!(health.batches, 0);
    assert_eq!(health.accepted_events, 0);

    let debug = format!("{health:?}");
    for forbidden in [
        fixture_value,
        "evt_private_identifier",
        "private payload text",
        "https://",
        "status_code",
        "headers",
    ] {
        assert!(!debug.contains(forbidden));
    }
}
