use logbrew::{
    ActionEvent, EnvironmentEvent, IssueEvent, LogBrewClient, LogEvent, MetricEvent, ReleaseEvent,
    SpanEvent, TelemetryApplication, TelemetryContext, TelemetryDeployment, TelemetryDevice,
    TelemetryNamedVersion, TelemetryOperatingSystem, TelemetryResource, TelemetrySessionContext,
    TelemetrySubjectContext, TelemetryTraceContext, activate_telemetry_context,
    current_telemetry_context, merge_telemetry_contexts, validate_telemetry_context,
    with_telemetry_context, with_telemetry_context_async,
};
use serde_json::Value;
use std::collections::BTreeMap;
use std::panic::{self, AssertUnwindSafe};
use std::sync::{Arc, Barrier};

const TRACE_ID: &str = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID: &str = "00f067aa0ba902b7";

fn resource() -> TelemetryResource {
    TelemetryResource::new()
        .with_service(TelemetryNamedVersion::new("checkout-api").with_version("1.2.3"))
        .with_deployment(
            TelemetryDeployment::new()
                .with_environment("production")
                .with_release("2026.08.03"),
        )
        .with_runtime(TelemetryNamedVersion::new("rust"))
        .with_framework(TelemetryNamedVersion::new("axum").with_version("0.8"))
        .with_operating_system(TelemetryOperatingSystem::new("linux").with_version("6.8"))
        .with_device(TelemetryDevice::new().with_architecture("x86_64"))
        .with_application(
            TelemetryApplication::new()
                .with_name("checkout")
                .with_version("1.2.3")
                .with_build("build-42"),
        )
}

