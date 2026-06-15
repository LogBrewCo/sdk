use axum::{
    Router,
    body::Body,
    extract::{MatchedPath, State},
    http::{HeaderValue, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::post,
};
use logbrew::{HttpRequestTelemetry, LogBrewClient, Metadata, MetadataValue, RecordingTransport};
use std::{
    sync::{Arc, Mutex},
    time::Instant,
};
use tower::ServiceExt;

#[derive(Clone)]
struct AppState {
    client: Arc<Mutex<LogBrewClient>>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = LogBrewClient::builder("checkout-service", "1.2.3")
        .api_key("LOGBREW_API_KEY")
        .build()?;
    let state = AppState {
        client: Arc::new(Mutex::new(client)),
    };

    let app = Router::new()
        .route("/checkout/{cart_id}", post(checkout))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            logbrew_middleware,
        ));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/checkout/cart_123?coupon=sample")
                .header(
                    "traceparent",
                    "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
                )
                .body(Body::empty())?,
        )
        .await?;

    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let response_traceparent = response
        .headers()
        .get("traceparent")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();

    let mut client = state
        .client
        .lock()
        .expect("client lock should not be poisoned");
    println!("{}", client.preview_json()?);

    let mut transport = RecordingTransport::always_accept();
    let delivery = client.shutdown(&mut transport)?;
    eprintln!(
        "{{\"ok\":true,\"status\":{},\"attempts\":{},\"events\":2,\"responseTraceparent\":\"{}\"}}",
        delivery.status_code, delivery.attempts, response_traceparent
    );
    Ok(())
}

async fn checkout() -> impl IntoResponse {
    (StatusCode::ACCEPTED, "accepted")
}

async fn logbrew_middleware(
    State(state): State<AppState>,
    matched_path: Option<MatchedPath>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let started = Instant::now();
    let method = request.method().as_str().to_string();
    let incoming_traceparent = request
        .headers()
        .get("traceparent")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let route_template = matched_path
        .map(|path| path.as_str().to_string())
        .unwrap_or_else(|| request.uri().path().to_string());

    let mut response = next.run(request).await;
    let duration_ms = started.elapsed().as_secs_f64() * 1000.0;

    let mut metadata = Metadata::new();
    metadata.insert(
        "framework".to_string(),
        MetadataValue::String("axum".to_string()),
    );
    metadata.insert(
        "service".to_string(),
        MetadataValue::String("checkout-service".to_string()),
    );

    let mut request_telemetry = HttpRequestTelemetry::new(
        route_template,
        method,
        "11111111111111111111111111111111",
        "b7ad6b7169203331",
    )
    .with_status_code(response.status().as_u16())
    .with_duration_ms(duration_ms)
    .with_metadata(metadata);
    if let Some(traceparent) = incoming_traceparent {
        request_telemetry = request_telemetry.with_incoming_traceparent(traceparent);
    }

    let events = request_telemetry
        .build()
        .expect("request telemetry should build from Axum metadata");
    response.headers_mut().insert(
        "traceparent",
        HeaderValue::from_str(&events.outgoing_traceparent)
            .expect("outgoing traceparent should be a valid header value"),
    );

    let mut client = state
        .client
        .lock()
        .expect("client lock should not be poisoned");
    client
        .span("evt_axum_request_span", "2026-06-02T10:00:00Z", events.span)
        .expect("request span should queue");
    if let Some(metric) = events.metric {
        client
            .metric("evt_axum_request_duration", "2026-06-02T10:00:00Z", metric)
            .expect("request metric should queue");
    }

    response
}
