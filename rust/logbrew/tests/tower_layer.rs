#![cfg(feature = "tower")]

use axum::{
    body::Body,
    http::{Request, Response, StatusCode},
};
use logbrew::{
    LogBrewClient, TowerHttpClientSpanLayer, TowerRequestIds, TowerRequestTelemetryLayer,
};
use serde_json::Value;
use std::{
    convert::Infallible,
    sync::{Arc, Mutex},
};
use tower::{Layer, ServiceExt, service_fn};

fn sample_client() -> LogBrewClient {
    LogBrewClient::builder("logbrew-rust", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .max_retries(2)
        .build()
        .expect("client should build")
}

#[tokio::test]
async fn tower_http_client_span_layer_injects_traceparent_and_queues_span() {
    let client = Arc::new(Mutex::new(sample_client()));
    let mut metadata = serde_json::Map::new();
    metadata.insert("framework".to_string(), Value::String("tower".to_string()));
    metadata.insert(
        "service".to_string(),
        Value::String("payments-client".to_string()),
    );

    let layer = TowerHttpClientSpanLayer::new(
        Arc::clone(&client),
        |request: &Request<Body>| request.uri().path().replace("/123", "/:payment_id"),
        || {
            TowerRequestIds::new("4bf92f3577b34da6a3ce929d0e0e4736", "2222222222222222")
                .with_parent_span_id("00f067aa0ba902b7")
        },
        || "2026-06-02T10:00:11Z".to_string(),
    )
    .with_metadata(metadata)
    .with_event_id_prefix("evt_tower_http_client_span");

    let service = service_fn(|request: Request<Body>| async move {
        assert_eq!(
            request
                .headers()
                .get("traceparent")
                .and_then(|value| value.to_str().ok()),
            Some("00-4bf92f3577b34da6a3ce929d0e0e4736-2222222222222222-01")
        );
        Ok::<_, Infallible>(
            Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(Body::empty())
                .unwrap(),
        )
    });

    let request = Request::builder()
        .method("post")
        .uri("/payments/123?coupon=sample#debug")
        .body(Body::empty())
        .unwrap();
    let response = layer.layer(service).oneshot(request).await.unwrap();

    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let client = client.lock().unwrap();
    let payload: Value = serde_json::from_str(&client.preview_json().unwrap()).unwrap();
    let events = payload["events"].as_array().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["type"], "span");
    let span = &events[0]["attributes"];
    assert_eq!(span["name"], "http.client:POST /payments/:payment_id");
    assert_eq!(span["traceId"], "4bf92f3577b34da6a3ce929d0e0e4736");
    assert_eq!(span["parentSpanId"], "00f067aa0ba902b7");
    assert_eq!(span["spanId"], "2222222222222222");
    assert_eq!(span["status"], "error");
    assert_eq!(span["metadata"]["source"], "rust_http_client");
    assert_eq!(span["metadata"]["routeTemplate"], "/payments/:payment_id");
    assert_eq!(span["metadata"]["method"], "POST");
    assert_eq!(span["metadata"]["statusCode"], 502);
    assert_eq!(span["metadata"]["statusCodeClass"], "5xx");
    assert_eq!(span["metadata"]["framework"], "tower");
    let text = payload.to_string().to_ascii_lowercase();
    assert!(!text.contains("coupon=sample"));
    assert!(!text.contains("payments/123"));
    assert!(!text.contains("headers"));
    assert!(!text.contains("payload"));
}

#[tokio::test]
async fn tower_request_telemetry_layer_queues_span_and_metric() {
    let client = Arc::new(Mutex::new(sample_client()));
    let mut metadata = serde_json::Map::new();
    metadata.insert("framework".to_string(), Value::String("tower".to_string()));
    metadata.insert(
        "service".to_string(),
        Value::String("checkout-service".to_string()),
    );

    let layer = TowerRequestTelemetryLayer::new(
        Arc::clone(&client),
        |request: &Request<Body>| {
            request
                .extensions()
                .get::<String>()
                .cloned()
                .unwrap_or_else(|| request.uri().path().to_string())
        },
        || TowerRequestIds::new("11111111111111111111111111111111", "b7ad6b7169203331"),
        || "2026-06-02T10:00:00Z".to_string(),
    )
    .with_metadata(metadata);

    let service = service_fn(|_request: Request<Body>| async {
        Ok::<_, Infallible>(
            Response::builder()
                .status(StatusCode::ACCEPTED)
                .body(Body::empty())
                .unwrap(),
        )
    });
    let mut request = Request::builder()
        .method("post")
        .uri("/checkout/cart_123?coupon=sample")
        .header(
            "traceparent",
            "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
        )
        .body(Body::empty())
        .unwrap();
    request
        .extensions_mut()
        .insert("/checkout/{cart_id}".to_string());

    let response = layer.layer(service).oneshot(request).await.unwrap();

    assert_eq!(response.status(), StatusCode::ACCEPTED);
    assert_eq!(
        response
            .headers()
            .get("traceparent")
            .and_then(|value| value.to_str().ok()),
        Some("00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01")
    );

    let client = client.lock().unwrap();
    let payload: Value = serde_json::from_str(&client.preview_json().unwrap()).unwrap();
    let events = payload["events"].as_array().unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["type"], "span");
    assert_eq!(events[1]["type"], "metric");
    let span = &events[0]["attributes"];
    let metric = &events[1]["attributes"];
    assert_eq!(span["name"], "POST /checkout/{cart_id}");
    assert_eq!(span["traceId"], "4bf92f3577b34da6a3ce929d0e0e4736");
    assert_eq!(span["parentSpanId"], "00f067aa0ba902b7");
    assert_eq!(span["spanId"], "b7ad6b7169203331");
    assert_eq!(span["metadata"]["routeTemplate"], "/checkout/{cart_id}");
    assert_eq!(span["metadata"]["method"], "POST");
    assert_eq!(span["metadata"]["statusCode"], 202);
    assert_eq!(span["metadata"]["statusCodeClass"], "2xx");
    assert_eq!(span["metadata"]["framework"], "tower");
    assert_eq!(metric["name"], "http.server.duration");
    assert_eq!(metric["metadata"], span["metadata"]);
    let text = payload.to_string().to_ascii_lowercase();
    assert!(!text.contains("coupon=sample"));
    assert!(!text.contains("cart_123"));
    assert!(!text.contains("headers"));
    assert!(!text.contains("payload"));
}
