use crate::{SdkError, SpanEvent, TelemetryContext, TelemetryTraceContext};
use alloc::collections::BTreeMap;
use serde_json::{Map, Value};

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
    #[inline]
    pub fn new<Name, SpanIdInput, Status>(name: Name, span_id: SpanIdInput, status: Status) -> Self
    where
        Name: Into<String>,
        SpanIdInput: Into<String>,
        Status: Into<String>,
    {
        Self {
            name: name.into(),
            span_id: span_id.into(),
            status: status.into(),
            duration_ms: None,
            metadata: None,
        }
    }

    /// Attach an optional non-negative duration in milliseconds.
    #[must_use]
    #[inline]
    pub const fn with_duration_ms(mut self, duration_ms: f64) -> Self {
        self.duration_ms = Some(duration_ms);
        self
    }

    /// Attach primitive, app-owned metadata to the derived span.
    #[must_use]
    #[inline]
    pub fn with_metadata(mut self, metadata: Map<String, Value>) -> Self {
        self.metadata = Some(metadata);
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Dependency-free copy of OpenTelemetry `SpanContext` fields needed for child span correlation.
pub struct OpenTelemetrySpanContext {
    trace_id: String,
    span_id: String,
    trace_flags: String,
    sampled: bool,
}

impl OpenTelemetrySpanContext {
    /// Create a context when the app has a sampled boolean but not a trace-flags string.
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when an input fails validation.
    #[inline]
    pub fn from_sampled<TraceIdInput, SpanIdInput>(
        trace_id: TraceIdInput,
        span_id: SpanIdInput,
        sampled: bool,
    ) -> Result<Self, SdkError>
    where
        TraceIdInput: AsRef<str>,
        SpanIdInput: AsRef<str>,
    {
        Self::new(trace_id, span_id, if sampled { "01" } else { "00" })
    }

    /// Create a validated OpenTelemetry-compatible span context from W3C IDs and trace flags.
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when an input fails validation.
    #[inline]
    pub fn new<TraceIdInput, SpanIdInput, TraceFlagsInput>(
        trace_id: TraceIdInput,
        span_id: SpanIdInput,
        trace_flags: TraceFlagsInput,
    ) -> Result<Self, SdkError>
    where
        TraceIdInput: AsRef<str>,
        SpanIdInput: AsRef<str>,
        TraceFlagsInput: AsRef<str>,
    {
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

    /// Whether the sampled bit is set.
    #[must_use]
    #[inline]
    pub const fn sampled(&self) -> bool {
        self.sampled
    }

    /// Normalized current or parent span identifier.
    #[must_use]
    #[inline]
    pub fn span_id(&self) -> &str {
        &self.span_id
    }

    /// Normalized two-character trace flags value.
    #[must_use]
    #[inline]
    pub fn trace_flags(&self) -> &str {
        &self.trace_flags
    }

    /// Normalized 32-character trace identifier.
    #[must_use]
    #[inline]
    pub fn trace_id(&self) -> &str {
        &self.trace_id
    }
}

#[derive(Clone, Copy, Debug)]
/// Dependency-free helpers for explicit W3C traceparent interoperability.
pub struct Traceparent;

impl Traceparent {
    /// Convert OpenTelemetry-compatible IDs into the existing W3C trace context shape.
    #[must_use]
    #[inline]
    pub fn context_from_opentelemetry_context(
        context: &OpenTelemetrySpanContext,
    ) -> TraceparentContext {
        TraceparentContext {
            version: "00".to_owned(),
            trace_id: context.trace_id.clone(),
            parent_span_id: context.span_id.clone(),
            trace_flags: context.trace_flags.clone(),
            sampled: context.sampled,
        }
    }

    /// Create one normalized W3C traceparent value from explicit IDs.
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when an input fails validation.
    #[inline]
    pub fn create<TraceIdInput, SpanIdInput, TraceFlagsInput>(
        trace_id: TraceIdInput,
        span_id: SpanIdInput,
        trace_flags: TraceFlagsInput,
    ) -> Result<String, SdkError>
    where
        TraceIdInput: AsRef<str>,
        SpanIdInput: AsRef<str>,
        TraceFlagsInput: AsRef<str>,
    {
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
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when an input fails validation.
    #[inline]
    pub fn create_headers<TraceId, SpanId, TraceFlags>(
        trace_id: TraceId,
        span_id: SpanId,
        trace_flags: TraceFlags,
    ) -> Result<BTreeMap<String, String>, SdkError>
    where
        TraceId: AsRef<str>,
        SpanId: AsRef<str>,
        TraceFlags: AsRef<str>,
    {
        let mut headers = BTreeMap::new();
        drop(headers.insert(
            "traceparent".to_owned(),
            Self::create(trace_id, span_id, trace_flags)?,
        ));
        Ok(headers)
    }

    /// Create a one-header outbound carrier from an OpenTelemetry-compatible parent context.
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when an input fails validation.
    #[inline]
    pub fn create_headers_from_opentelemetry_context<ChildSpanId>(
        context: &OpenTelemetrySpanContext,
        child_span_id: ChildSpanId,
    ) -> Result<BTreeMap<String, String>, SdkError>
    where
        ChildSpanId: AsRef<str>,
    {
        Self::create_headers(context.trace_id(), child_span_id, context.trace_flags())
    }

    /// Parse, validate, and normalize one W3C traceparent value.
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when an input fails validation.
    #[inline]
    pub fn parse<TraceparentInput>(
        traceparent: TraceparentInput,
    ) -> Result<TraceparentContext, SdkError>
    where
        TraceparentInput: AsRef<str>,
    {
        let normalized = traceparent.as_ref().trim().to_ascii_lowercase();
        if normalized.is_empty() {
            return Err(SdkError::new(
                "validation_error",
                "traceparent must be non-empty",
            ));
        }

        let parts: Vec<&str> = normalized.split('-').collect();
        let &[version_part, trace_id_part, parent_part, flags_part] = parts.as_slice() else {
            return Err(SdkError::new(
                "validation_error",
                "traceparent must have four fields",
            ));
        };
        let version = version_part.to_owned();
        let trace_id = trace_id_part.to_owned();
        let parent_span_id = parent_part.to_owned();
        let trace_flags = flags_part.to_owned();

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

    /// Build a LogBrew span event from previously parsed W3C trace context.
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when an input fails validation.
    #[inline]
    pub fn span_attributes_from_context(
        context: &TraceparentContext,
        input: TraceparentSpanInput,
    ) -> Result<SpanEvent, SdkError> {
        let span_id = input.span_id.trim().to_ascii_lowercase();
        require_span_id("traceparent child span id", &span_id)?;
        if let Some(metadata) = input.metadata.as_ref() {
            require_primitive_metadata(metadata)?;
        }

        let mut span = SpanEvent::new(input.name, &context.trace_id, &span_id, input.status)
            .with_parent_span_id(&context.parent_span_id);
        if let Some(duration_ms) = input.duration_ms {
            span = span.with_duration_ms(duration_ms);
        }
        if let Some(metadata) = input.metadata {
            span = span.with_metadata(metadata);
        }
        let telemetry_context = TelemetryContext::new().with_trace(
            TelemetryTraceContext::new(&context.trace_id)
                .with_span_id(&span_id)
                .with_parent_span_id(&context.parent_span_id)
                .with_sampled(context.sampled),
        );
        Ok(span.with_context(telemetry_context))
    }

    /// Build a LogBrew child span from an OpenTelemetry-compatible current span context.
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when an input fails validation.
    #[inline]
    pub fn span_attributes_from_opentelemetry_context(
        context: &OpenTelemetrySpanContext,
        input: TraceparentSpanInput,
    ) -> Result<SpanEvent, SdkError> {
        let trace_context = Self::context_from_opentelemetry_context(context);
        Self::span_attributes_from_context(&trace_context, input)
    }

    /// Build a LogBrew span event that continues an incoming W3C traceparent.
    ///
    /// # Errors
    ///
    /// Returns an [`SdkError`] when an input fails validation.
    #[inline]
    pub fn span_attributes_from_traceparent<TraceparentInput>(
        traceparent: TraceparentInput,
        input: TraceparentSpanInput,
    ) -> Result<SpanEvent, SdkError>
    where
        TraceparentInput: AsRef<str>,
    {
        let context = Self::parse(traceparent)?;
        Self::span_attributes_from_context(&context, input)
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
    u8::from_str_radix(trace_flags, 16).is_ok_and(|flags| flags & 1 == 1)
}

fn require_primitive_metadata(metadata: &Map<String, Value>) -> Result<(), SdkError> {
    for value in metadata.values() {
        match *value {
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
