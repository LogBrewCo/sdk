use crate::http_fields::duration_millis;
use crate::metadata_safety::sanitized_metadata;
use crate::{
    Metadata, OpenTelemetrySpanContext, SdkError, SpanEvent, Traceparent, TraceparentContext,
};
use core::any::Any;
use core::panic::UnwindSafe;
use serde_json::{Map, Value};
use std::panic::{catch_unwind, resume_unwind};
use std::time::Instant;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
/// Dependency operation category used for low-cardinality span metadata.
pub enum DependencyOperationKind {
    /// Cache, key-value, or memoization work owned by the app.
    Cache,
    /// Database, ORM, or query-like work owned by the app.
    Database,
    /// Queue, job, stream, or broker work owned by the app.
    Queue,
}

impl DependencyOperationKind {
    const fn prefix(self) -> &'static str {
        match self {
            Self::Database => "db",
            Self::Cache => "cache",
            Self::Queue => "messaging",
        }
    }

    const fn source(self) -> &'static str {
        match self {
            Self::Database => "database.operation",
            Self::Cache => "cache.operation",
            Self::Queue => "queue.operation",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
/// Explicit dependency span builder for DB, cache, and queue work.
pub struct DependencyOperationSpan {
    kind: DependencyOperationKind,
    name: String,
    span_id: String,
    status: String,
    duration_ms: Option<f64>,
    system: Option<String>,
    operation: Option<String>,
    target: Option<String>,
    error_type: Option<String>,
    metadata: Metadata,
}

impl DependencyOperationSpan {
    /// Create a cache operation span builder with app-owned low-cardinality IDs.
    #[inline]
    pub fn cache<NameInput, SpanIdInput>(name: NameInput, span_id: SpanIdInput) -> Self
    where
        NameInput: Into<String>,
        SpanIdInput: Into<String>,
    {
        Self::new(DependencyOperationKind::Cache, name, span_id)
    }

    /// Run app-owned dependency work, queue one span, and resume the original unwind on panic.
    #[inline]
    pub fn capture_panic<F, R, EventId, Timestamp>(
        self,
        client: &mut crate::LogBrewClient,
        event_id: EventId,
        timestamp: Timestamp,
        context: &TraceparentContext,
        operation: F,
    ) -> R
    where
        F: FnOnce() -> R + UnwindSafe,
        EventId: AsRef<str>,
        Timestamp: AsRef<str>,
    {
        let started = Instant::now();
        let result = catch_unwind(operation);
        let duration_ms = duration_millis(started.elapsed());

        match result {
            Ok(value) => {
                self.queue_capture_span(
                    client,
                    event_id.as_ref(),
                    timestamp.as_ref(),
                    context,
                    duration_ms,
                    None,
                );
                value
            }
            Err(payload) => {
                let panic_type = panic_payload_type(payload.as_ref());
                self.queue_capture_span(
                    client,
                    event_id.as_ref(),
                    timestamp.as_ref(),
                    context,
                    duration_ms,
                    Some(panic_type),
                );
                resume_unwind(payload);
            }
        }
    }

    /// Create a database operation span builder with app-owned low-cardinality IDs.
    #[inline]
    pub fn database<NameInput, SpanIdInput>(name: NameInput, span_id: SpanIdInput) -> Self
    where
        NameInput: Into<String>,
        SpanIdInput: Into<String>,
    {
        Self::new(DependencyOperationKind::Database, name, span_id)
    }

    /// Build a normal LogBrew span event from an OpenTelemetry-compatible current span.
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when an input fails validation.
    #[inline]
    pub fn from_opentelemetry_context(
        self,
        context: &OpenTelemetrySpanContext,
    ) -> Result<SpanEvent, SdkError> {
        let trace_context = Traceparent::context_from_opentelemetry_context(context);
        self.from_traceparent_context(&trace_context)
    }

    /// Build a normal LogBrew span event from an incoming W3C traceparent context.
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when an input fails validation.
    #[inline]
    pub fn from_traceparent_context(
        self,
        context: &TraceparentContext,
    ) -> Result<SpanEvent, SdkError> {
        let metadata = self.metadata();
        let mut span = Traceparent::span_attributes_from_context(
            context,
            crate::TraceparentSpanInput::new(self.span_name(), self.span_id, self.status),
        )?;
        if let Some(duration_ms) = self.duration_ms {
            span = span.with_duration_ms(duration_ms);
        }
        Ok(span.with_metadata(metadata))
    }

    fn metadata(&self) -> Metadata {
        let mut metadata = self.metadata.clone();
        drop(metadata.insert(
            "source".to_owned(),
            Value::String(self.kind.source().to_owned()),
        ));
        insert_string(
            &mut metadata,
            format!("{}.system", self.kind.prefix()),
            self.system.as_deref(),
        );
        insert_string(
            &mut metadata,
            format!("{}.operation", self.kind.prefix()),
            self.operation.as_deref(),
        );
        insert_string(
            &mut metadata,
            format!("{}.target", self.kind.prefix()),
            self.target.as_deref(),
        );
        insert_string(&mut metadata, "exception.type", self.error_type.as_deref());
        metadata
    }

    fn new(
        kind: DependencyOperationKind,
        name: impl Into<String>,
        span_id: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            name: name.into(),
            span_id: span_id.into(),
            status: "ok".to_owned(),
            duration_ms: None,
            system: None,
            operation: None,
            target: None,
            error_type: None,
            metadata: Map::new(),
        }
    }

    /// Create a queue operation span builder with app-owned low-cardinality IDs.
    #[inline]
    pub fn queue<Name, SpanId>(name: Name, span_id: SpanId) -> Self
    where
        Name: Into<String>,
        SpanId: Into<String>,
    {
        Self::new(DependencyOperationKind::Queue, name, span_id)
    }

    fn queue_capture_span(
        mut self,
        client: &mut crate::LogBrewClient,
        event_id: &str,
        timestamp: &str,
        context: &TraceparentContext,
        duration_ms: f64,
        panic_type: Option<&'static str>,
    ) {
        self.duration_ms = Some(duration_ms);
        if let Some(kind) = panic_type {
            "error".clone_into(&mut self.status);
            self.error_type = Some("panic".to_owned());
            drop(self.metadata.insert("panic".to_owned(), Value::Bool(true)));
            drop(
                self.metadata
                    .insert("panicType".to_owned(), Value::String(kind.to_owned())),
            );
        }
        if let Ok(span) = self.from_traceparent_context(context) {
            drop(client.span(event_id, timestamp, span));
        }
    }

    fn span_name(&self) -> String {
        format!("{}:{}", self.kind.source(), self.name.trim())
    }

    /// Attach an optional non-negative duration in milliseconds.
    #[must_use]
    #[inline]
    pub const fn with_duration_ms(mut self, duration_ms: f64) -> Self {
        self.duration_ms = Some(duration_ms);
        self
    }

    /// Mark the span as failed and attach only the public exception type name.
    #[must_use]
    #[inline]
    pub fn with_error_type<ErrorType>(mut self, error_type: ErrorType) -> Self
    where
        ErrorType: Into<String>,
    {
        "error".clone_into(&mut self.status);
        self.error_type = Some(error_type.into());
        self
    }

    /// Attach primitive app-owned metadata; unsafe key names and non-primitives are dropped.
    #[must_use]
    #[inline]
    pub fn with_metadata(mut self, metadata: Metadata) -> Self {
        self.metadata = sanitized_metadata(metadata);
        self
    }

    /// Attach the low-cardinality operation, such as `select`, `get`, or `publish`.
    #[must_use]
    #[inline]
    pub fn with_operation<Operation>(mut self, operation: Operation) -> Self
    where
        Operation: Into<String>,
    {
        self.operation = Some(operation.into());
        self
    }

    /// Override the operation status. Valid values are `ok` and `error`.
    #[must_use]
    #[inline]
    pub fn with_status<Status>(mut self, status: Status) -> Self
    where
        Status: Into<String>,
    {
        self.status = status.into();
        self
    }

    /// Attach the dependency system, such as `postgres`, `redis`, or `sqs`.
    #[must_use]
    #[inline]
    pub fn with_system<System>(mut self, system: System) -> Self
    where
        System: Into<String>,
    {
        self.system = Some(system.into());
        self
    }

    /// Attach a low-cardinality target, such as a table, cache region, or queue name.
    #[must_use]
    #[inline]
    pub fn with_target<Target>(mut self, target: Target) -> Self
    where
        Target: Into<String>,
    {
        self.target = Some(target.into());
        self
    }
}

fn insert_string(metadata: &mut Metadata, key: impl Into<String>, value: Option<&str>) {
    if let Some(trimmed) = value.map(str::trim).filter(|text| !text.is_empty()) {
        drop(metadata.insert(key.into(), Value::String(trimmed.to_owned())));
    }
}

fn panic_payload_type(payload: &(dyn Any + Send)) -> &'static str {
    if payload.is::<&'static str>() {
        "&str"
    } else if payload.is::<String>() {
        "String"
    } else {
        "unknown"
    }
}
