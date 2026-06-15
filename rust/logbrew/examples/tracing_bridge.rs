use logbrew::{
    EnvironmentEvent, LogBrewClient, LogBrewTracingLayer, Metadata, MetadataValue,
    RecordingTransport, ReleaseEvent,
};
use std::sync::{Arc, Mutex};
use tracing_subscriber::prelude::*;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Arc::new(Mutex::new(
        LogBrewClient::builder("checkout-service", "1.2.3")
            .api_key("LOGBREW_API_KEY")
            .build()?,
    ));

    {
        let mut client = client
            .lock()
            .expect("LogBrew client lock should be healthy");
        let mut release_metadata = Metadata::new();
        release_metadata.insert(
            "service".to_string(),
            MetadataValue::String("checkout-service".to_string()),
        );
        client.release(
            "evt_release_checkout",
            "2026-06-02T10:00:00Z",
            ReleaseEvent::new("1.2.3").with_metadata(release_metadata),
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
        let checkout_span = tracing::info_span!(
            target: "checkout",
            "checkout.request",
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
        "{{\"ok\":true,\"status\":{},\"attempts\":{},\"events\":6}}",
        response.status_code, response.attempts
    );
    Ok(())
}
