//! Integration tests for issue diagnostics.
#![cfg(test)]
use core::error::Error;
use core::fmt;
use logbrew::{
    IssueBreadcrumb, IssueBreadcrumbBuffer, IssueEvent, IssueException, IssueExceptionChain,
    IssueExceptionChainEntry, IssueExceptionMechanism, IssueExceptionRelationship, IssueStackFrame,
    LogBrewClient, Metadata, MetadataValue, SdkError,
};
use serde_json::Value;

#[derive(Debug)]
struct CheckoutFailure;

impl fmt::Display for CheckoutFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("private checkout error text")
    }
}

impl Error for CheckoutFailure {}

#[derive(Debug)]
struct PaymentFailure;

impl fmt::Display for PaymentFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("private payment provider response")
    }
}

impl Error for PaymentFailure {}

#[derive(Debug)]
struct CheckoutFailureWithSource(PaymentFailure);

impl fmt::Display for CheckoutFailureWithSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("private checkout wrapper text")
    }
}

impl Error for CheckoutFailureWithSource {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(&self.0)
    }
}

fn sample_client() -> LogBrewClient {
    LogBrewClient::builder("logbrew-rust", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()
        .expect("client should build")
}

#[test]
fn error_projection_builds_typed_bounded_diagnostics_without_error_text() {
    let error = CheckoutFailure;
    let mut breadcrumb_data = Metadata::new();
    drop(breadcrumb_data.insert("attempt".to_owned(), MetadataValue::from(2_i32)));
    drop(breadcrumb_data.insert("cached".to_owned(), MetadataValue::Bool(false)));

    let caller_frame = logbrew::issue_stack_frame!()
        .with_function("checkout::submit")
        .with_in_app(true);
    let source_frame = IssueStackFrame::new(
        "file:///redacted/services/checkout.rs?account=not-for-telemetry#debug",
        42,
        7,
    )
    .with_function("checkout::service::submit")
    .with_module("checkout::service")
    .with_in_app(true)
    .with_debug_id("AABBCCDD-1111-2222-3333-445566778899");
    let breadcrumb = IssueBreadcrumb::new("2026-06-02T10:00:01.250Z", "http.request")
        .with_type("http")
        .with_level("warn")
        .with_message("checkout dependency returned an error")
        .with_data(breadcrumb_data);

    let issue = IssueEvent::from_error_with_mechanism(&error, "rust.error", true)
        .with_stack_frames([source_frame, caller_frame])
        .with_breadcrumbs([breadcrumb])
        .with_breadcrumbs_truncated(true);
    let mut client = sample_client();
    client
        .issue("evt_issue_typed", "2026-06-02T10:00:02Z", issue)
        .expect("typed issue should queue");

    let payload: Value = serde_json::from_str(&client.preview_json().unwrap()).unwrap();
    let attributes = &payload["events"][0]["attributes"];
    let exception_type = attributes["exception"]["type"].as_str().unwrap();
    assert!(exception_type.ends_with("CheckoutFailure"));
    assert_eq!(attributes["title"], exception_type);
    assert_fields(
        attributes,
        &[
            ("/level", Value::from("error")),
            ("/exception/mechanism/type", Value::from("rust.error")),
            ("/exception/mechanism/handled", Value::Bool(true)),
        ],
    );
    assert!(attributes.get("message").is_none());

    let frames = attributes["stackFrames"].as_array().unwrap();
    assert_eq!(frames.len(), 2);
    assert_fields(
        &attributes["stackFrames"],
        &[
            ("/0/filename", Value::from("checkout.rs")),
            ("/0/line", Value::from(42_i32)),
            ("/0/column", Value::from(7_i32)),
            ("/0/function", Value::from("checkout::service::submit")),
            ("/0/module", Value::from("checkout::service")),
            ("/0/inApp", Value::Bool(true)),
            (
                "/0/debugId",
                Value::from("aabbccdd-1111-2222-3333-445566778899"),
            ),
            ("/1/filename", Value::from("issue_diagnostics.rs")),
            ("/1/inApp", Value::Bool(true)),
        ],
    );

    let breadcrumbs = attributes["breadcrumbs"].as_array().unwrap();
    assert_eq!(breadcrumbs.len(), 1);
    assert_fields(
        &attributes["breadcrumbs"],
        &[
            ("/0/timestamp", Value::from("2026-06-02T10:00:01.250Z")),
            ("/0/category", Value::from("http.request")),
            ("/0/type", Value::from("http")),
            ("/0/level", Value::from("warning")),
            ("/0/data/attempt", Value::from(2_i32)),
            ("/0/data/cached", Value::Bool(false)),
        ],
    );
    assert_eq!(attributes["breadcrumbsTruncated"], true);

    let text = payload.to_string();
    assert!(!text.contains("private checkout error text"));
    assert!(!text.contains("file:///redacted"));
    assert!(!text.contains("account=not-for-telemetry"));
}

#[test]
fn error_projection_preserves_causal_relationships_and_explicit_evidence_states() {
    let error = CheckoutFailureWithSource(PaymentFailure);
    let root_frame = IssueStackFrame::new("checkout.rs", 42, 7)
        .with_function("checkout::submit")
        .with_in_app(true);
    let issue = IssueEvent::from_error_with_mechanism(&error, "rust.error", true)
        .with_stack_frames([root_frame])
        .with_stack_frames_truncated(true);
    let mut client = sample_client();
    client
        .issue("evt_issue_cause", "2026-06-02T10:00:02Z", issue)
        .expect("causal issue should queue");

    let payload: Value = serde_json::from_str(&client.preview_json().unwrap()).unwrap();
    let attributes = &payload["events"][0]["attributes"];
    let chain = &attributes["exceptionChain"];
    let entries = chain["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(chain["truncated"], false);

    let root = &entries[0];
    assert_fields(
        root,
        &[
            ("/id", Value::from(0_i32)),
            ("/relationship", Value::from("reported")),
            ("/messageState", Value::from("redacted")),
        ],
    );
    assert!(root.get("message").is_none());
    assert_eq!(root["stackFramesState"], "truncated");
    assert_eq!(root["stackFrames"], attributes["stackFrames"]);
    assert_eq!(root["type"], attributes["exception"]["type"]);
    assert_eq!(root["mechanism"], attributes["exception"]["mechanism"]);

    let cause = &entries[1];
    assert_fields(
        cause,
        &[
            ("/id", Value::from(1_i32)),
            ("/parentId", Value::from(0_i32)),
            ("/relationship", Value::from("cause")),
        ],
    );
    assert!(
        cause["type"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    );
    assert_fields(
        cause,
        &[
            ("/mechanism/type", Value::from("rust.source")),
            ("/mechanism/handled", Value::Bool(true)),
            ("/messageState", Value::from("redacted")),
            ("/stackFramesState", Value::from("not_captured")),
        ],
    );
    assert!(cause.get("message").is_none());
    assert!(cause.get("stackFrames").is_none());

    let text = payload.to_string();
    assert!(!text.contains("private payment provider response"));
    assert!(!text.contains("private checkout wrapper text"));
}

#[test]
fn manual_exception_chain_keeps_approved_messages_and_per_node_stacks() {
    let root_mechanism = IssueExceptionMechanism::new("rust.manual", true);
    let root_frame = IssueStackFrame::new("checkout.rs", 42, 7)
        .with_function("checkout::submit")
        .with_in_app(true);
    let cause_frame = IssueStackFrame::new("payments.rs", 18, 3)
        .with_function("payments::authorize")
        .with_in_app(true);
    let root = IssueExceptionChainEntry::new(
        0,
        IssueExceptionRelationship::Reported,
        "checkout::CheckoutFailure",
    )
    .with_mechanism(root_mechanism.clone())
    .with_redacted_message()
    .with_stack_frames([root_frame.clone()], true);
    let cause = IssueExceptionChainEntry::new(
        1,
        IssueExceptionRelationship::Cause,
        "payments::AuthorizationFailure",
    )
    .with_parent_id(0)
    .with_message("provider rejected the authorization", false)
    .with_stack_frames([cause_frame], false);
    let issue = IssueEvent::new("checkout::CheckoutFailure", "error")
        .with_exception(
            IssueException::new("checkout::CheckoutFailure").with_mechanism(root_mechanism),
        )
        .with_stack_frames([root_frame])
        .with_stack_frames_truncated(true)
        .with_exception_chain(IssueExceptionChain::new([root, cause], false));
    let mut client = sample_client();
    client
        .issue("evt_issue_manual_chain", "2026-06-02T10:00:02Z", issue)
        .expect("manual chain should queue");

    let payload: Value = serde_json::from_str(&client.preview_json().unwrap()).unwrap();
    let attributes = &payload["events"][0]["attributes"];
    let entries = attributes["exceptionChain"]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["stackFramesState"], "truncated");
    assert_eq!(entries[0]["stackFrames"], attributes["stackFrames"]);
    assert_eq!(entries[1]["messageState"], "captured");
    assert_eq!(entries[1]["message"], "provider rejected the authorization");
    assert_eq!(entries[1]["stackFramesState"], "captured");
    assert_eq!(entries[1]["stackFrames"][0]["filename"], "payments.rs");
}

#[test]
fn diagnostic_limits_and_invalid_values_fail_before_queueing() {
    let error = CheckoutFailure;

    let too_many_frames = (0_i32..33_i32)
        .map(|index| IssueStackFrame::new(format!("frame_{index}.rs"), 1, 1))
        .collect::<Vec<_>>();
    let frame_error =
        issue_error(IssueEvent::from_error(&error).with_stack_frames(too_many_frames));
    assert_eq!(frame_error.code, "validation_error");
    assert_eq!(
        frame_error.message,
        "issue stackFrames must contain 1-32 frames"
    );

    let too_many_breadcrumbs = (0_i32..65_i32)
        .map(|index| {
            IssueBreadcrumb::new(
                format!("2026-06-02T10:00:{:02}Z", index.rem_euclid(60_i32)),
                "workflow.step",
            )
        })
        .collect::<Vec<_>>();
    let breadcrumb_error =
        issue_error(IssueEvent::from_error(&error).with_breadcrumbs(too_many_breadcrumbs));
    assert_eq!(breadcrumb_error.code, "validation_error");
    assert_eq!(
        breadcrumb_error.message,
        "issue breadcrumbs must contain 1-64 entries"
    );

    let mut nested_data = Metadata::new();
    drop(nested_data.insert(
        "request".to_owned(),
        serde_json::json!({"path": "/private"}),
    ));
    for (issue, message) in [
        (
            IssueEvent::from_error(&error).with_stack_frames([IssueStackFrame::new(
                "checkout.rs",
                0,
                1,
            )]),
            "issue stack frame line must be a positive integer",
        ),
        (
            IssueEvent::from_error(&error).with_breadcrumbs([IssueBreadcrumb::new(
                "2026-06-02T10:00:01Z",
                "http.request",
            )
            .with_data(nested_data)]),
            "issue breadcrumb data value for request must be a finite primitive",
        ),
        (
            IssueEvent::from_error(&error).with_stack_frame(
                IssueStackFrame::new("checkout.rs", 1, 1).with_debug_id("not-a-debug-id"),
            ),
            "issue stack frame debugId is invalid",
        ),
        (
            IssueEvent::from_error(&error).with_breadcrumb(IssueBreadcrumb::new(
                "2026-02-30T10:00:01Z",
                "workflow.step",
            )),
            "issue breadcrumb timestamp must be RFC 3339 with an explicit timezone",
        ),
        (
            IssueEvent::from_error_with_mechanism(&error, "rust error payload", true),
            "issue exception mechanism type must be a stable machine name",
        ),
    ] {
        assert_eq!(issue_error(issue).message, message);
    }
}

fn issue_error(issue: IssueEvent) -> SdkError {
    sample_client()
        .issue("evt_invalid_issue", "2026-06-02T10:00:02Z", issue)
        .unwrap_err()
}

#[test]
fn breadcrumb_buffer_keeps_the_newest_bounded_history_in_causal_order() {
    let error = CheckoutFailure;
    let mut buffer = IssueBreadcrumbBuffer::new();
    assert!(buffer.is_empty());
    for index in 0_i32..66_i32 {
        let mut data = Metadata::new();
        drop(data.insert("sequence".to_owned(), MetadataValue::from(index)));
        buffer.push(IssueBreadcrumb::new("2026-06-02T10:00:01Z", "workflow.step").with_data(data));
    }

    assert_eq!(buffer.len(), 64);
    assert!(!buffer.is_empty());
    assert!(buffer.is_truncated());
    let issue = buffer.apply_to(IssueEvent::from_error(&error));
    let mut client = sample_client();
    client
        .issue("evt_buffered", "2026-06-02T10:00:02Z", issue)
        .unwrap();
    let payload: Value = serde_json::from_str(&client.preview_json().unwrap()).unwrap();
    let attributes = &payload["events"][0]["attributes"];
    let breadcrumbs = attributes["breadcrumbs"].as_array().unwrap();
    assert_eq!(breadcrumbs.len(), 64);
    assert_eq!(breadcrumbs.first().unwrap()["data"]["sequence"], 2_i32);
    assert_eq!(breadcrumbs.last().unwrap()["data"]["sequence"], 65_i32);
    assert_eq!(attributes["breadcrumbsTruncated"], true);
}

#[test]
fn panic_projection_keeps_type_and_location_without_payload_text() {
    let panic_payload = String::from("private panic payload text");
    let issue = IssueEvent::from_panic_payload(&panic_payload).with_stack_frame(
        IssueStackFrame::from_location(core::panic::Location::caller()),
    );
    let mut client = sample_client();
    client
        .issue("evt_panic", "2026-06-02T10:00:02Z", issue)
        .unwrap();

    let payload: Value = serde_json::from_str(&client.preview_json().unwrap()).unwrap();
    let attributes = &payload["events"][0]["attributes"];
    assert_eq!(attributes["title"], "panic");
    assert_eq!(attributes["level"], "critical");
    assert_eq!(attributes["exception"]["type"], "panic");
    assert_eq!(attributes["exception"]["mechanism"]["type"], "rust.panic");
    assert_eq!(attributes["exception"]["mechanism"]["handled"], false);
    assert_eq!(attributes["metadata"]["panic"], true);
    assert_eq!(attributes["metadata"]["panicType"], "String");
    assert_eq!(
        attributes["stackFrames"][0]["filename"],
        "issue_diagnostics.rs"
    );
    assert!(attributes.get("message").is_none());
    assert!(!payload.to_string().contains("private panic payload text"));
}

fn assert_fields(object: &Value, expected: &[(&str, Value)]) {
    for field in expected {
        assert_eq!(object.pointer(field.0), Some(&field.1), "field {}", field.0);
    }
}
