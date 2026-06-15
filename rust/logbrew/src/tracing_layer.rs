use crate::{
    LogBrewClient, LogEvent, Metadata, MetadataValue, SharedLogBrewClient,
    http_fields::sanitize_route_template,
};
use std::fmt;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use tracing_core::{
    Event as TracingEvent, Level, Subscriber,
    field::{Field, Visit},
};
use tracing_subscriber::{Layer, layer::Context};

/// Optional `tracing` layer that converts app log events into LogBrew log events.
#[derive(Clone)]
pub struct LogBrewTracingLayer<T> {
    client: SharedLogBrewClient,
    timestamp: T,
    allowed_fields: Vec<String>,
    event_id_prefix: String,
    next_id: Arc<AtomicU64>,
    logger_name: Option<String>,
}

impl<T> LogBrewTracingLayer<T> {
    /// Build a `tracing` layer from an app-owned LogBrew client and timestamp source.
    pub fn new(client: SharedLogBrewClient, timestamp: T) -> Self {
        Self {
            client,
            timestamp,
            allowed_fields: Vec::new(),
            event_id_prefix: "evt_tracing_log".to_string(),
            next_id: Arc::new(AtomicU64::new(1)),
            logger_name: None,
        }
    }

    /// Allowlist primitive event fields copied into LogBrew metadata.
    pub fn with_allowed_fields<I, F>(mut self, fields: I) -> Self
    where
        I: IntoIterator<Item = F>,
        F: Into<String>,
    {
        self.allowed_fields = fields.into_iter().map(Into::into).collect();
        self
    }

    /// Override the event ID prefix used before the layer's monotonic counter.
    pub fn with_event_id_prefix(mut self, prefix: impl Into<String>) -> Self {
        self.event_id_prefix = prefix.into();
        self
    }

    /// Override the logger name attached to converted LogBrew log events.
    pub fn with_logger(mut self, logger: impl Into<String>) -> Self {
        self.logger_name = Some(logger.into());
        self
    }
}

impl<S, T> Layer<S> for LogBrewTracingLayer<T>
where
    S: Subscriber,
    T: Fn() -> String + Clone + Send + Sync + 'static,
{
    fn on_event(&self, event: &TracingEvent<'_>, _ctx: Context<'_, S>) {
        let metadata = event.metadata();
        let mut visitor = TracingLogVisitor::new(&self.allowed_fields);
        event.record(&mut visitor);

        let message = visitor
            .message
            .unwrap_or_else(|| "tracing event".to_string());
        let mut log_metadata = visitor.metadata;
        log_metadata.insert(
            "tracingTarget".to_string(),
            MetadataValue::String(metadata.target().to_string()),
        );
        log_metadata.insert(
            "tracingLevel".to_string(),
            MetadataValue::String(metadata.level().as_str().to_string()),
        );

        let logger = self
            .logger_name
            .as_deref()
            .unwrap_or_else(|| metadata.target())
            .trim()
            .to_string();
        let mut log =
            LogEvent::new(message, severity_for(metadata.level())).with_metadata(log_metadata);
        if !logger.is_empty() {
            log = log.with_logger(logger);
        }

        let sequence = self.next_id.fetch_add(1, Ordering::Relaxed);
        let event_id = format!("{}_{}", self.event_id_prefix.trim(), sequence);
        if let Ok(mut client) = self.client.lock() {
            let _ = queue_log(&mut client, event_id, (self.timestamp)(), log);
        }
    }
}

fn queue_log(
    client: &mut LogBrewClient,
    event_id: String,
    timestamp: String,
    log: LogEvent,
) -> Result<(), crate::SdkError> {
    client.log(event_id, timestamp, log)
}

fn severity_for(level: &Level) -> &'static str {
    if *level == Level::ERROR {
        "error"
    } else if *level == Level::WARN {
        "warning"
    } else {
        "info"
    }
}

struct TracingLogVisitor<'a> {
    allowed_fields: &'a [String],
    message: Option<String>,
    metadata: Metadata,
}

impl<'a> TracingLogVisitor<'a> {
    fn new(allowed_fields: &'a [String]) -> Self {
        Self {
            allowed_fields,
            message: None,
            metadata: Metadata::new(),
        }
    }

    fn allows(&self, field: &Field) -> bool {
        self.allowed_fields
            .iter()
            .any(|allowed| allowed == field.name())
    }

    fn record_string(&mut self, field: &Field, value: String) {
        if field.name() == "message" {
            self.message = Some(value);
            return;
        }
        if !self.allows(field) {
            return;
        }
        if is_route_field(field.name()) {
            if let Ok(route) = sanitize_route_template("tracing route template", value) {
                self.metadata
                    .insert(field.name().to_string(), MetadataValue::String(route));
            }
            return;
        }
        self.metadata
            .insert(field.name().to_string(), MetadataValue::String(value));
    }

    fn record_value(&mut self, field: &Field, value: MetadataValue) {
        if self.allows(field) {
            self.metadata.insert(field.name().to_string(), value);
        }
    }
}

impl Visit for TracingLogVisitor<'_> {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.record_string(field, value.to_string());
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.record_value(field, MetadataValue::Bool(value));
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.record_value(field, MetadataValue::from(value));
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.record_value(field, MetadataValue::from(value));
    }

    fn record_f64(&mut self, field: &Field, value: f64) {
        if value.is_finite() {
            self.record_value(field, MetadataValue::from(value));
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        if field.name() == "message" {
            self.record_string(field, format!("{value:?}"));
        }
    }
}

fn is_route_field(name: &str) -> bool {
    matches!(name, "routeTemplate" | "route_template")
}
