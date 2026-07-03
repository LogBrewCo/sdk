use crate::{
    LogBrewClient, Metadata, MetadataValue, SharedLogBrewClient, SpanEvent,
    http_fields::sanitize_route_template, metadata_safety::sanitized_metadata,
};
use opentelemetry::{Key, KeyValue, Value};
use opentelemetry_sdk::{
    Resource,
    error::{OTelSdkError, OTelSdkResult},
    trace::{SpanData, SpanExporter},
};
use std::collections::BTreeSet;
use std::fmt;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::{Duration, SystemTime};

/// Configuration for the feature-gated OpenTelemetry span exporter.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogBrewOpenTelemetrySpanExporterConfig {
    timestamp: String,
    event_id_prefix: String,
    allowed_attribute_keys: BTreeSet<String>,
    service_name: Option<String>,
    service_version: Option<String>,
    deployment_environment: Option<String>,
}

impl LogBrewOpenTelemetrySpanExporterConfig {
    /// Build exporter configuration with a fixed LogBrew event timestamp.
    pub fn new(timestamp: impl Into<String>) -> Self {
        Self {
            timestamp: timestamp.into(),
            event_id_prefix: "evt_opentelemetry_span".to_string(),
            allowed_attribute_keys: BTreeSet::new(),
            service_name: None,
            service_version: None,
            deployment_environment: None,
        }
    }

    /// Override the event ID prefix used before the exporter's monotonic counter.
    pub fn with_event_id_prefix(mut self, event_id_prefix: impl Into<String>) -> Self {
        self.event_id_prefix = event_id_prefix.into();
        self
    }

    /// Allow primitive OpenTelemetry attributes to be copied into LogBrew metadata.
    pub fn with_allowed_attribute_keys<I, K>(mut self, keys: I) -> Self
    where
        I: IntoIterator<Item = K>,
        K: Into<String>,
    {
        self.allowed_attribute_keys = keys.into_iter().map(Into::into).collect();
        self
    }

    /// Attach a low-cardinality service name to exported span metadata.
    pub fn with_service_name(mut self, service_name: impl Into<String>) -> Self {
        self.service_name = Some(service_name.into());
        self
    }

    /// Attach a low-cardinality service version to exported span metadata.
    pub fn with_service_version(mut self, service_version: impl Into<String>) -> Self {
        self.service_version = Some(service_version.into());
        self
    }

    /// Attach a low-cardinality deployment environment to exported span metadata.
    pub fn with_deployment_environment(
        mut self,
        deployment_environment: impl Into<String>,
    ) -> Self {
        self.deployment_environment = Some(deployment_environment.into());
        self
    }
}

/// OpenTelemetry SDK span exporter that queues privacy-bounded LogBrew span events.
#[derive(Clone)]
pub struct LogBrewOpenTelemetrySpanExporter {
    client: SharedLogBrewClient,
    config: LogBrewOpenTelemetrySpanExporterConfig,
    resource: Arc<Mutex<ResourceSnapshot>>,
    next_id: Arc<AtomicU64>,
    shutdown: Arc<AtomicBool>,
}

impl LogBrewOpenTelemetrySpanExporter {
    /// Build an exporter from an app-owned LogBrew client and explicit exporter config.
    pub fn new(
        client: Arc<Mutex<LogBrewClient>>,
        config: LogBrewOpenTelemetrySpanExporterConfig,
    ) -> Self {
        Self {
            client,
            config,
            resource: Arc::new(Mutex::new(ResourceSnapshot::default())),
            next_id: Arc::new(AtomicU64::new(1)),
            shutdown: Arc::new(AtomicBool::new(false)),
        }
    }

    fn queue_exported_span(&self, span: SpanData) -> OTelSdkResult {
        if self.shutdown.load(Ordering::Relaxed) {
            return Err(OTelSdkError::AlreadyShutdown);
        }

        let sequence = self.next_id.fetch_add(1, Ordering::Relaxed);
        let event_id = format!("{}_{}", self.config.event_id_prefix.trim(), sequence);
        let timestamp = self.config.timestamp.clone();
        let span_event = self.span_event(span);
        self.client
            .lock()
            .map_err(|_| {
                OTelSdkError::InternalFailure("LogBrew OpenTelemetry exporter mutex poison".into())
            })?
            .span(event_id, timestamp, span_event)
            .map_err(|error| OTelSdkError::InternalFailure(error.to_string()))
    }

    fn span_event(&self, span: SpanData) -> SpanEvent {
        let trace_id = span.span_context.trace_id().to_string();
        let span_id = span.span_context.span_id().to_string();
        let mut event = SpanEvent::new(
            span.name.to_string(),
            trace_id,
            span_id,
            status_label(&span.status),
        );
        let parent_span_id = span.parent_span_id.to_string();
        if parent_span_id != "0000000000000000" {
            event = event.with_parent_span_id(parent_span_id);
        }
        event
            .with_duration_ms(duration_ms(span.start_time, span.end_time))
            .with_metadata(self.metadata_for(&span))
    }

