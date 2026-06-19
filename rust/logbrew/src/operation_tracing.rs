use crate::{
    Metadata, OpenTelemetrySpanContext, SdkError, SpanEvent, Traceparent, TraceparentContext,
};
use serde_json::{Map, Value};

const UNSAFE_KEY_PARTS: &[&str] = &[
    "authorization",
    "body",
    "broker",
    "command",
    "connection",
    "cookie",
    "dsn",
    "header",
    "host",
    "jobid",
    "key",
    "message",
    "param",
    concat!("pass", "word"),
    "payload",
    "query",
    concat!("sec", "ret"),
    "sql",
    "statement",
    concat!("to", "ken"),
    "url",
    "user",
    "value",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
/// Dependency operation category used for low-cardinality span metadata.
pub enum DependencyOperationKind {
    /// Database, ORM, or query-like work owned by the app.
    Database,
    /// Cache, key-value, or memoization work owned by the app.
    Cache,
    /// Queue, job, stream, or broker work owned by the app.
    Queue,
}

impl DependencyOperationKind {
    fn source(self) -> &'static str {
        match self {
            Self::Database => "database.operation",
            Self::Cache => "cache.operation",
            Self::Queue => "queue.operation",
        }
    }

    fn prefix(self) -> &'static str {
        match self {
            Self::Database => "db",
            Self::Cache => "cache",
            Self::Queue => "messaging",
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
    /// Create a database operation span builder with app-owned low-cardinality IDs.
    pub fn database(name: impl Into<String>, span_id: impl Into<String>) -> Self {
        Self::new(DependencyOperationKind::Database, name, span_id)
    }

    /// Create a cache operation span builder with app-owned low-cardinality IDs.
    pub fn cache(name: impl Into<String>, span_id: impl Into<String>) -> Self {
        Self::new(DependencyOperationKind::Cache, name, span_id)
    }

    /// Create a queue operation span builder with app-owned low-cardinality IDs.
    pub fn queue(name: impl Into<String>, span_id: impl Into<String>) -> Self {
        Self::new(DependencyOperationKind::Queue, name, span_id)
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
            status: "ok".to_string(),
            duration_ms: None,
            system: None,
            operation: None,
            target: None,
            error_type: None,
            metadata: Map::new(),
        }
    }

    /// Override the operation status. Valid values are `ok` and `error`.
    pub fn with_status(mut self, status: impl Into<String>) -> Self {
        self.status = status.into();
        self
    }

    /// Attach an optional non-negative duration in milliseconds.
    pub fn with_duration_ms(mut self, duration_ms: f64) -> Self {
        self.duration_ms = Some(duration_ms);
        self
    }

    /// Attach the dependency system, such as `postgres`, `redis`, or `sqs`.
    pub fn with_system(mut self, system: impl Into<String>) -> Self {
        self.system = Some(system.into());
        self
    }

    /// Attach the low-cardinality operation, such as `select`, `get`, or `publish`.
    pub fn with_operation(mut self, operation: impl Into<String>) -> Self {
        self.operation = Some(operation.into());
        self
    }

    /// Attach a low-cardinality target, such as a table, cache region, or queue name.
    pub fn with_target(mut self, target: impl Into<String>) -> Self {
        self.target = Some(target.into());
        self
    }

    /// Mark the span as failed and attach only the public exception type name.
    pub fn with_error_type(mut self, error_type: impl Into<String>) -> Self {
        self.status = "error".to_string();
        self.error_type = Some(error_type.into());
        self
    }

    /// Attach primitive app-owned metadata; unsafe key names and non-primitives are dropped.
    pub fn with_metadata(mut self, metadata: Metadata) -> Self {
        self.metadata = sanitized_metadata(metadata);
        self
    }

    /// Build a normal LogBrew span event from an incoming W3C traceparent context.
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

    /// Build a normal LogBrew span event from an OpenTelemetry-compatible current span.
    pub fn from_opentelemetry_context(
        self,
        context: &OpenTelemetrySpanContext,
    ) -> Result<SpanEvent, SdkError> {
        let trace_context = Traceparent::context_from_opentelemetry_context(context);
        self.from_traceparent_context(&trace_context)
    }

    fn span_name(&self) -> String {
        format!("{}:{}", self.kind.source(), self.name.trim())
    }

    fn metadata(&self) -> Metadata {
        let mut metadata = self.metadata.clone();
        metadata.insert(
            "source".to_string(),
            Value::String(self.kind.source().to_string()),
        );
        insert_string(
            &mut metadata,
            format!("{}.system", self.kind.prefix()),
            &self.system,
        );
        insert_string(
            &mut metadata,
            format!("{}.operation", self.kind.prefix()),
            &self.operation,
        );
        insert_string(
            &mut metadata,
            format!("{}.target", self.kind.prefix()),
            &self.target,
        );
        insert_string(&mut metadata, "exception.type", &self.error_type);
        metadata
    }
}

fn insert_string(metadata: &mut Metadata, key: impl Into<String>, value: &Option<String>) {
    if let Some(value) = value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        metadata.insert(key.into(), Value::String(value.to_string()));
    }
}

fn sanitized_metadata(metadata: Metadata) -> Metadata {
    metadata
        .into_iter()
        .filter(|(key, value)| is_safe_key(key) && value_is_primitive(value))
        .collect()
}

fn is_safe_key(key: &str) -> bool {
    let normalized = normalized_key(key);
    !UNSAFE_KEY_PARTS
        .iter()
        .any(|part| normalized.contains(part))
}

fn normalized_key(key: &str) -> String {
    key.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn value_is_primitive(value: &Value) -> bool {
    matches!(
        value,
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
    )
}
