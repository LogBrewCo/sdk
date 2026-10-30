//! Example: Actix Web request middleware that records request spans.
extern crate alloc;
use actix_web::{
    App, HttpResponse,
    body::MessageBody,
    dev::{ServiceRequest, ServiceResponse},
    http::StatusCode,
    http::header::{HeaderName, HeaderValue},
    middleware::{Next, from_fn},
    test, web,
};
use alloc::sync::Arc;
use core::error::Error;
use core::pin::Pin;
use logbrew::{
    HttpRequestTelemetry, LogBrewClient, RecordingTransport, TelemetryContext,
    TelemetryNamedVersion, TelemetryResource,
};
use std::io::{self, Write as _};
use std::sync::Mutex;
use std::time::Instant;

type MiddlewareFuture<B> =
    Pin<Box<dyn Future<Output = Result<ServiceResponse<B>, actix_web::Error>>>>;

#[derive(Clone)]
struct AppState {
    client: Arc<Mutex<LogBrewClient>>,
}

#[actix_web::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let client = Arc::new(Mutex::new(
        LogBrewClient::builder("checkout-service", "1.2.3")
            .api_key("LOGBREW_API_KEY")
            .build()?,
    ));
    let app_state = AppState {
        client: Arc::clone(&client),
    };

    let app = test::init_service(
        App::new()
            .app_data(web::Data::new(app_state))
            .wrap(from_fn(logbrew_request_telemetry))
            .route("/checkout/{cart_id}", web::post().to(checkout)),
    )
    .await;

    let request = test::TestRequest::post()
        .uri("/checkout/cart_123?coupon=sample")
        .insert_header((
            "traceparent",
            "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
        ))
        .to_request();
    let response = test::call_service(&app, request).await;
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

fn logbrew_request_telemetry<B>(request: ServiceRequest, next: Next<B>) -> MiddlewareFuture<B>
where
    B: MessageBody + 'static,
{
    Box::pin(async move {
        let started = Instant::now();
        let method = request.method().as_str().to_owned();
        let incoming_traceparent = request
            .headers()
            .get("traceparent")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let state = request
            .app_data::<web::Data<AppState>>()
            .map(|data| data.get_ref().clone());

        let mut response = next.call(request).await?;
        let Some(app_state) = state else {
            return Ok(response);
        };

        let route_template = response
            .request()
            .match_pattern()
            .unwrap_or_else(|| "/unknown".to_owned());
        let status_code = response.status().as_u16();
        let duration_ms = started
            .elapsed()
            .checked_mul(1_000)
            .map_or(f64::MAX, |scaled| scaled.as_secs_f64());

        let mut telemetry = HttpRequestTelemetry::new(
            route_template,
            method,
            "11111111111111111111111111111111",
            "b7ad6b7169203331",
        )
        .with_status_code(status_code)
        .with_duration_ms(duration_ms)
        .with_context(
            TelemetryContext::new().with_resource(
                TelemetryResource::new()
                    .with_service(
                        TelemetryNamedVersion::new("checkout-service").with_version("1.2.3"),
                    )
                    .with_framework(TelemetryNamedVersion::new("actix-web")),
            ),
        );
        if let Some(traceparent) = incoming_traceparent {
            telemetry = telemetry.with_incoming_traceparent(traceparent);
        }

        let Ok(events) = telemetry.build() else {
            return Ok(response);
        };
        if let Ok(value) = HeaderValue::from_str(&events.outgoing_traceparent) {
            drop(
                response
                    .headers_mut()
                    .insert(HeaderName::from_static("traceparent"), value),
            );
        }
        if let Ok(mut client) = app_state.client.lock() {
            drop(client.span(
                format!("evt_actix_request_span_{}", events.span_id),
                "2026-06-02T10:00:00Z",
                events.span,
            ));
            if let Some(metric) = events.metric {
                drop(client.metric(
                    format!("evt_actix_request_duration_{}", events.span_id),
                    "2026-06-02T10:00:00Z",
                    metric,
                ));
            }
        }
        Ok(response)
    })
}

async fn checkout() -> HttpResponse {
    HttpResponse::Accepted().body("accepted")
}
