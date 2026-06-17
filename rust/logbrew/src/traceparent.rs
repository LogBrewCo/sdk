use crate::{SdkError, SpanEvent};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

const ZERO_TRACE_ID: &str = "00000000000000000000000000000000";
const ZERO_SPAN_ID: &str = "0000000000000000";

#[derive(Clone, Debug, PartialEq, Eq)]
/// Parsed W3C traceparent context with normalized lowercase identifiers.
pub struct TraceparentContext {
    /// Two-character W3C traceparent version.
    pub version: String,
    /// Normalized 32-character trace identifier.
    pub trace_id: String,
    /// Normalized upstream parent span identifier.
    pub parent_span_id: String,
    /// Normalized two-character W3C trace flags value.
    pub trace_flags: String,
    /// Whether the W3C sampled bit is set.
    pub sampled: bool,
}

#[derive(Clone, Debug, PartialEq)]
/// Inputs for deriving a LogBrew span event from incoming W3C trace context.
pub struct TraceparentSpanInput {
    name: String,
    span_id: String,
    status: String,
    duration_ms: Option<f64>,
    metadata: Option<Map<String, Value>>,
}

impl TraceparentSpanInput {
    /// Create span input with required span identity and status fields.
    pub fn new(
        name: impl Into<String>,
        span_id: impl Into<String>,
        status: impl Into<String>,
    ) -> Self {
        Self {
            name: name.into(),
            span_id: span_id.into(),
            status: status.into(),
            duration_ms: None,
            metadata: None,
        }
    }

    /// Attach an optional non-negative duration in milliseconds.
    pub fn with_duration_ms(mut self, duration_ms: f64) -> Self {
        self.duration_ms = Some(duration_ms);
        self
    }

