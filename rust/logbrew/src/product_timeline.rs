use crate::{ACTION_STATUSES, ActionEvent, SdkError, require_allowed_value, require_non_empty};
use serde_json::{Map, Value};

#[derive(Clone, Debug)]
/// App-owned timeline builders for product actions and network milestones.
pub struct ProductTimeline;

impl ProductTimeline {
    /// Start a product action timeline builder for an app-known product step.
    pub fn product_action(name: impl Into<String>) -> ProductActionTimeline {
        ProductActionTimeline::new(name)
    }

    /// Start a network milestone timeline builder for an app-owned API milestone.
    pub fn network_milestone(route_template: impl Into<String>) -> NetworkMilestoneTimeline {
        NetworkMilestoneTimeline::new(route_template)
    }
}

#[derive(Clone, Debug, PartialEq)]
/// Builder for product-step timeline action events.
pub struct ProductActionTimeline {
    name: String,
    status: String,
    route_template: Option<String>,
    session_id: Option<String>,
    trace_id: Option<String>,
    screen: Option<String>,
    funnel: Option<String>,
    step: Option<String>,
    metadata: Option<Map<String, Value>>,
}

impl ProductActionTimeline {
    /// Create a product action timeline builder with a required action name.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            status: "success".to_string(),
            route_template: None,
            session_id: None,
            trace_id: None,
            screen: None,
            funnel: None,
            step: None,
            metadata: None,
        }
    }

    /// Override the action status: queued, running, success, or failure.
    pub fn with_status(mut self, status: impl Into<String>) -> Self {
        self.status = status.into();
        self
    }

    /// Attach a route template; query strings and hash fragments are stripped.
    pub fn with_route_template(mut self, route_template: impl Into<String>) -> Self {
        self.route_template = Some(route_template.into());
        self
    }

    /// Attach an app-owned session identifier.
    pub fn with_session_id(mut self, session_id: impl Into<String>) -> Self {
        self.session_id = Some(session_id.into());
        self
    }

    /// Attach a trace identifier for correlation.
    pub fn with_trace_id(mut self, trace_id: impl Into<String>) -> Self {
        self.trace_id = Some(trace_id.into());
        self
    }

    /// Attach a screen name for mobile or frontend product flows.
    pub fn with_screen(mut self, screen: impl Into<String>) -> Self {
        self.screen = Some(screen.into());
        self
    }

    /// Attach a funnel name for product-flow analysis.
    pub fn with_funnel(mut self, funnel: impl Into<String>) -> Self {
        self.funnel = Some(funnel.into());
        self
    }

    /// Attach a funnel step name or number known by the app.
    pub fn with_step(mut self, step: impl Into<String>) -> Self {
        self.step = Some(step.into());
        self
    }

    /// Attach primitive, app-owned metadata.
    pub fn with_metadata(mut self, metadata: Map<String, Value>) -> Self {
        self.metadata = Some(metadata);
        self
    }

    /// Build a normal LogBrew action event for queueing with `client.action`.
    pub fn build(self) -> Result<ActionEvent, SdkError> {
        require_non_empty("product action name", &self.name)?;
        require_allowed_value("action status", &self.status, ACTION_STATUSES)?;

        let mut metadata = timeline_metadata("product_timeline", self.metadata)?;
        insert_optional(
            &mut metadata,
            "routeTemplate",
            optional_route_template("product route_template", self.route_template)?,
        );
        insert_optional(
            &mut metadata,
            "sessionId",
            optional_label("session_id", self.session_id)?,
        );
        insert_optional(
            &mut metadata,
            "traceId",
            optional_label("trace_id", self.trace_id)?,
        );
        insert_optional(
            &mut metadata,
            "screen",
            optional_label("screen", self.screen)?,
        );
        insert_optional(
            &mut metadata,
            "funnel",
            optional_label("funnel", self.funnel)?,
        );
        insert_optional(&mut metadata, "step", optional_label("step", self.step)?);

        Ok(ActionEvent::new(self.name, self.status).with_metadata(metadata))
    }
}

