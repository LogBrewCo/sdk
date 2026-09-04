#![cfg(feature = "tower")]

use axum::{
    body::Body,
    http::{Request, Response, StatusCode},
};
use logbrew::{
    LogBrewClient, LogEvent, TelemetryContext, TelemetryNamedVersion, TelemetryResource,
    TowerHttpClientSpanLayer, TowerRequestIds, TowerRequestTelemetryLayer,
    current_telemetry_context,
};
use serde_json::Value;
use std::{
    convert::Infallible,
    error::Error,
    fmt,
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

fn request_layer(
    client: Arc<Mutex<LogBrewClient>>,
) -> TowerRequestTelemetryLayer<
    impl Fn(&Request<Body>) -> String + Clone,
    impl Fn() -> TowerRequestIds + Clone,
    impl Fn() -> String + Clone,
> {
    TowerRequestTelemetryLayer::new(
        client,
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
    .with_context(TelemetryContext::new().with_resource(
        TelemetryResource::new().with_service(TelemetryNamedVersion::new("checkout-service")),
    ))
}

fn checkout_request(query: &str) -> Request<Body> {
    let mut request = Request::builder()
        .method("post")
        .uri(query)
        .header(
            "traceparent",
            "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
        )
        .body(Body::empty())
        .unwrap();
    request
        .extensions_mut()
        .insert("/checkout/{cart_id}".to_string());
    request
}

fn preview(client: &Arc<Mutex<LogBrewClient>>) -> Value {
    serde_json::from_str(&client.lock().unwrap().preview_json().unwrap()).unwrap()
}

fn assert_omits(payload: &Value, values: &[&str]) {
    let text = payload.to_string().to_ascii_lowercase();
    for value in values {
        assert!(!text.contains(value), "payload contained {value}");
    }
}

#[derive(Debug, PartialEq, Eq)]
struct CheckoutFailure;

impl fmt::Display for CheckoutFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("private tower service error text")
    }
}

impl Error for CheckoutFailure {}

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
    .with_context(TelemetryContext::new().with_resource(
        TelemetryResource::new().with_service(TelemetryNamedVersion::new("payments-client")),
    ))
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
    let payload = preview(&client);
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
    assert_eq!(span["context"]["resource"]["framework"]["name"], "tower");
    assert_eq!(
        span["context"]["resource"]["service"]["name"],
        "payments-client"
    );
    assert_eq!(span["context"]["trace"]["traceId"], span["traceId"]);
    assert_eq!(span["context"]["trace"]["spanId"], span["spanId"]);
    assert_eq!(span["context"]["trace"]["sampled"], true);
    assert_omits(
        &payload,
        &["coupon=sample", "payments/123", "headers", "payload"],
    );
}

#[tokio::test]
async fn tower_request_layer_scopes_handler_logs_and_queues_span_and_metric() {
    let client = Arc::new(Mutex::new(sample_client()));
    let mut metadata = serde_json::Map::new();
    metadata.insert("framework".to_string(), Value::String("tower".to_string()));
    metadata.insert(
        "service".to_string(),
        Value::String("checkout-service".to_string()),
    );

    let layer = request_layer(Arc::clone(&client)).with_metadata(metadata);

    let handler_client = Arc::clone(&client);
    let service = service_fn(move |_request: Request<Body>| {
        let handler_client = Arc::clone(&handler_client);
        async move {
            tokio::task::yield_now().await;
            handler_client
                .lock()
                .unwrap()
                .log(
                    "evt_tower_handler_log",
                    "2026-06-02T10:00:01Z",
                    LogEvent::new("request completed", "info"),
                )
                .unwrap();
            Ok::<_, Infallible>(
                Response::builder()
                    .status(StatusCode::ACCEPTED)
                    .body(Body::empty())
                    .unwrap(),
            )
        }
    });
    let response = layer
        .layer(service)
        .oneshot(checkout_request("/checkout/cart_123?coupon=sample"))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::ACCEPTED);
    assert!(current_telemetry_context().is_none());
    assert_eq!(
        response
            .headers()
            .get("traceparent")
            .and_then(|value| value.to_str().ok()),
        Some("00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01")
    );

    let payload = preview(&client);
    let events = payload["events"].as_array().unwrap();
    assert_eq!(events.len(), 3);
    assert_eq!(events[0]["type"], "log");
    assert_eq!(events[1]["type"], "span");
    assert_eq!(events[2]["type"], "metric");
    let log = &events[0]["attributes"];
    assert_eq!(
        log["context"]["trace"]["traceId"],
        "4bf92f3577b34da6a3ce929d0e0e4736"
    );
    assert_eq!(log["context"]["trace"]["spanId"], "b7ad6b7169203331");
    let span = &events[1]["attributes"];
    let metric = &events[2]["attributes"];
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
    assert_eq!(
        metric["description"],
        "Duration of one completed server request."
    );
    assert_eq!(metric["metadata"], span["metadata"]);
    assert_eq!(span["context"], metric["context"]);
    assert_eq!(span["context"]["resource"]["framework"]["name"], "tower");
    assert_eq!(
        span["context"]["resource"]["service"]["name"],
        "checkout-service"
    );
    assert_eq!(span["context"]["trace"]["traceId"], span["traceId"]);
    assert_eq!(span["context"]["trace"]["spanId"], span["spanId"]);
    assert_eq!(
        span["context"]["trace"]["parentSpanId"],
        span["parentSpanId"]
    );
    assert_omits(
        &payload,
        &["coupon=sample", "cart_123", "headers", "payload"],
    );
}

