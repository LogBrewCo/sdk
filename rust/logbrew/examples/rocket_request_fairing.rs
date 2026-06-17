use logbrew::{HttpRequestTelemetry, LogBrewClient, Metadata, MetadataValue, RecordingTransport};
use rocket::{
    Config, Data, Request, Response,
    config::LogLevel,
    fairing::AdHoc,
    http::{Header, Status},
    local::asynchronous::Client as RocketClient,
    post, routes,
};
use std::{
    sync::{Arc, Mutex},
    time::Instant,
};

#[derive(Clone)]
struct AppState {
    client: Arc<Mutex<LogBrewClient>>,
}

#[rocket::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = LogBrewClient::builder("checkout-service", "1.2.3")
        .api_key("LOGBREW_API_KEY")
        .build()?;
    let client = Arc::new(Mutex::new(client));
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
    .mount("/", routes![checkout]);
    let local = RocketClient::tracked(rocket).await?;
    let response = local
        .post("/checkout/cart_123?coupon=sample")
        .header(Header::new(
            "traceparent",
            "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
        ))
        .dispatch()
        .await;

    assert_eq!(response.status(), Status::Accepted);
    let response_traceparent = response
        .headers()
        .get_one("traceparent")
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

fn logbrew_request_timer() -> AdHoc {
    AdHoc::on_request(
        "LogBrew request timer",
        |request: &mut Request<'_>, _data: &Data<'_>| {
            Box::pin(async move {
                let _ = request.local_cache(Instant::now);
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
                    .map(|route| route.uri.to_string())
                    .unwrap_or_else(|| "/unknown".to_string());
                let mut metadata = Metadata::new();
                metadata.insert(
                    "framework".to_string(),
                    MetadataValue::String("rocket".to_string()),
                );
                metadata.insert(
                    "service".to_string(),
                    MetadataValue::String("checkout-service".to_string()),
                );

                let mut telemetry = HttpRequestTelemetry::new(
                    route_template,
                    request.method().to_string(),
                    "11111111111111111111111111111111",
                    "b7ad6b7169203331",
                )
                .with_status_code(response.status().code)
                .with_duration_ms(started.elapsed().as_secs_f64() * 1000.0)
                .with_metadata(metadata);
                if let Some(traceparent) = request.headers().get_one("traceparent") {
                    telemetry = telemetry.with_incoming_traceparent(traceparent);
                }

                let Ok(events) = telemetry.build() else {
                    return;
                };
                response.set_header(Header::new(
                    "traceparent",
                    events.outgoing_traceparent.clone(),
                ));
                if let Ok(mut client) = app_state.client.lock() {
                    let _ = client.span(
                        format!("evt_rocket_request_span_{}", events.span_id),
                        "2026-06-02T10:00:00Z",
                        events.span,
                    );
                    if let Some(metric) = events.metric {
                        let _ = client.metric(
                            format!("evt_rocket_request_duration_{}", events.span_id),
                            "2026-06-02T10:00:00Z",
                            metric,
                        );
                    }
                }
            })
        },
    )
}

#[post("/checkout/<cart_id>")]
async fn checkout(cart_id: &str) -> Status {
    if cart_id.is_empty() {
        Status::BadRequest
    } else {
        Status::Accepted
    }
}