#[derive(Clone, Debug, PartialEq)]
/// Builder for app-owned API or network milestone timeline action events.
pub struct NetworkMilestoneTimeline {
    route_template: String,
    method: String,
    status_code: Option<u16>,
    duration_ms: Option<f64>,
    status: Option<String>,
    name: Option<String>,
    session_id: Option<String>,
    trace_id: Option<String>,
    metadata: Option<Map<String, Value>>,
}

impl NetworkMilestoneTimeline {
    /// Create a network milestone builder with a required route template.
    pub fn new(route_template: impl Into<String>) -> Self {
        Self {
            route_template: route_template.into(),
            method: "GET".to_string(),
            status_code: None,
            duration_ms: None,
            status: None,
            name: None,
            session_id: None,
            trace_id: None,
            metadata: None,
        }
    }

    /// Attach the HTTP method; it is normalized to uppercase.
    pub fn with_method(mut self, method: impl Into<String>) -> Self {
        self.method = method.into();
        self
    }

    /// Attach an HTTP status code, which also drives the default action status.
    pub fn with_status_code(mut self, status_code: u16) -> Self {
        self.status_code = Some(status_code);
        self
    }

    /// Attach a non-negative duration in milliseconds.
    pub fn with_duration_ms(mut self, duration_ms: f64) -> Self {
        self.duration_ms = Some(duration_ms);
        self
    }

    /// Override the action status: queued, running, success, or failure.
    pub fn with_status(mut self, status: impl Into<String>) -> Self {
        self.status = Some(status.into());
        self
    }

    /// Override the default `network.<method> <route>` action name.
    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    /// Attach an app-owned session identifier.
    pub fn with_session_id(mut self, session_id: impl Into<String>) -> Self {
        self.session_id = Some(session_id.into());
        self
    }

    /// Attach a trace identifier for correlation.
    pub fn with_trace_id(mut self, trace_id: impl Into<String>) -> Self {
        self.trace_id = Some(trace_id.into());
        self
    }

    /// Attach primitive, app-owned metadata.
    pub fn with_metadata(mut self, metadata: Map<String, Value>) -> Self {
        self.metadata = Some(metadata);
        self
    }

    /// Build a normal LogBrew action event for queueing with `client.action`.
    pub fn build(self) -> Result<ActionEvent, SdkError> {
        let route =
            sanitize_route_template("network milestone route_template", self.route_template)?;
        let method = normalize_method(&self.method)?;
        validate_status_code(self.status_code)?;
        validate_duration_ms(self.duration_ms)?;
        let status = self.status.unwrap_or_else(|| {
            if self.status_code.is_some_and(|code| code >= 400) {
                "failure".to_string()
            } else {
                "success".to_string()
            }
        });
        require_allowed_value("action status", &status, ACTION_STATUSES)?;

        let name = match self.name {
            Some(name) => required_label("network milestone name", name)?,
            None => format!("network.{} {route}", method.to_ascii_lowercase()),
        };
        let mut metadata = timeline_metadata("network_timeline", self.metadata)?;
        metadata.insert("routeTemplate".to_string(), Value::String(route));
        metadata.insert("method".to_string(), Value::String(method));
        if let Some(status_code) = self.status_code {
            metadata.insert("statusCode".to_string(), Value::from(status_code));
        }
        if let Some(duration_ms) = self.duration_ms {
            metadata.insert("durationMs".to_string(), Value::from(duration_ms));
        }
        insert_optional(
            &mut metadata,
            "sessionId",
            optional_label("session_id", self.session_id)?,
        );
        insert_optional(
            &mut metadata,
            "traceId",
            optional_label("trace_id", self.trace_id)?,
        );

        Ok(ActionEvent::new(name, status).with_metadata(metadata))
    }
}

