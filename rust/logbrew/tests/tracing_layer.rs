#![cfg(feature = "tracing")]

use logbrew::{LogBrewClient, LogBrewTracingLayer};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tracing_subscriber::prelude::*;

fn sample_client() -> LogBrewClient {
    LogBrewClient::builder("logbrew-rust", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .max_retries(2)
        .build()
        .expect("client should build")
}

#[test]
fn tracing_layer_queues_allowed_log_fields() {
    let client = Arc::new(Mutex::new(sample_client()));
    let layer =
        LogBrewTracingLayer::new(Arc::clone(&client), || "2026-06-02T10:00:00Z".to_string())
            .with_allowed_fields(["routeTemplate", "statusCode", "sampled", "unsafeDebug"]);
    let subscriber = tracing_subscriber::registry().with(layer);

    tracing::subscriber::with_default(subscriber, || {
        tracing::info!(
            target: "checkout",
            routeTemplate = "/checkout/{cart_id}?coupon=sample#review",
            statusCode = 202_u64,
            sampled = true,
            unsafeDebug = ?vec!["debug-value"],
            authorization = "Bearer sample",
            requestBody = "card=sample",
            "checkout tracing event accepted"
        );
    });

    let client = client.lock().unwrap();
    let payload: Value = serde_json::from_str(&client.preview_json().unwrap()).unwrap();
    let events = payload["events"].as_array().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["type"], "log");
    assert_eq!(events[0]["timestamp"], "2026-06-02T10:00:00Z");
    assert_eq!(
        events[0]["attributes"]["message"],
        "checkout tracing event accepted"
    );
    assert_eq!(events[0]["attributes"]["level"], "info");
    assert_eq!(events[0]["attributes"]["logger"], "checkout");
    let metadata = &events[0]["attributes"]["metadata"];
    assert_eq!(metadata["routeTemplate"], "/checkout/{cart_id}");
    assert_eq!(metadata["statusCode"], 202);
    assert_eq!(metadata["sampled"], true);
    assert_eq!(metadata["tracingTarget"], "checkout");
    assert_eq!(metadata["tracingLevel"], "INFO");
    assert!(metadata.get("unsafeDebug").is_none());
    assert!(metadata.get("authorization").is_none());
    assert!(metadata.get("requestBody").is_none());
    let text = payload.to_string().to_ascii_lowercase();
    assert!(!text.contains("coupon=sample"));
    assert!(!text.contains("bearer sample"));
    assert!(!text.contains("card=sample"));
    assert!(!text.contains("debug-value"));
}

#[test]
fn tracing_layer_normalizes_warning_and_debug_levels() {
    let client = Arc::new(Mutex::new(sample_client()));
    let layer =
        LogBrewTracingLayer::new(Arc::clone(&client), || "2026-06-02T10:00:00Z".to_string());
    let subscriber = tracing_subscriber::registry().with(layer);

    tracing::subscriber::with_default(subscriber, || {
        tracing::debug!(target: "worker", "debug event");
        tracing::warn!(target: "worker", "warning event");
    });

    let client = client.lock().unwrap();
    let payload: Value = serde_json::from_str(&client.preview_json().unwrap()).unwrap();
    let events = payload["events"].as_array().unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["attributes"]["level"], "info");
    assert_eq!(events[1]["attributes"]["level"], "warning");
    assert!(events[0]["attributes"]["metadata"].get("message").is_none());
}
