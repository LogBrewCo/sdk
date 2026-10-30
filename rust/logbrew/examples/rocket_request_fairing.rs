//! Example: Rocket request fairing that records request spans.
extern crate alloc;
use alloc::sync::Arc;
use core::error::Error;
use logbrew::{
    HttpRequestTelemetry, LogBrewClient, RecordingTransport, TelemetryContext,
    TelemetryNamedVersion, TelemetryResource,
};
use rocket::{
    Config, Data, Request, Response, Route,
    config::LogLevel,
    fairing::AdHoc,
    http::{Header, Method, Status},
    local::asynchronous::Client as RocketClient,
    route::{BoxFuture, Outcome},
};
use std::io::{self, Write as _};
use std::sync::Mutex;
use std::time::Instant;

#[derive(Clone)]
struct AppState {
    client: Arc<Mutex<LogBrewClient>>,
}

#[rocket::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let client = Arc::new(Mutex::new(
        LogBrewClient::builder("checkout-service", "1.2.3")
            .api_key("LOGBREW_API_KEY")
            .build()?,
    ));
    let app_state = AppState {
        client: Arc::clone(&client),
    };

    let rocket = rocket::custom(Config {
        log_level: LogLevel::Off,
        ..Config::debug_default()
    })
    .manage(app_state)
    .attach(logbrew_request_timer())
    .attach(logbrew_request_telemetry())
    .mount(
        "/",
        vec![Route::new(Method::Post, "/checkout/<cart_id>", checkout)],
    );
    let local = RocketClient::tracked(rocket).await?;
    let response = local
        .post("/checkout/cart_123?coupon=sample")
        .header(Header::new(
            "traceparent",
            "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
        ))
        .dispatch()
        .await;

    if response.status() != Status::Accepted {
        return Err("checkout should return 202 Accepted".into());
    }
    let response_traceparent = response
        .headers()
        .get_one("traceparent")
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

fn logbrew_request_timer() -> AdHoc {
    AdHoc::on_request(
        "LogBrew request timer",
        |request: &mut Request<'_>, _data: &Data<'_>| {
            Box::pin(async move {
                let _started = request.local_cache(Instant::now);
            })
        },
    )
}

fn logbrew_request_telemetry() -> AdHoc {
    AdHoc::on_response(
        "LogBrew request telemetry",
        |request: &Request<'_>, response: &mut Response<'_>| {
            Box::pin(async move {
                let started = *request.local_cache(Instant::now);
                let Some(app_state) = request.rocket().state::<AppState>() else {
                    return;
                };
                let route_template = request
                    .route()
                    .map_or_else(|| "/unknown".to_owned(), |route| route.uri.to_string());
                let mut telemetry = HttpRequestTelemetry::new(
                    route_template,
                    request.method().to_string(),
                    "11111111111111111111111111111111",
                    "b7ad6b7169203331",
                )
                .with_status_code(response.status().code)
                .with_duration_ms(
                    started
                        .elapsed()
                        .checked_mul(1_000)
                        .map_or(f64::MAX, |scaled| scaled.as_secs_f64()),
                )
                .with_context(
                    TelemetryContext::new().with_resource(
                        TelemetryResource::new()
                            .with_service(
                                TelemetryNamedVersion::new("checkout-service")
                                    .with_version("1.2.3"),
                            )
                            .with_framework(TelemetryNamedVersion::new("rocket")),
                    ),
                );
                if let Some(traceparent) = request.headers().get_one("traceparent") {
                    telemetry = telemetry.with_incoming_traceparent(traceparent);
                }

                let Ok(events) = telemetry.build() else {
                    return;
                };
                let _replaced = response.set_header(Header::new(
                    "traceparent",
                    events.outgoing_traceparent.clone(),
                ));
                if let Ok(mut client) = app_state.client.lock() {
                    drop(client.span(
                        format!("evt_rocket_request_span_{}", events.span_id),
                        "2026-06-02T10:00:00Z",
                        events.span,
                    ));
                    if let Some(metric) = events.metric {
                        drop(client.metric(
                            format!("evt_rocket_request_duration_{}", events.span_id),
                            "2026-06-02T10:00:00Z",
                            metric,
                        ));
                    }
                }
            })
        },
    )
}

fn checkout<'request>(
    request: &'request Request<'_>,
    _data: Data<'request>,
) -> BoxFuture<'request> {
    Outcome::from(request, Status::Accepted).pin()
}