fn deterministic_client(context: TelemetryContext) -> LogBrewClient {
    LogBrewClient::builder("logbrew-rust", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .capture_runtime_context(false)
        .context(context)
        .build()
        .expect("client should build")
}

#[test]
fn all_seven_signals_receive_shared_context_and_event_overrides() {
    let client_context = TelemetryContext::new()
        .with_resource(resource())
        .with_subject(TelemetrySubjectContext::anonymous("anon_123"))
        .with_tag("customer.tier", "free")
        .with_tag("region", "us");
    let ambient_context = TelemetryContext::new()
        .with_trace(TelemetryTraceContext::new(TRACE_ID).with_span_id(SPAN_ID))
        .with_session(TelemetrySessionContext::new("session_123"))
        .with_tag("request.kind", "checkout");
    let event_context = TelemetryContext::new()
        .with_subject(TelemetrySubjectContext::user("user_456"))
        .with_tag("customer.tier", "enterprise");
    let mut client = deterministic_client(client_context);

    with_telemetry_context(ambient_context, || {
        client
            .release(
                "release",
                "2026-08-03T10:00:00Z",
                ReleaseEvent::new("1.2.3").with_context(event_context.clone()),
            )
            .unwrap();
        client
            .environment(
                "environment",
                "2026-08-03T10:00:01Z",
                EnvironmentEvent::new("production").with_context(event_context.clone()),
            )
            .unwrap();
        client
            .issue(
                "issue",
                "2026-08-03T10:00:02Z",
                IssueEvent::new("Checkout failed", "error").with_context(event_context.clone()),
            )
            .unwrap();
        client
            .log(
                "log",
                "2026-08-03T10:00:03Z",
                LogEvent::new("checkout failed", "error").with_context(event_context.clone()),
            )
            .unwrap();
        client
            .span(
                "span",
                "2026-08-03T10:00:04Z",
                SpanEvent::new("POST /checkout", TRACE_ID, SPAN_ID, "error")
                    .with_context(event_context.clone()),
            )
            .unwrap();
        client
            .action(
                "action",
                "2026-08-03T10:00:05Z",
                ActionEvent::new("checkout.submit", "failure").with_context(event_context.clone()),
            )
            .unwrap();
        client
            .metric(
                "metric",
                "2026-08-03T10:00:06Z",
                MetricEvent::new("checkout.duration", "histogram", 42.0, "ms", "delta")
                    .with_context(event_context),
            )
            .unwrap();
    })
    .unwrap();

    let payload: Value = serde_json::from_str(&client.preview_json().unwrap()).unwrap();
    let events = payload["events"].as_array().unwrap();
    assert_eq!(events.len(), 7);
    for event in events {
        let context = &event["attributes"]["context"];
        assert_eq!(context["schemaVersion"], 1);
        assert_eq!(context["resource"]["service"]["name"], "checkout-api");
        assert_eq!(context["resource"]["framework"]["name"], "axum");
        assert_eq!(context["trace"]["traceId"], TRACE_ID);
        assert_eq!(context["trace"]["spanId"], SPAN_ID);
        assert_eq!(context["session"]["id"], "session_123");
        assert_eq!(context["subject"]["id"], "user_456");
        assert_eq!(context["subject"]["kind"], "user");
        assert_eq!(context["tags"]["customer.tier"], "enterprise");
        assert_eq!(context["tags"]["region"], "us");
        assert_eq!(context["tags"]["request.kind"], "checkout");
    }
}

#[test]
fn runtime_defaults_are_conservative_and_can_be_disabled() {
    let mut default_client = LogBrewClient::builder("logbrew-rust", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()
        .unwrap();
    default_client
        .log(
            "default",
            "2026-08-03T10:00:00Z",
            LogEvent::new("started", "info"),
        )
        .unwrap();
    let payload: Value = serde_json::from_str(&default_client.preview_json().unwrap()).unwrap();
    let context = &payload["events"][0]["attributes"]["context"];
    assert_eq!(context["resource"]["runtime"]["name"], "rust");
    assert!(context["resource"]["operatingSystem"]["name"].is_string());
    assert!(context["resource"]["device"]["architecture"].is_string());
    let serialized = context.to_string().to_ascii_lowercase();
    for forbidden in [
        "hostname",
        "host.name",
        "process",
        "command",
        "argument",
        "environment.variable",
        "account",
        "username",
        "home",
        "cwd",
        "file.path",
        "ip",
        "mac",
        "cloud",
        "cpu",
        "memory",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "captured forbidden field: {forbidden}"
        );
    }

    let mut disabled_client = LogBrewClient::builder("logbrew-rust", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .capture_runtime_context(false)
        .build()
        .unwrap();
    disabled_client
        .log(
            "disabled",
            "2026-08-03T10:00:00Z",
            LogEvent::new("started", "info"),
        )
        .unwrap();
    let payload: Value = serde_json::from_str(&disabled_client.preview_json().unwrap()).unwrap();
    assert!(payload["events"][0]["attributes"].get("context").is_none());
}

#[test]
fn validation_normalizes_ids_and_rejects_unbounded_or_unsafe_values() {
    let context = TelemetryContext::new().with_trace(
        TelemetryTraceContext::new("4BF92F3577B34DA6A3CE929D0E0E4736")
            .with_span_id("00F067AA0BA902B7"),
    );
    let normalized = validate_telemetry_context(&context).unwrap();
    assert_eq!(normalized.trace.unwrap().trace_id, TRACE_ID);

    let cases = [
        TelemetryContext::new(),
        TelemetryContext::new().with_tag("bad key", "value"),
        TelemetryContext::new().with_tag("valid", "line\nbreak"),
        TelemetryContext::new().with_tag("valid", "x".repeat(257)),
        TelemetryContext::new().with_trace(TelemetryTraceContext::new("0".repeat(32))),
        TelemetryContext::new()
            .with_session(TelemetrySessionContext::new("same").with_previous_id("same")),
        TelemetryContext::new()
            .with_resource(TelemetryResource::new().with_device(TelemetryDevice::new())),
    ];
    for case in cases {
        let error = validate_telemetry_context(&case).unwrap_err();
        assert_eq!(error.code, "validation_error");
    }

    let mut too_many_tags = TelemetryContext::new();
    for index in 0..33 {
        too_many_tags = too_many_tags.with_tag(format!("tag{index}"), "value");
    }
    assert!(validate_telemetry_context(&too_many_tags).is_err());
}

#[test]
fn merge_is_field_aware_sorted_and_detached() {
    let base = TelemetryContext::new()
        .with_resource(
            TelemetryResource::new()
                .with_service(TelemetryNamedVersion::new("checkout").with_version("1"))
                .with_deployment(TelemetryDeployment::new().with_environment("staging")),
        )
        .with_subject(TelemetrySubjectContext::anonymous("anon"))
        .with_tag("zeta", "base")
        .with_tag("alpha", "base");
    let override_context = TelemetryContext::new()
        .with_resource(
            TelemetryResource::new()
                .with_service(TelemetryNamedVersion::new("payments").with_version("2"))
                .with_deployment(TelemetryDeployment::new().with_release("release-2")),
        )
        .with_subject(TelemetrySubjectContext::user("user"))
        .with_tag("zeta", "override");

    let merged = merge_telemetry_contexts(Some(&base), Some(&override_context))
        .unwrap()
        .unwrap();
    let resource = merged.resource.as_ref().unwrap();
    assert_eq!(resource.service.as_ref().unwrap().name, "payments");
    assert_eq!(
        resource.deployment.as_ref().unwrap().environment.as_deref(),
        Some("staging")
    );
    assert_eq!(
        resource.deployment.as_ref().unwrap().release.as_deref(),
        Some("release-2")
    );
    assert_eq!(merged.subject.as_ref().unwrap().id, "user");
    assert_eq!(merged.tags.get("alpha").map(String::as_str), Some("base"));
    assert_eq!(
        merged.tags.get("zeta").map(String::as_str),
        Some("override")
    );

    let mut changed_base = base;
    changed_base
        .tags
        .insert("alpha".to_string(), "changed".to_string());
    assert_eq!(merged.tags.get("alpha").map(String::as_str), Some("base"));
}

#[test]
fn synchronous_scopes_restore_on_close_drop_panic_and_threads() {
    assert!(current_telemetry_context().is_none());
    let outer = TelemetryContext::new().with_tag("scope", "outer");
    let inner = TelemetryContext::new().with_tag("scope", "inner");

    let mut outer_guard = activate_telemetry_context(outer).unwrap();
    let inner_guard = activate_telemetry_context(inner).unwrap();
    assert_eq!(current_telemetry_context().unwrap().tags["scope"], "inner");
    outer_guard.close();
    assert_eq!(current_telemetry_context().unwrap().tags["scope"], "inner");
    drop(inner_guard);
    assert!(current_telemetry_context().is_none());

    let panic_result = panic::catch_unwind(AssertUnwindSafe(|| {
        with_telemetry_context(TelemetryContext::new().with_tag("scope", "panic"), || {
            panic!("expected test unwind")
        })
        .unwrap();
    }));
    assert!(panic_result.is_err());
    assert!(current_telemetry_context().is_none());

    let barrier = Arc::new(Barrier::new(2));
    let worker_barrier = Arc::clone(&barrier);
    let worker = std::thread::spawn(move || {
        let _guard =
            activate_telemetry_context(TelemetryContext::new().with_tag("thread", "worker"))
                .unwrap();
        worker_barrier.wait();
        assert_eq!(
            current_telemetry_context().unwrap().tags["thread"],
            "worker"
        );
    });
    barrier.wait();
    assert!(current_telemetry_context().is_none());
    worker.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn async_poll_scopes_are_isolated_across_concurrent_tasks() {
    let first =
        with_telemetry_context_async(TelemetryContext::new().with_tag("task", "first"), async {
            tokio::task::yield_now().await;
            current_telemetry_context().unwrap().tags["task"].clone()
        })
        .unwrap();
    let second =
        with_telemetry_context_async(TelemetryContext::new().with_tag("task", "second"), async {
            tokio::task::yield_now().await;
            current_telemetry_context().unwrap().tags["task"].clone()
        })
        .unwrap();

    let (first, second) = tokio::join!(first, second);
    assert_eq!(first.unwrap(), "first");
    assert_eq!(second.unwrap(), "second");
    assert!(current_telemetry_context().is_none());
}

#[test]
fn tag_order_produces_byte_stable_queue_serialization() {
    let mut first_tags = BTreeMap::new();
    first_tags.insert("zeta".to_string(), "2".to_string());
    first_tags.insert("alpha".to_string(), "1".to_string());
    let mut second_tags = BTreeMap::new();
    second_tags.insert("alpha".to_string(), "1".to_string());
    second_tags.insert("zeta".to_string(), "2".to_string());

    let first_context = TelemetryContext::new().with_tags(first_tags);
    let second_context = TelemetryContext::new().with_tags(second_tags);
    let mut first = deterministic_client(first_context);
    let mut second = deterministic_client(second_context);
    for client in [&mut first, &mut second] {
        client
            .log(
                "event",
                "2026-08-03T10:00:00Z",
                LogEvent::new("stable", "info"),
            )
            .unwrap();
    }

    assert_eq!(
        first.preview_json().unwrap(),
        second.preview_json().unwrap()
    );
}