#[tokio::test]
async fn tower_request_error_capture_queues_correlated_issue_and_preserves_error() {
    let client = Arc::new(Mutex::new(sample_client()));
    let layer = request_layer(Arc::clone(&client))
        .with_error_issues()
        .with_error_issue_event_id_prefix("evt_tower_request_issue");

    let service = service_fn(|_request: Request<Body>| async {
        Err::<Response<Body>, CheckoutFailure>(CheckoutFailure)
    });
    let error = layer
        .layer(service)
        .oneshot(checkout_request(
            "/checkout/cart_123?coupon=not-for-telemetry",
        ))
        .await
        .unwrap_err();
    assert_eq!(error, CheckoutFailure);

    let payload = preview(&client);
    let events = payload["events"].as_array().unwrap();
    assert_eq!(events.len(), 3);
    assert_eq!(events[0]["type"], "span");
    assert_eq!(events[1]["type"], "metric");
    assert_eq!(events[2]["type"], "issue");
    assert_eq!(events[2]["id"], "evt_tower_request_issue_b7ad6b7169203331");

    let span = &events[0]["attributes"];
    assert_eq!(span["status"], "error");
    assert_eq!(span["traceId"], "4bf92f3577b34da6a3ce929d0e0e4736");
    assert_eq!(span["parentSpanId"], "00f067aa0ba902b7");
    assert_eq!(span["spanId"], "b7ad6b7169203331");
    assert!(
        span["metadata"]["exception.type"]
            .as_str()
            .unwrap()
            .ends_with("CheckoutFailure")
    );

    let issue = &events[2]["attributes"];
    let exception_type = issue["exception"]["type"].as_str().unwrap();
    assert!(exception_type.ends_with("CheckoutFailure"));
    assert_eq!(issue["title"], exception_type);
    assert_eq!(issue["exception"]["mechanism"]["type"], "tower.service");
    assert_eq!(issue["exception"]["mechanism"]["handled"], false);
    assert_eq!(issue["metadata"]["traceId"], span["traceId"]);
    assert_eq!(issue["metadata"]["spanId"], span["spanId"]);
    assert_eq!(issue["context"]["trace"]["traceId"], span["traceId"]);
    assert_eq!(issue["context"]["trace"]["spanId"], span["spanId"]);
    assert_eq!(
        issue["context"]["trace"]["parentSpanId"],
        span["parentSpanId"]
    );
    assert_eq!(issue["context"]["trace"]["sampled"], true);
    assert_eq!(issue["context"]["resource"]["framework"]["name"], "tower");
    assert_eq!(
        issue["context"]["resource"]["service"]["name"],
        "checkout-service"
    );
    assert_eq!(issue["metadata"]["routeTemplate"], "/checkout/{cart_id}");
    assert_eq!(issue["metadata"]["method"], "POST");
    assert_eq!(
        issue["metadata"]["issueGroupingSource"],
        "error_type_and_route"
    );
    assert_eq!(issue["metadata"]["issueEvidenceCompleteness"], "partial");
    assert_eq!(issue["metadata"]["issueMissingEvidence"], "stackFrames");
    assert_eq!(
        issue["metadata"]["issueRedactedEvidence"],
        "exception.message,stack.text,request.values"
    );
    assert_eq!(issue["breadcrumbs"].as_array().unwrap().len(), 1);
    assert_eq!(issue["breadcrumbs"][0]["category"], "http.request");
    assert_eq!(
        issue["breadcrumbs"][0]["data"]["routeTemplate"],
        "/checkout/{cart_id}"
    );

    assert_omits(
        &payload,
        &[
            "private tower service error text",
            "cart_123",
            "coupon=not-for-telemetry",
            "traceparent",
        ],
    );
}
