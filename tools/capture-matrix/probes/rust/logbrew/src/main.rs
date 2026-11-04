use std::collections::hash_map::RandomState;
use std::error::Error;
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::body::Body;
use axum::extract::MatchedPath;
use axum::http::{Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use logbrew::{
    AutomaticDeliveryConfig, HttpTransport, HttpTransportConfig, LogBrewClient,
    LogBrewTracingLayer, TelemetryContext, TelemetryDeployment, TelemetryNamedVersion,
    TelemetryResource, TelemetrySubjectContext, TowerRequestIds, TowerRequestTelemetryLayer,
    with_telemetry_context_async,
};
use tracing_subscriber::prelude::*;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let transport = HttpTransport::new(HttpTransportConfig {
        endpoint: std::env::var("LOGBREW_CAPTURE_ENDPOINT")?,
        ..HttpTransportConfig::default()
    })?;
    let client = Arc::new(Mutex::new(
        LogBrewClient::builder("checkout-api", "1.2.3")
            .api_key("LOGBREW_SERVER_API_KEY")
            .context(
                TelemetryContext::new().with_resource(
                    TelemetryResource::new()
                        .with_service(
                            TelemetryNamedVersion::new("checkout-api").with_version("1.2.3"),
                        )
                        .with_deployment(
                            TelemetryDeployment::new()
                                .with_environment("production")
                                .with_release("checkout@1.2.3"),
                        ),
                ),
            )
            .build_with_owned_transport(transport, AutomaticDeliveryConfig::default())?,
    ));
    let tracing_layer = LogBrewTracingLayer::new(Arc::clone(&client), now)
        .with_span_events()
        .with_error_issues()
        .with_logger("checkout-api");
    tracing::subscriber::set_global_default(tracing_subscriber::registry().with(tracing_layer))?;

    let logbrew_layer =
        TowerRequestTelemetryLayer::new(
            Arc::clone(&client),
            |request: &Request<Body>| {
                request.extensions().get::<MatchedPath>().map_or_else(
                    || request.uri().path().to_owned(),
                    |path| path.as_str().to_owned(),
                )
            },
            || {
                TowerRequestIds::new(
                    format!("{:016x}{:016x}", random(), random()),
                    format!("{:016x}", random()),
                )
            },
            now,
        )
        .with_context(TelemetryContext::new().with_resource(
            TelemetryResource::new().with_framework(TelemetryNamedVersion::new("axum")),
        ))
        .with_error_issues();
    let app = Router::new()
        .route("/checkout/{cart_id}", get(checkout))
        .route("/fail/{cart_id}", get(fail))
        .route_layer(middleware::from_fn(identify))
        .route_layer(logbrew_layer);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async { drop(stopped.await) })
            .await
    });
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        get_with_traceparent(address, "/checkout/cart-1")?;
        get_with_traceparent(address, "/fail/cart-2")
    })
    .await??;
    stop.send(()).ok();
    server.await??;

    let mut locked = client.lock().map_err(|_| "client lock poisoned")?;
    locked.shutdown_owned()?;
    Ok(())
}

async fn identify(request: Request<Body>, next: Next) -> Response {
    let user = TelemetryContext::new().with_subject(TelemetrySubjectContext::user("user_123"));
    match with_telemetry_context_async(user, next.run(request)) {
        Ok(scoped) => scoped
            .await
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn checkout() -> StatusCode {
    tracing::info!(target: "checkout", "checkout started");
    StatusCode::NO_CONTENT
}

async fn fail() -> Result<StatusCode, CheckoutError> {
    tracing::warn!(target: "checkout", "payment step failing");
    Err(CheckoutError)
}

struct CheckoutError;

impl IntoResponse for CheckoutError {
    fn into_response(self) -> Response {
        tracing::error!(target: "checkout", "payment declined");
        StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }
}

fn get_with_traceparent(address: SocketAddr, path: &str) -> std::io::Result<()> {
    let mut stream = TcpStream::connect(address)?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nhost: {address}\r\ntraceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01\r\nconnection: close\r\n\r\n"
    )?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    Ok(())
}

fn random() -> u64 {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u128(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
    );
    hasher.finish()
}

fn now() -> String {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let (days, seconds) = (
        (elapsed.as_secs() / 86_400) as i64,
        elapsed.as_secs() % 86_400,
    );
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        seconds / 3_600,
        seconds % 3_600 / 60,
        seconds % 60,
        elapsed.subsec_millis()
    )
}