fn timeline_metadata(
    source: &'static str,
    metadata: Option<Map<String, Value>>,
) -> Result<Map<String, Value>, SdkError> {
    let mut copied = Map::new();
    copied.insert("source".to_string(), Value::String(source.to_string()));
    let Some(metadata) = metadata else {
        return Ok(copied);
    };

    for (key, value) in metadata {
        require_non_empty("metadata key", &key)?;
        require_primitive_metadata_value(&key, &value)?;
        if key != "source" {
            copied.insert(key, value);
        }
    }
    Ok(copied)
}

fn optional_route_template(
    label: &str,
    route_template: Option<String>,
) -> Result<Option<String>, SdkError> {
    route_template
        .map(|route_template| sanitize_route_template(label, route_template))
        .transpose()
}

fn sanitize_route_template(label: &str, route_template: String) -> Result<String, SdkError> {
    require_non_empty(label, &route_template)?;
    let trimmed = route_template.trim();
    let lowercase = trimmed.to_ascii_lowercase();
    let route = if lowercase.starts_with("https://") {
        path_from_http_url(&trimmed[8..])?
    } else if lowercase.starts_with("http://") {
        path_from_http_url(&trimmed[7..])?
    } else {
        trimmed
    };
    let route = match first_present_index(route.find('?'), route.find('#')) {
        Some(cutoff) => route[..cutoff].trim_end(),
        None => route.trim_end(),
    };
    Ok(if route.is_empty() { "/" } else { route }.to_string())
}

fn path_from_http_url(rest: &str) -> Result<&str, SdkError> {
    let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    if host_end == 0 {
        return Err(SdkError::new(
            "validation_error",
            "route_template URL host must be non-empty",
        ));
    }
    Ok(rest.get(host_end..).unwrap_or("/"))
}

fn normalize_method(method: &str) -> Result<String, SdkError> {
    let method = method.trim().to_ascii_uppercase();
    if method.is_empty()
        || !method.bytes().all(|byte| {
            byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-'
        })
    {
        return Err(SdkError::new(
            "validation_error",
            "network milestone method must be a valid HTTP method",
        ));
    }
    Ok(method)
}

fn validate_status_code(status_code: Option<u16>) -> Result<(), SdkError> {
    if status_code.is_some_and(|status_code| !(100..=599).contains(&status_code)) {
        return Err(SdkError::new(
            "validation_error",
            "network milestone status_code must be between 100 and 599",
        ));
    }
    Ok(())
}

fn validate_duration_ms(duration_ms: Option<f64>) -> Result<(), SdkError> {
    if let Some(duration_ms) = duration_ms {
        if !duration_ms.is_finite() {
            return Err(SdkError::new(
                "validation_error",
                "network milestone duration_ms must be finite",
            ));
        }
        if duration_ms < 0.0 {
            return Err(SdkError::new(
                "validation_error",
                "network milestone duration_ms must be non-negative",
            ));
        }
    }
    Ok(())
}

fn optional_label(label: &str, value: Option<String>) -> Result<Option<String>, SdkError> {
    value.map(|value| required_label(label, value)).transpose()
}

fn required_label(label: &str, value: String) -> Result<String, SdkError> {
    require_non_empty(label, &value)?;
    Ok(value.trim().to_string())
}

fn require_primitive_metadata_value(key: &str, value: &Value) -> Result<(), SdkError> {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => Ok(()),
        Value::Array(_) | Value::Object(_) => Err(SdkError::new(
            "validation_error",
            format!("metadata value for {key} must be primitive"),
        )),
    }
}

fn insert_optional(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        map.insert(key.to_string(), Value::String(value));
    }
}

fn first_present_index(first: Option<usize>, second: Option<usize>) -> Option<usize> {
    match (first, second) {
        (Some(first), Some(second)) => Some(first.min(second)),
        (Some(first), None) => Some(first),
        (None, Some(second)) => Some(second),
        (None, None) => None,
    }
}
