//! Example: Axum request middleware built on the Tower layer.
extern crate alloc;
use alloc::sync::Arc;
use axum::{
    Router,
    body::Body,
    extract::MatchedPath,
    http::{Request, StatusCode},
    response::IntoResponse,
    routing::post,
};
use core::error::Error;
use logbrew::{
    LogBrewClient, RecordingTransport, TelemetryContext, TelemetryNamedVersion, TelemetryResource,
    TowerRequestIds, TowerRequestTelemetryLayer,
};
use std::io::{self, Write as _};
use std::sync::Mutex;
use tower::ServiceExt as _;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let client = Arc::new(Mutex::new(
        LogBrewClient::builder("checkout-service", "1.2.3")
            .api_key("LOGBREW_API_KEY")
            .build()?,
    ));

    let logbrew_layer = TowerRequestTelemetryLayer::new(
        Arc::clone(&client),
        |request: &Request<Body>| {
            request.extensions().get::<MatchedPath>().map_or_else(
                || request.uri().path().to_owned(),
                |path| path.as_str().to_owned(),
            )
        },
        || TowerRequestIds::new("11111111111111111111111111111111", "b7ad6b7169203331"),
        || "2026-06-02T10:00:00Z".to_owned(),
    )
    .with_context(
        TelemetryContext::new().with_resource(
            TelemetryResource::new()
                .with_service(TelemetryNamedVersion::new("checkout-service").with_version("1.2.3"))
                .with_framework(TelemetryNamedVersion::new("axum")),
        ),
    )
    .with_error_issues();

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

    if response.status() != StatusCode::ACCEPTED {
        return Err("checkout should return 202 Accepted".into());
    }
    let response_traceparent = response
        .headers()
        .get("traceparent")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();

    let mut locked = client
        .lock()
        .map_err(|_error| "client lock should not be poisoned")?;
    writeln!(io::stdout(), "{}", locked.preview_json()?)?;

    let mut transport = RecordingTransport::always_accept();
    let delivery = locked.shutdown(&mut transport)?;
    drop(locked);
    writeln!(
        io::stderr(),
        "{{\"ok\":true,\"status\":{},\"attempts\":{},\"events\":2,\"responseTraceparent\":\"{}\"}}",
        delivery.status_code,
        delivery.attempts,
        response_traceparent
    )?;
    Ok(())
}

async fn checkout() -> impl IntoResponse {
    (StatusCode::ACCEPTED, "accepted")
}
