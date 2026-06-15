use logbrew::{
    EnvironmentEvent, LogBrewClient, LogEvent, Metadata, MetadataValue, MetricEvent,
    ProductTimeline, RecordingTransport, ReleaseEvent, Traceparent, TraceparentSpanInput,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let incoming_traceparent = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01";
    let trace_context = Traceparent::parse(incoming_traceparent)?;
    let child_span_id = "b7ad6b7169203331";
    let outgoing_headers = Traceparent::create_headers(
        &trace_context.trace_id,
        child_span_id,
        &trace_context.trace_flags,
    )?;
    let session_id = "sess_checkout_123";
    let route_template = "/checkout/:cart_id";

    let mut client = LogBrewClient::builder("checkout-service", "1.2.3")
        .api_key("LOGBREW_API_KEY")
        .build()?;
    let mut release_metadata = Metadata::new();
    release_metadata.insert(
        "service".to_string(),
        MetadataValue::String("checkout-service".to_string()),
    );
    client.release(
        "evt_release_checkout",
        "2026-06-02T10:00:00Z",
        ReleaseEvent::new("1.2.3")
            .with_commit("abc123def456")
            .with_metadata(release_metadata),
    )?;

    let mut environment_metadata = Metadata::new();
    environment_metadata.insert(
        "service".to_string(),
        MetadataValue::String("checkout-service".to_string()),
    );
    client.environment(
        "evt_environment_checkout",
        "2026-06-02T10:00:01Z",
        EnvironmentEvent::new("production")
            .with_region("global")
            .with_metadata(environment_metadata),
    )?;

    let mut log_metadata = Metadata::new();
    log_metadata.insert(
        "traceId".to_string(),
        MetadataValue::String(trace_context.trace_id.clone()),
    );
    log_metadata.insert(
        "sessionId".to_string(),
        MetadataValue::String(session_id.to_string()),
    );
    log_metadata.insert(
        "routeTemplate".to_string(),
        MetadataValue::String(route_template.to_string()),
    );
    client.log(
        "evt_log_checkout_started",
        "2026-06-02T10:00:02Z",
        LogEvent::new("checkout request started", "info")
            .with_logger("checkout")
            .with_metadata(log_metadata),
    )?;

    let mut product_metadata = Metadata::new();
    product_metadata.insert(
        "cartTier".to_string(),
        MetadataValue::String("gold".to_string()),
    );
    client.action(
        "evt_action_checkout_submit",
        "2026-06-02T10:00:03Z",
        ProductTimeline::product_action("checkout.submit")
            .with_route_template("https://shop.example/checkout/:cart_id?coupon=sample#review")
            .with_session_id(session_id)
            .with_trace_id(&trace_context.trace_id)
            .with_screen("Checkout")
            .with_funnel("checkout")
            .with_step("submit")
            .with_metadata(product_metadata)
            .build()?,
    )?;

    let mut network_metadata = Metadata::new();
    network_metadata.insert(
        "dependency".to_string(),
        MetadataValue::String("payments".to_string()),
    );
    client.action(
        "evt_action_payment_api",
        "2026-06-02T10:00:04Z",
        ProductTimeline::network_milestone("https://api.example/payments/:payment_id?card=sample")
            .with_method("post")
            .with_status_code(202)
            .with_duration_ms(183.4)
            .with_session_id(session_id)
            .with_trace_id(&trace_context.trace_id)
            .with_metadata(network_metadata)
            .build()?,
    )?;

    let mut metric_metadata = Metadata::new();
    metric_metadata.insert(
        "method".to_string(),
        MetadataValue::String("POST".to_string()),
    );
    metric_metadata.insert(
        "routeTemplate".to_string(),
        MetadataValue::String(route_template.to_string()),
    );
    metric_metadata.insert("statusCode".to_string(), MetadataValue::from(202));
    metric_metadata.insert(
        "traceId".to_string(),
        MetadataValue::String(trace_context.trace_id.clone()),
    );
    client.metric(
        "evt_metric_http_server_duration",
        "2026-06-02T10:00:05Z",
        MetricEvent::new("http.server.duration", "histogram", 183.4, "ms", "delta")
            .with_metadata(metric_metadata),
    )?;

    let mut span_metadata = Metadata::new();
    span_metadata.insert(
        "sampled".to_string(),
        MetadataValue::Bool(trace_context.sampled),
    );
    span_metadata.insert(
        "routeTemplate".to_string(),
        MetadataValue::String(route_template.to_string()),
    );
    span_metadata.insert(
        "sessionId".to_string(),
        MetadataValue::String(session_id.to_string()),
    );
    client.span(
        "evt_span_checkout_request",
        "2026-06-02T10:00:06Z",
        Traceparent::span_attributes_from_context(
            &trace_context,
            TraceparentSpanInput::new("POST /checkout/:cart_id", child_span_id, "ok")
                .with_duration_ms(183.4)
                .with_metadata(span_metadata),
        )?,
    )?;

    println!("{}", client.preview_json()?);

    let mut transport = RecordingTransport::always_accept();
    let response = client.shutdown(&mut transport)?;
    eprintln!(
        "{{\"ok\":true,\"status\":{},\"attempts\":{},\"events\":7,\"outgoingTraceparent\":\"{}\"}}",
        response.status_code,
        response.attempts,
        outgoing_headers
            .get("traceparent")
            .expect("traceparent header should exist")
    );
    Ok(())
}
