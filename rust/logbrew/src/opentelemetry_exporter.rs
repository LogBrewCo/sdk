use crate::http_fields::duration_millis;
use crate::{
    LogBrewClient, Metadata, MetadataValue, SharedLogBrewClient, SpanEvent, TelemetryContext,
    TelemetryDeployment, TelemetryNamedVersion, TelemetryResource, TelemetryTraceContext,
    http_fields::sanitize_route_template, metadata_safety::sanitized_metadata,
};
use alloc::collections::BTreeSet;
use alloc::sync::Arc;
use core::fmt;
use core::future::ready;
use core::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use core::time::Duration;
use opentelemetry::trace::{SpanKind, Status};
use opentelemetry::{Key, KeyValue, Value};
use opentelemetry_sdk::{
    Resource,
    error::{OTelSdkError, OTelSdkResult},
    trace::{SpanData, SpanExporter},
};
use serde_json::Number;
use std::sync::Mutex;
use std::time::SystemTime;

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
    #[inline]
    pub fn new<Timestamp>(timestamp: Timestamp) -> Self
    where
        Timestamp: Into<String>,
    {
        Self {
            timestamp: timestamp.into(),
            event_id_prefix: "evt_opentelemetry_span".to_owned(),
            allowed_attribute_keys: BTreeSet::new(),
            service_name: None,
            service_version: None,
            deployment_environment: None,
        }
    }

    /// Allow primitive OpenTelemetry attributes to be copied into LogBrew metadata.
    #[must_use]
    #[inline]
    pub fn with_allowed_attribute_keys<I, K>(mut self, keys: I) -> Self
    where
        I: IntoIterator<Item = K>,
        K: Into<String>,
    {
        self.allowed_attribute_keys = keys.into_iter().map(Into::into).collect();
        self
    }

    /// Attach a low-cardinality deployment environment to exported span metadata.
    #[must_use]
    #[inline]
    pub fn with_deployment_environment<DeploymentEnvironment>(
        mut self,
        deployment_environment: DeploymentEnvironment,
    ) -> Self
    where
        DeploymentEnvironment: Into<String>,
    {
        self.deployment_environment = Some(deployment_environment.into());
        self
    }

    /// Override the event ID prefix used before the exporter's monotonic counter.
    #[must_use]
    #[inline]
    pub fn with_event_id_prefix<EventIdPrefix>(mut self, event_id_prefix: EventIdPrefix) -> Self
    where
        EventIdPrefix: Into<String>,
    {
        self.event_id_prefix = event_id_prefix.into();
        self
    }

    /// Attach a low-cardinality service name to exported span metadata.
    #[must_use]
    #[inline]
    pub fn with_service_name<ServiceName>(mut self, service_name: ServiceName) -> Self
    where
        ServiceName: Into<String>,
    {
        self.service_name = Some(service_name.into());
        self
    }

    /// Attach a low-cardinality service version to exported span metadata.
    #[must_use]
    #[inline]
    pub fn with_service_version<ServiceVersion>(mut self, service_version: ServiceVersion) -> Self
    where
        ServiceVersion: Into<String>,
    {
        self.service_version = Some(service_version.into());
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
    fn context_for(&self, span: &SpanData) -> TelemetryContext {
        let snapshot = self
            .resource
            .lock()
            .map(|resource| resource.clone())
            .unwrap_or_default();
        let service_name = self.config.service_name.clone().or(snapshot.service_name);
        let service_version = self
            .config
            .service_version
            .clone()
            .or(snapshot.service_version);
        let deployment_environment = self
            .config
            .deployment_environment
            .clone()
            .or(snapshot.deployment_environment);

        let mut resource = TelemetryResource::new();
        if let Some(name) = service_name {
            let mut service = TelemetryNamedVersion::new(name);
            if let Some(version) = service_version {
                service = service.with_version(version);
            }
            resource = resource.with_service(service);
        }
        if let Some(environment) = deployment_environment {
            resource =
                resource.with_deployment(TelemetryDeployment::new().with_environment(environment));
        }
        let mut trace = TelemetryTraceContext::new(span.span_context.trace_id().to_string())
            .with_span_id(span.span_context.span_id().to_string())
            .with_sampled(span.span_context.is_sampled());
        let parent_span_id = span.parent_span_id.to_string();
        if parent_span_id != "0000000000000000" {
            trace = trace.with_parent_span_id(parent_span_id);
        }
        let mut context = TelemetryContext::new().with_trace(trace);
        if resource.service.is_some() || resource.deployment.is_some() {
            context = context.with_resource(resource);
        }
        context
    }

    fn metadata_for(&self, span: &SpanData) -> Metadata {
        let mut metadata = Metadata::new();
        drop(metadata.insert(
            "source".to_owned(),
            MetadataValue::String("opentelemetry.span_exporter".to_owned()),
        ));
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
        drop(metadata.insert(
            "otel.span.kind".to_owned(),
            MetadataValue::String(span_kind_label(&span.span_kind).to_owned()),
        ));
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
                drop(metadata.insert(attribute.key.as_str().to_owned(), value));
            }
        }

        sanitized_metadata(metadata)
    }

    /// Build an exporter from an app-owned LogBrew client and explicit exporter config.
    #[inline]
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

    fn queue_exported_span(&self, span: &SpanData) -> OTelSdkResult {
        if self.shutdown.load(Ordering::Relaxed) {
            return Err(OTelSdkError::AlreadyShutdown);
        }

        let sequence = self.next_id.fetch_add(1, Ordering::Relaxed);
        let event_id = format!("{}_{}", self.config.event_id_prefix.trim(), sequence);
        let timestamp = self.config.timestamp.clone();
        let span_event = self.span_event(span);
        self.client
            .lock()
            .map_err(|_error| {
                OTelSdkError::InternalFailure("LogBrew OpenTelemetry exporter mutex poison".into())
            })?
            .span(event_id, timestamp, span_event)
            .map_err(|error| OTelSdkError::InternalFailure(error.to_string()))
    }

    fn resource_service_name(&self) -> Option<String> {
        let resource = self.resource.lock().ok()?;
        resource.service_name.clone()
    }

    fn span_event(&self, span: &SpanData) -> SpanEvent {
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
            .with_metadata(self.metadata_for(span))
            .with_context(self.context_for(span))
    }
}

