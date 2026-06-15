use axum::{
    Router,
    body::Body,
    extract::MatchedPath,
    http::{Request, StatusCode},
    response::IntoResponse,
    routing::post,
};
use logbrew::{
    LogBrewClient, Metadata, MetadataValue, RecordingTransport, TowerRequestIds,
    TowerRequestTelemetryLayer,
};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = LogBrewClient::builder("checkout-service", "1.2.3")
        .api_key("LOGBREW_API_KEY")
        .build()?;
    let client = Arc::new(Mutex::new(client));

    let mut metadata = Metadata::new();
    metadata.insert(
        "framework".to_string(),
        MetadataValue::String("axum".to_string()),
    );
    metadata.insert(
        "service".to_string(),
        MetadataValue::String("checkout-service".to_string()),
    );

    let logbrew_layer = TowerRequestTelemetryLayer::new(
        Arc::clone(&client),
        |request: &Request<Body>| {
            request
                .extensions()
                .get::<MatchedPath>()
                .map(|path| path.as_str().to_string())
                .unwrap_or_else(|| request.uri().path().to_string())
        },
        || TowerRequestIds::new("11111111111111111111111111111111", "b7ad6b7169203331"),
        || "2026-06-02T10:00:00Z".to_string(),
    )
    .with_metadata(metadata);

    let app = Router::new()
        .route("/checkout/{cart_id}", post(checkout))
        .route_layer(logbrew_layer);

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

    let mut client = client.lock().expect("client lock should not be poisoned");
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
