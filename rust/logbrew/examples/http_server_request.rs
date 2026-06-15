use logbrew::{HttpRequestTelemetry, LogBrewClient, Metadata, MetadataValue, RecordingTransport};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut client = LogBrewClient::builder("checkout-service", "1.2.3")
        .api_key("LOGBREW_API_KEY")
        .build()?;

    let mut metadata = Metadata::new();
    metadata.insert(
        "framework".to_string(),
        MetadataValue::String("axum".to_string()),
    );
    metadata.insert(
        "service".to_string(),
        MetadataValue::String("checkout-service".to_string()),
    );

    let request = HttpRequestTelemetry::new(
        "https://api.example.invalid/checkout/:cart_id?coupon=sample#review",
        "post",
        "11111111111111111111111111111111",
        "b7ad6b7169203331",
    )
    .with_incoming_traceparent("00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01")
    .with_status_code(202)
    .with_duration_ms(183.4)
    .with_metadata(metadata)
    .build()?;

    client.span("evt_http_server_span", "2026-06-02T10:00:00Z", request.span)?;
    client.metric(
        "evt_http_server_duration",
        "2026-06-02T10:00:00Z",
        request.metric.expect("duration metric should exist"),
    )?;

    println!("{}", client.preview_json()?);

    let mut transport = RecordingTransport::always_accept();
    let response = client.shutdown(&mut transport)?;
    eprintln!(
        "{{\"ok\":true,\"status\":{},\"attempts\":{},\"events\":2,\"outgoingTraceparent\":\"{}\"}}",
        response.status_code, response.attempts, request.outgoing_traceparent
    );
    Ok(())
}