impl fmt::Debug for LogBrewOpenTelemetrySpanExporter {
    #[inline]
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LogBrewOpenTelemetrySpanExporter")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl SpanExporter for LogBrewOpenTelemetrySpanExporter {
    #[inline]
    fn export(&self, batch: Vec<SpanData>) -> impl Future<Output = OTelSdkResult> + Send {
        ready(
            batch
                .iter()
                .try_for_each(|span| self.queue_exported_span(span)),
        )
    }

    #[inline]
    fn set_resource(&mut self, resource: &Resource) {
        if let Ok(mut snapshot) = self.resource.lock() {
            *snapshot = ResourceSnapshot::from(resource);
        }
    }

    #[inline]
    fn shutdown_with_timeout(&self, _timeout: Duration) -> OTelSdkResult {
        self.shutdown.store(true, Ordering::Relaxed);
        Ok(())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct ResourceSnapshot {
    service_name: Option<String>,
    service_version: Option<String>,
    deployment_environment: Option<String>,
}

impl From<&Resource> for ResourceSnapshot {
    fn from(resource: &Resource) -> Self {
        let service_name = resource
            .get(&Key::from_static_str("service.name"))
            .and_then(value_to_string);
        let service_version = resource
            .get(&Key::from_static_str("service.version"))
            .and_then(value_to_string);
        let deployment_environment = resource
            .get(&Key::from_static_str("deployment.environment.name"))
            .and_then(value_to_string)
            .or_else(|| {
                resource
                    .get(&Key::from_static_str("deployment.environment"))
                    .and_then(value_to_string)
            });
        Self {
            service_name,
            service_version,
            deployment_environment,
        }
    }
}

fn metadata_value_for(attribute: &KeyValue) -> Option<MetadataValue> {
    match attribute.value {
        Value::Bool(flag) => Some(MetadataValue::Bool(flag)),
        Value::I64(number) => Some(MetadataValue::from(number)),
        Value::F64(number) => Some(MetadataValue::Number(Number::from_f64(number)?)),
        Value::String(ref text) => {
            if attribute.key.as_str() == "http.route" {
                let route = sanitize_route_template("http.route", text.as_str()).ok()?;
                Some(MetadataValue::String(route))
            } else {
                Some(MetadataValue::String(text.as_str().to_owned()))
            }
        }
        Value::Array(_) | _ => None,
    }
}

fn value_to_string(value: Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.to_string()),
        Value::Bool(_) | Value::I64(_) | Value::F64(_) | Value::Array(_) | _ => None,
    }
}

fn insert_string(metadata: &mut Metadata, key: &str, value: Option<&str>) {
    if let Some(trimmed) = value.map(str::trim).filter(|text| !text.is_empty()) {
        drop(metadata.insert(key.to_owned(), MetadataValue::String(trimmed.to_owned())));
    }
}

fn duration_ms(start: SystemTime, end: SystemTime) -> f64 {
    end.duration_since(start).map_or(0.0, duration_millis)
}

const fn status_label(status: &Status) -> &'static str {
    if matches!(*status, Status::Ok | Status::Unset) {
        "ok"
    } else {
        "error"
    }
}

const fn span_kind_label(kind: &SpanKind) -> &'static str {
    match *kind {
        SpanKind::Client => "client",
        SpanKind::Server => "server",
        SpanKind::Producer => "producer",
        SpanKind::Consumer => "consumer",
        SpanKind::Internal => "internal",
    }
}
