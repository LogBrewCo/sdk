use logbrew::{
    IssueBreadcrumb, IssueBreadcrumbBuffer, IssueEvent, IssueException, IssueExceptionChain,
    IssueExceptionChainEntry, IssueExceptionMechanism, IssueExceptionRelationship, IssueStackFrame,
    LogBrewClient, Metadata, MetadataValue,
};
use serde_json::Value;
use std::error::Error;
use std::fmt;

#[derive(Debug)]
struct CheckoutFailure;

impl fmt::Display for CheckoutFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("private checkout error text")
    }
}

impl Error for CheckoutFailure {}

#[derive(Debug)]
struct PaymentFailure;

impl fmt::Display for PaymentFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("private payment provider response")
    }
}

impl Error for PaymentFailure {}

#[derive(Debug)]
struct CheckoutFailureWithSource(PaymentFailure);

impl fmt::Display for CheckoutFailureWithSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("private checkout wrapper text")
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
    breadcrumb_data.insert("attempt".to_string(), MetadataValue::from(2));
    breadcrumb_data.insert("cached".to_string(), MetadataValue::Bool(false));

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
    assert_eq!(attributes["level"], "error");
    assert_eq!(attributes["exception"]["mechanism"]["type"], "rust.error");
    assert_eq!(attributes["exception"]["mechanism"]["handled"], true);
    assert!(attributes.get("message").is_none());

    let frames = attributes["stackFrames"].as_array().unwrap();
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[0]["filename"], "checkout.rs");
    assert_eq!(frames[0]["line"], 42);
    assert_eq!(frames[0]["column"], 7);
    assert_eq!(frames[0]["function"], "checkout::service::submit");
    assert_eq!(frames[0]["module"], "checkout::service");
    assert_eq!(frames[0]["inApp"], true);
    assert_eq!(frames[0]["debugId"], "aabbccdd-1111-2222-3333-445566778899");
    assert_eq!(frames[1]["filename"], "issue_diagnostics.rs");
    assert_eq!(frames[1]["inApp"], true);

    let breadcrumbs = attributes["breadcrumbs"].as_array().unwrap();
    assert_eq!(breadcrumbs.len(), 1);
    assert_eq!(breadcrumbs[0]["timestamp"], "2026-06-02T10:00:01.250Z");
    assert_eq!(breadcrumbs[0]["category"], "http.request");
    assert_eq!(breadcrumbs[0]["type"], "http");
    assert_eq!(breadcrumbs[0]["level"], "warning");
    assert_eq!(breadcrumbs[0]["data"]["attempt"], 2);
    assert_eq!(breadcrumbs[0]["data"]["cached"], false);
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
    assert_eq!(root["id"], 0);
    assert_eq!(root["relationship"], "reported");
    assert_eq!(root["messageState"], "redacted");
    assert!(root.get("message").is_none());
    assert_eq!(root["stackFramesState"], "truncated");
    assert_eq!(root["stackFrames"], attributes["stackFrames"]);
    assert_eq!(root["type"], attributes["exception"]["type"]);
    assert_eq!(root["mechanism"], attributes["exception"]["mechanism"]);

    let cause = &entries[1];
    assert_eq!(cause["id"], 1);
    assert_eq!(cause["parentId"], 0);
    assert_eq!(cause["relationship"], "cause");
    assert!(
        cause["type"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    );
    assert_eq!(cause["mechanism"]["type"], "rust.source");
    assert_eq!(cause["mechanism"]["handled"], true);
    assert_eq!(cause["messageState"], "redacted");
    assert_eq!(cause["stackFramesState"], "not_captured");
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

    let too_many_frames = (0..33)
        .map(|index| IssueStackFrame::new(format!("frame_{index}.rs"), 1, 1))
        .collect::<Vec<_>>();
    let frame_error = sample_client()
        .issue(
            "evt_too_many_frames",
            "2026-06-02T10:00:02Z",
            IssueEvent::from_error(&error).with_stack_frames(too_many_frames),
        )
        .unwrap_err();
    assert_eq!(frame_error.code, "validation_error");
    assert_eq!(
        frame_error.message,
        "issue stackFrames must contain 1-32 frames"
    );

    let too_many_breadcrumbs = (0..65)
        .map(|index| {
            IssueBreadcrumb::new(
                format!("2026-06-02T10:00:{:02}Z", index % 60),
                "workflow.step",
            )
        })
        .collect::<Vec<_>>();
    let breadcrumb_error = sample_client()
        .issue(
            "evt_too_many_breadcrumbs",
            "2026-06-02T10:00:02Z",
            IssueEvent::from_error(&error).with_breadcrumbs(too_many_breadcrumbs),
        )
        .unwrap_err();
    assert_eq!(breadcrumb_error.code, "validation_error");
    assert_eq!(
        breadcrumb_error.message,
        "issue breadcrumbs must contain 1-64 entries"
    );

    let invalid_coordinate = sample_client()
        .issue(
            "evt_invalid_coordinate",
            "2026-06-02T10:00:02Z",
            IssueEvent::from_error(&error).with_stack_frames([IssueStackFrame::new(
                "checkout.rs",
                0,
                1,
            )]),
        )
        .unwrap_err();
    assert_eq!(
        invalid_coordinate.message,
        "issue stack frame line must be a positive integer"
    );

    let mut nested_data = Metadata::new();
    nested_data.insert(
        "request".to_string(),
        serde_json::json!({"path": "/private"}),
    );
    let invalid_data = sample_client()
        .issue(
            "evt_invalid_data",
            "2026-06-02T10:00:02Z",
            IssueEvent::from_error(&error).with_breadcrumbs([IssueBreadcrumb::new(
                "2026-06-02T10:00:01Z",
                "http.request",
            )
            .with_data(nested_data)]),
        )
        .unwrap_err();
    assert_eq!(
        invalid_data.message,
        "issue breadcrumb data value for request must be a finite primitive"
    );

    let invalid_debug_id = sample_client()
        .issue(
            "evt_invalid_debug_id",
            "2026-06-02T10:00:02Z",
            IssueEvent::from_error(&error).with_stack_frame(
                IssueStackFrame::new("checkout.rs", 1, 1).with_debug_id("not-a-debug-id"),
            ),
        )
        .unwrap_err();
    assert_eq!(
        invalid_debug_id.message,
        "issue stack frame debugId is invalid"
    );

    let invalid_timestamp = sample_client()
        .issue(
            "evt_invalid_breadcrumb_timestamp",
            "2026-06-02T10:00:02Z",
            IssueEvent::from_error(&error).with_breadcrumb(IssueBreadcrumb::new(
                "2026-02-30T10:00:01Z",
                "workflow.step",
            )),
        )
        .unwrap_err();
    assert_eq!(
        invalid_timestamp.message,
        "issue breadcrumb timestamp must be RFC 3339 with an explicit timezone"
    );

    let invalid_mechanism = sample_client()
        .issue(
            "evt_invalid_mechanism",
            "2026-06-02T10:00:02Z",
            IssueEvent::from_error_with_mechanism(&error, "rust error payload", true),
        )
        .unwrap_err();
    assert_eq!(
        invalid_mechanism.message,
        "issue exception mechanism type must be a stable machine name"
    );
}

#[test]
fn breadcrumb_buffer_keeps_the_newest_bounded_history_in_causal_order() {
    let error = CheckoutFailure;
    let mut buffer = IssueBreadcrumbBuffer::new();
    assert!(buffer.is_empty());
    for index in 0..66 {
        let mut data = Metadata::new();
        data.insert("sequence".to_string(), MetadataValue::from(index));
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
    assert_eq!(breadcrumbs.first().unwrap()["data"]["sequence"], 2);
    assert_eq!(breadcrumbs.last().unwrap()["data"]["sequence"], 65);
    assert_eq!(attributes["breadcrumbsTruncated"], true);
}

#[test]
fn panic_projection_keeps_type_and_location_without_payload_text() {
    let payload = String::from("private panic payload text");
    let issue = IssueEvent::from_panic_payload(&payload).with_stack_frame(
        IssueStackFrame::from_location(std::panic::Location::caller()),
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
