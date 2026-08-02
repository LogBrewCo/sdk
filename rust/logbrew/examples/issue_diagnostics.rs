use logbrew::{
    IssueBreadcrumb, IssueBreadcrumbBuffer, IssueEvent, LogBrewClient, Metadata, MetadataValue,
};
use std::{error::Error, fmt};

#[derive(Debug)]
struct CheckoutFailure;

impl fmt::Display for CheckoutFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("private handled error text")
    }
}

impl Error for CheckoutFailure {}

fn main() -> Result<(), Box<dyn Error>> {
    let mut client = LogBrewClient::builder("diagnostics-example", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()?;
    let mut breadcrumbs = IssueBreadcrumbBuffer::new();

    let mut route_data = Metadata::new();
    route_data.insert(
        "routeTemplate".to_string(),
        MetadataValue::String("/checkout/{cart_id}".to_string()),
    );
    route_data.insert(
        "method".to_string(),
        MetadataValue::String("POST".to_string()),
    );
    breadcrumbs.push(
        IssueBreadcrumb::new("2026-06-02T10:00:00Z", "http.request")
            .with_type("http")
            .with_level("info")
            .with_data(route_data),
    );

    let mut dependency_data = Metadata::new();
    dependency_data.insert(
        "system".to_string(),
        MetadataValue::String("postgres".to_string()),
    );
    dependency_data.insert("attempt".to_string(), MetadataValue::from(2));
    breadcrumbs.push(
        IssueBreadcrumb::new("2026-06-02T10:00:01Z", "database.query")
            .with_type("query")
            .with_level("error")
            .with_message("checkout lookup failed")
            .with_data(dependency_data),
    );

    let mut issue_metadata = Metadata::new();
    issue_metadata.insert(
        "traceId".to_string(),
        MetadataValue::String("4bf92f3577b34da6a3ce929d0e0e4736".to_string()),
    );
    issue_metadata.insert(
        "spanId".to_string(),
        MetadataValue::String("b7ad6b7169203331".to_string()),
    );
    issue_metadata.insert(
        "issueEvidenceCompleteness".to_string(),
        MetadataValue::String("caller_supplied".to_string()),
    );
    let error = CheckoutFailure;
    let handled_issue = breadcrumbs.apply_to(
        IssueEvent::from_error_with_mechanism(&error, "rust.example", true)
            .with_stack_frame(
                logbrew::issue_stack_frame!()
                    .with_function("checkout::submit")
                    .with_in_app(true),
            )
            .with_metadata(issue_metadata),
    );
    client.issue("evt_rust_error", "2026-06-02T10:00:02Z", handled_issue)?;

    let panic_payload = String::from("private panic payload text");
    client.issue(
        "evt_rust_panic",
        "2026-06-02T10:00:03Z",
        IssueEvent::from_panic_payload(&panic_payload).with_stack_frame(
            logbrew::issue_stack_frame!()
                .with_function("worker::run")
                .with_in_app(true),
        ),
    )?;

    println!("{}", client.preview_json()?);
    eprintln!("{{\"ok\":true,\"issues\":2}}");
    Ok(())
}