    fn metadata_for(&self, span: &SpanData) -> Metadata {
        let mut metadata = Metadata::new();
        metadata.insert(
            "source".to_string(),
            MetadataValue::String("opentelemetry.span_exporter".to_string()),
        );
        let resource_service_name = self.resource_service_name();
        let service_name = self
            .config
            .service_name
            .as_deref()
            .or(resource_service_name.as_deref());
        insert_string(&mut metadata, "service.name", service_name);
        insert_string(
            &mut metadata,
            "service.version",
            self.config.service_version.as_deref(),
        );
        insert_string(
            &mut metadata,
            "deployment.environment",
            self.config.deployment_environment.as_deref(),
        );
        metadata.insert(
            "otel.span.kind".to_string(),
            MetadataValue::String(span_kind_label(&span.span_kind).to_string()),
        );
        insert_string(
            &mut metadata,
            "otel.instrumentation.scope.name",
            Some(span.instrumentation_scope.name()),
        );
        insert_string(
            &mut metadata,
            "otel.instrumentation.scope.version",
            span.instrumentation_scope.version(),
        );

        for attribute in &span.attributes {
            if !self
                .config
                .allowed_attribute_keys
                .contains(attribute.key.as_str())
            {
                continue;
            }
            if let Some(value) = metadata_value_for(attribute) {
                metadata.insert(attribute.key.as_str().to_string(), value);
            }
        }

        sanitized_metadata(metadata)
    }

    fn resource_service_name(&self) -> Option<String> {
        self.resource
            .lock()
            .ok()
            .and_then(|resource| resource.service_name.clone())
    }
}

impl fmt::Debug for LogBrewOpenTelemetrySpanExporter {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LogBrewOpenTelemetrySpanExporter")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl SpanExporter for LogBrewOpenTelemetrySpanExporter {
    async fn export(&self, batch: Vec<SpanData>) -> OTelSdkResult {
        for span in batch {
            self.queue_exported_span(span)?;
        }
        Ok(())
    }

    fn shutdown_with_timeout(&self, _timeout: Duration) -> OTelSdkResult {
        self.shutdown.store(true, Ordering::Relaxed);
        Ok(())
    }

    fn set_resource(&mut self, resource: &Resource) {
        if let Ok(mut snapshot) = self.resource.lock() {
            *snapshot = ResourceSnapshot::from(resource);
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct ResourceSnapshot {
    service_name: Option<String>,
}

impl From<&Resource> for ResourceSnapshot {
    fn from(resource: &Resource) -> Self {
        let service_name = resource
            .get(&Key::from_static_str("service.name"))
            .and_then(value_to_string);
        Self { service_name }
    }
}

fn metadata_value_for(attribute: &KeyValue) -> Option<MetadataValue> {
    match &attribute.value {
        Value::Bool(value) => Some(MetadataValue::Bool(*value)),
        Value::I64(value) => Some(MetadataValue::from(*value)),
        Value::F64(value) => Some(MetadataValue::Number(serde_json::Number::from_f64(*value)?)),
        Value::String(value) => {
            let value = value.as_ref();
            if attribute.key.as_str() == "http.route" {
                let route = sanitize_route_template("http.route", value.to_string()).ok()?;
                Some(MetadataValue::String(route))
            } else {
                Some(MetadataValue::String(value.to_string()))
            }
        }
        Value::Array(_) => None,
        _ => None,
    }
}

fn value_to_string(value: Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.to_string()),
        _ => None,
    }
}

fn insert_string(metadata: &mut Metadata, key: &str, value: Option<&str>) {
    if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
        metadata.insert(key.to_string(), MetadataValue::String(value.to_string()));
    }
}

fn duration_ms(start: SystemTime, end: SystemTime) -> f64 {
    end.duration_since(start)
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn status_label(status: &opentelemetry::trace::Status) -> &'static str {
    match status {
        opentelemetry::trace::Status::Error { .. } => "error",
        opentelemetry::trace::Status::Ok | opentelemetry::trace::Status::Unset => "ok",
    }
}

fn span_kind_label(kind: &opentelemetry::trace::SpanKind) -> &'static str {
    match kind {
        opentelemetry::trace::SpanKind::Client => "client",
        opentelemetry::trace::SpanKind::Server => "server",
        opentelemetry::trace::SpanKind::Producer => "producer",
        opentelemetry::trace::SpanKind::Consumer => "consumer",
        opentelemetry::trace::SpanKind::Internal => "internal",
    }
}
