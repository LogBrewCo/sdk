use actix_web::{
    App, Error, HttpResponse,
    dev::{ServiceRequest, ServiceResponse},
    http::header::{HeaderName, HeaderValue},
    middleware::{Next, from_fn},
    test, web,
};
use logbrew::{HttpRequestTelemetry, LogBrewClient, Metadata, MetadataValue, RecordingTransport};
use std::{
    sync::{Arc, Mutex},
    time::Instant,
};

#[derive(Clone)]
struct AppState {
    client: Arc<Mutex<LogBrewClient>>,
}

#[actix_web::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = LogBrewClient::builder("checkout-service", "1.2.3")
        .api_key("LOGBREW_API_KEY")
        .build()?;
    let client = Arc::new(Mutex::new(client));
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
    assert_eq!(response.status(), actix_web::http::StatusCode::ACCEPTED);
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

async fn logbrew_request_telemetry(
    request: ServiceRequest,
    next: Next<impl actix_web::body::MessageBody + 'static>,
) -> Result<ServiceResponse<impl actix_web::body::MessageBody>, Error> {
    let started = Instant::now();
    let method = request.method().as_str().to_string();
    let incoming_traceparent = request
        .headers()
        .get("traceparent")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let app_state = request
        .app_data::<web::Data<AppState>>()
        .map(|data| data.get_ref().clone());

    let mut response = next.call(request).await?;
    let Some(app_state) = app_state else {
        return Ok(response);
    };

    let route_template = response
        .request()
        .match_pattern()
        .unwrap_or_else(|| "/unknown".to_string());
    let status_code = response.status().as_u16();
    let duration_ms = started.elapsed().as_secs_f64() * 1000.0;

    let mut metadata = Metadata::new();
    metadata.insert(
        "framework".to_string(),
        MetadataValue::String("actix-web".to_string()),
    );
    metadata.insert(
        "service".to_string(),
        MetadataValue::String("checkout-service".to_string()),
    );

    let mut telemetry = HttpRequestTelemetry::new(
        route_template,
        method,
        "11111111111111111111111111111111",
        "b7ad6b7169203331",
    )
    .with_status_code(status_code)
    .with_duration_ms(duration_ms)
    .with_metadata(metadata);
    if let Some(traceparent) = incoming_traceparent {
        telemetry = telemetry.with_incoming_traceparent(traceparent);
    }

    let Ok(events) = telemetry.build() else {
        return Ok(response);
    };
    if let Ok(value) = HeaderValue::from_str(&events.outgoing_traceparent) {
        response
            .headers_mut()
            .insert(HeaderName::from_static("traceparent"), value);
    }
    if let Ok(mut client) = app_state.client.lock() {
        let _ = client.span(
            format!("evt_actix_request_span_{}", events.span_id),
            "2026-06-02T10:00:00Z",
            events.span,
        );
        if let Some(metric) = events.metric {
            let _ = client.metric(
                format!("evt_actix_request_duration_{}", events.span_id),
                "2026-06-02T10:00:00Z",
                metric,
            );
        }
    }
    Ok(response)
}

async fn checkout() -> HttpResponse {
    HttpResponse::Accepted().body("accepted")
}
