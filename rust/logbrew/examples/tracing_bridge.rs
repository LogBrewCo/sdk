use logbrew::{
    EnvironmentEvent, LogBrewClient, LogBrewTracingLayer, RecordingTransport, ReleaseEvent,
    TelemetryContext, TelemetryDeployment, TelemetryNamedVersion, TelemetryResource,
};
use std::sync::{Arc, Mutex};
use tracing_subscriber::prelude::*;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Arc::new(Mutex::new(
        LogBrewClient::builder("checkout-service", "1.2.3")
            .api_key("LOGBREW_API_KEY")
            .context(
                TelemetryContext::new().with_resource(
                    TelemetryResource::new()
                        .with_service(
                            TelemetryNamedVersion::new("checkout-service").with_version("1.2.3"),
                        )
                        .with_deployment(TelemetryDeployment::new().with_environment("production")),
                ),
            )
            .build()?,
    ));

    {
        let mut client = client
            .lock()
            .expect("LogBrew client lock should be healthy");
        client.release(
            "evt_release_checkout",
            "2026-06-02T10:00:00Z",
            ReleaseEvent::new("1.2.3"),
        )?;
        client.environment(
            "evt_environment_checkout",
            "2026-06-02T10:00:01Z",
            EnvironmentEvent::new("production"),
        )?;
    }

    let layer =
        LogBrewTracingLayer::new(Arc::clone(&client), || "2026-06-02T10:00:02Z".to_string())
            .with_span_events()
            .with_error_issues()
            .with_allowed_fields([
                "routeTemplate",
                "statusCode",
                "sampled",
                "cartTier",
                "unsafeDebug",
            ])
            .with_logger("checkout");
    let subscriber = tracing_subscriber::registry().with(layer);

    tracing::subscriber::with_default(subscriber, || {
        let incoming_traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
        let checkout_span = tracing::info_span!(
            target: "checkout",
            "checkout.request",
            traceparent = incoming_traceparent,
            routeTemplate = "/checkout/{cart_id}?coupon=sample#review",
            cartTier = "gold",
            unsafeDebug = ?vec!["debug-value"],
            authorization = "Bearer sample",
        );
        let _checkout_guard = checkout_span.enter();
        tracing::info!(
            target: "checkout",
            routeTemplate = "/checkout/{cart_id}?coupon=sample#review",
            statusCode = 202_u64,
            sampled = true,
            cartTier = "gold",
            unsafeDebug = ?vec!["debug-value"],
            authorization = "Bearer sample",
            requestBody = "card=sample",
            "checkout tracing event accepted"
        );
        let validation_span = tracing::debug_span!(target: "checkout", "checkout.validate");
        let _validation_guard = validation_span.enter();
        tracing::error!(target: "checkout", "cart validation failed");
    });

    let mut client = client
        .lock()
        .expect("LogBrew client lock should be healthy");
    println!("{}", client.preview_json()?);
    let mut transport = RecordingTransport::always_accept();
    let response = client.shutdown(&mut transport)?;
    eprintln!(
        "{{\"ok\":true,\"status\":{},\"attempts\":{},\"events\":7}}",
        response.status_code, response.attempts
    );
    Ok(())
}