    /// Attach primitive, app-owned metadata to the derived span.
    pub fn with_metadata(mut self, metadata: Map<String, Value>) -> Self {
        self.metadata = Some(metadata);
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Dependency-free copy of OpenTelemetry SpanContext fields needed for child span correlation.
pub struct OpenTelemetrySpanContext {
    trace_id: String,
    span_id: String,
    trace_flags: String,
    sampled: bool,
}

impl OpenTelemetrySpanContext {
    /// Create a validated OpenTelemetry-compatible span context from W3C IDs and trace flags.
    pub fn new(
        trace_id: impl AsRef<str>,
        span_id: impl AsRef<str>,
        trace_flags: impl AsRef<str>,
    ) -> Result<Self, SdkError> {
        let normalized_trace_id = trace_id.as_ref().trim().to_ascii_lowercase();
        let normalized_span_id = span_id.as_ref().trim().to_ascii_lowercase();
        let normalized_flags = trace_flags.as_ref().trim().to_ascii_lowercase();
        require_trace_id(&normalized_trace_id)?;
        require_span_id("OpenTelemetry span id", &normalized_span_id)?;
        require_trace_flags(&normalized_flags)?;
        Ok(Self {
            trace_id: normalized_trace_id,
            span_id: normalized_span_id,
            sampled: trace_flags_sampled(&normalized_flags),
            trace_flags: normalized_flags,
        })
    }

    /// Create a context when the app has a sampled boolean but not a trace-flags string.
    pub fn from_sampled(
        trace_id: impl AsRef<str>,
        span_id: impl AsRef<str>,
        sampled: bool,
    ) -> Result<Self, SdkError> {
        Self::new(trace_id, span_id, if sampled { "01" } else { "00" })
    }

    /// Normalized 32-character trace identifier.
    pub fn trace_id(&self) -> &str {
        &self.trace_id
    }

    /// Normalized current or parent span identifier.
    pub fn span_id(&self) -> &str {
        &self.span_id
    }

    /// Normalized two-character trace flags value.
    pub fn trace_flags(&self) -> &str {
        &self.trace_flags
    }

    /// Whether the sampled bit is set.
    pub fn sampled(&self) -> bool {
        self.sampled
    }
}

#[derive(Clone, Debug)]
/// Dependency-free helpers for explicit W3C traceparent interoperability.
pub struct Traceparent;

impl Traceparent {
    /// Parse, validate, and normalize one W3C traceparent value.
    pub fn parse(traceparent: impl AsRef<str>) -> Result<TraceparentContext, SdkError> {
        let normalized = traceparent.as_ref().trim().to_ascii_lowercase();
        if normalized.is_empty() {
            return Err(SdkError::new(
                "validation_error",
                "traceparent must be non-empty",
            ));
        }

        let parts: Vec<&str> = normalized.split('-').collect();
        if parts.len() != 4 {
            return Err(SdkError::new(
                "validation_error",
                "traceparent must have four fields",
            ));
        }
        let version = parts[0].to_string();
        let trace_id = parts[1].to_string();
        let parent_span_id = parts[2].to_string();
        let trace_flags = parts[3].to_string();

        require_version(&version)?;
        require_trace_id(&trace_id)?;
        require_span_id("traceparent parent span id", &parent_span_id)?;
        require_trace_flags(&trace_flags)?;

        let sampled = trace_flags_sampled(&trace_flags);
        Ok(TraceparentContext {
            version,
            trace_id,
            parent_span_id,
            trace_flags,
            sampled,
        })
    }

    /// Create one normalized W3C traceparent value from explicit IDs.
    pub fn create(
        trace_id: impl AsRef<str>,
        span_id: impl AsRef<str>,
        trace_flags: impl AsRef<str>,
    ) -> Result<String, SdkError> {
        let normalized_trace_id = trace_id.as_ref().trim().to_ascii_lowercase();
        let normalized_span_id = span_id.as_ref().trim().to_ascii_lowercase();
        let normalized_flags = trace_flags.as_ref().trim().to_ascii_lowercase();
        require_trace_id(&normalized_trace_id)?;
        require_span_id("traceparent span id", &normalized_span_id)?;
        require_trace_flags(&normalized_flags)?;
        Ok(format!(
            "00-{normalized_trace_id}-{normalized_span_id}-{normalized_flags}"
        ))
    }

    /// Create a one-header outbound carrier containing only `traceparent`.
    pub fn create_headers(
        trace_id: impl AsRef<str>,
        span_id: impl AsRef<str>,
        trace_flags: impl AsRef<str>,
    ) -> Result<BTreeMap<String, String>, SdkError> {
        let mut headers = BTreeMap::new();
        headers.insert(
            "traceparent".to_string(),
            Self::create(trace_id, span_id, trace_flags)?,
        );
        Ok(headers)
    }

    /// Create a one-header outbound carrier from an OpenTelemetry-compatible parent context.
    pub fn create_headers_from_opentelemetry_context(
        context: &OpenTelemetrySpanContext,
        child_span_id: impl AsRef<str>,
    ) -> Result<BTreeMap<String, String>, SdkError> {
        Self::create_headers(context.trace_id(), child_span_id, context.trace_flags())
    }

    /// Build a LogBrew span event that continues an incoming W3C traceparent.
    pub fn span_attributes_from_traceparent(
        traceparent: impl AsRef<str>,
        input: TraceparentSpanInput,
    ) -> Result<SpanEvent, SdkError> {
        let context = Self::parse(traceparent)?;
        Self::span_attributes_from_context(&context, input)
    }

    /// Build a LogBrew span event from previously parsed W3C trace context.
    pub fn span_attributes_from_context(
        context: &TraceparentContext,
        input: TraceparentSpanInput,
    ) -> Result<SpanEvent, SdkError> {
        let span_id = input.span_id.trim().to_ascii_lowercase();
        require_span_id("traceparent child span id", &span_id)?;
        if let Some(metadata) = &input.metadata {
            require_primitive_metadata(metadata)?;
        }

        let mut span = SpanEvent::new(input.name, &context.trace_id, span_id, input.status)
            .with_parent_span_id(&context.parent_span_id);
        if let Some(duration_ms) = input.duration_ms {
            span = span.with_duration_ms(duration_ms);
        }
        if let Some(metadata) = input.metadata {
            span = span.with_metadata(metadata);
        }
        Ok(span)
    }

    /// Build a LogBrew child span from an OpenTelemetry-compatible current span context.
    pub fn span_attributes_from_opentelemetry_context(
        context: &OpenTelemetrySpanContext,
        input: TraceparentSpanInput,
    ) -> Result<SpanEvent, SdkError> {
        let trace_context = Self::context_from_opentelemetry_context(context);
        Self::span_attributes_from_context(&trace_context, input)
    }

    /// Convert OpenTelemetry-compatible IDs into the existing W3C trace context shape.
    pub fn context_from_opentelemetry_context(
        context: &OpenTelemetrySpanContext,
    ) -> TraceparentContext {
        TraceparentContext {
            version: "00".to_string(),
            trace_id: context.trace_id.clone(),
            parent_span_id: context.span_id.clone(),
            trace_flags: context.trace_flags.clone(),
            sampled: context.sampled,
        }
    }
}

fn require_version(version: &str) -> Result<(), SdkError> {
    if version.len() != 2 || !is_lower_hex(version) {
        return Err(SdkError::new(
            "validation_error",
            "traceparent version must be two hex characters",
        ));
    }
    if version == "ff" {
        return Err(SdkError::new(
            "validation_error",
            "traceparent version ff is forbidden",
        ));
    }
    Ok(())
}

fn require_trace_id(trace_id: &str) -> Result<(), SdkError> {
    if trace_id.len() != 32 || !is_lower_hex(trace_id) || trace_id == ZERO_TRACE_ID {
        return Err(SdkError::new(
            "validation_error",
            "traceparent trace id must be 32 non-zero hex characters",
        ));
    }
    Ok(())
}

fn require_span_id(label: &str, span_id: &str) -> Result<(), SdkError> {
    if span_id.len() != 16 || !is_lower_hex(span_id) || span_id == ZERO_SPAN_ID {
        return Err(SdkError::new(
            "validation_error",
            format!("{label} must be 16 non-zero hex characters"),
        ));
    }
    Ok(())
}

fn require_trace_flags(trace_flags: &str) -> Result<(), SdkError> {
    if trace_flags.len() != 2 || !is_lower_hex(trace_flags) {
        return Err(SdkError::new(
            "validation_error",
            "traceparent flags must be two hex characters",
        ));
    }
    Ok(())
}

fn is_lower_hex(value: &str) -> bool {
    value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn trace_flags_sampled(trace_flags: &str) -> bool {
    u8::from_str_radix(trace_flags, 16)
        .map(|flags| flags & 1 == 1)
        .unwrap_or(false)
}

fn require_primitive_metadata(metadata: &Map<String, Value>) -> Result<(), SdkError> {
    for value in metadata.values() {
        match value {
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
            Value::Array(_) | Value::Object(_) => {
                return Err(SdkError::new(
                    "validation_error",
                    "traceparent span metadata values must be primitive",
                ));
            }
        }
    }
    Ok(())
}
