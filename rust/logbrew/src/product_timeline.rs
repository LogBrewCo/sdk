use crate::http_fields::{
    insert_optional, normalize_method, optional_label, optional_route_template, required_label,
    sanitize_route_template, telemetry_metadata, validate_duration_ms, validate_status_code,
};
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

        let mut metadata = telemetry_metadata("product_timeline", self.metadata)?;
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
        let method = normalize_method("network milestone method", &self.method)?;
        validate_status_code("network milestone status_code", self.status_code)?;
        validate_duration_ms("network milestone duration_ms", self.duration_ms)?;
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
        let mut metadata = telemetry_metadata("network_timeline", self.metadata)?;
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
