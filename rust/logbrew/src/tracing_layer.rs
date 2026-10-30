#[cfg(feature = "tracing-opentelemetry")]
use crate::OpenTelemetrySpanContext;
use crate::http_fields::duration_millis;
use crate::issue_diagnostics::sanitize_filename;
use crate::telemetry_context::merge_captured_contexts;
use crate::{
    IssueEvent, LogEvent, Metadata, MetadataValue, SharedLogBrewClient, SpanEvent,
    TelemetryContext, TelemetryNamedVersion, TelemetryResource, TelemetryTraceContext, Traceparent,
    TraceparentContext, http_fields::sanitize_route_template,
};
use alloc::sync::Arc;
use core::fmt;
use core::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;
use tracing_core::{
    Event as TracingEvent, Level, Subscriber,
    field::{Field, Visit},
    span::{Attributes, Id, Record},
};
use tracing_subscriber::{Layer, layer::Context, registry::LookupSpan};

/// Optional `tracing` layer that converts app log events into LogBrew log events.
#[derive(Clone)]
pub struct LogBrewTracingLayer<T> {
    client: SharedLogBrewClient,
    timestamp: T,
    allowed_fields: Vec<String>,
    event_id_prefix: String,
    span_id_prefix: String,
    next_id: Arc<AtomicU64>,
    next_span_id: Arc<AtomicU64>,
    logger_name: Option<String>,
    capture_spans: bool,
    capture_error_issues: bool,
    context: Option<TelemetryContext>,
}

impl<T> fmt::Debug for LogBrewTracingLayer<T> {
    #[inline]
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LogBrewTracingLayer")
            .field("allowed_fields", &self.allowed_fields)
            .field("event_id_prefix", &self.event_id_prefix)
            .field("span_id_prefix", &self.span_id_prefix)
            .field("logger_name", &self.logger_name)
            .field("capture_spans", &self.capture_spans)
            .field("capture_error_issues", &self.capture_error_issues)
            .field("context", &self.context)
            .finish_non_exhaustive()
    }
}

impl<T> LogBrewTracingLayer<T> {
    /// Build a `tracing` layer from an app-owned LogBrew client and timestamp source.
    #[inline]
    pub fn new(client: SharedLogBrewClient, timestamp: T) -> Self {
        Self {
            client,
            timestamp,
            allowed_fields: Vec::new(),
            event_id_prefix: "evt_tracing_log".to_owned(),
            span_id_prefix: "evt_tracing_span".to_owned(),
            next_id: Arc::new(AtomicU64::new(1)),
            next_span_id: Arc::new(AtomicU64::new(1)),
            logger_name: None,
            capture_spans: false,
            capture_error_issues: false,
            context: None,
        }
    }

    /// Allowlist primitive event and span fields copied into LogBrew metadata.
    #[must_use]
    #[inline]
    pub fn with_allowed_fields<I, F>(mut self, fields: I) -> Self
    where
        I: IntoIterator<Item = F>,
        F: Into<String>,
    {
        self.allowed_fields = fields.into_iter().map(Into::into).collect();
        self
    }

    /// Attach shared service, deployment, application, session, subject, or tag context.
    #[must_use]
    #[inline]
    pub fn with_context(mut self, context: TelemetryContext) -> Self {
        self.context = Some(context);
        self
    }

    /// Opt in to a message-based Issue for each error-level `tracing` event.
    #[must_use]
    #[inline]
    pub const fn with_error_issues(mut self) -> Self {
        self.capture_error_issues = true;
        self
    }

    /// Override the event ID prefix used before the layer's monotonic counter.
    #[must_use]
    #[inline]
    pub fn with_event_id_prefix<PrefixInput>(mut self, prefix: PrefixInput) -> Self
    where
        PrefixInput: Into<String>,
    {
        self.event_id_prefix = prefix.into();
        self
    }

    /// Override the logger name attached to converted LogBrew log events.
    #[must_use]
    #[inline]
    pub fn with_logger<Logger>(mut self, logger: Logger) -> Self
    where
        Logger: Into<String>,
    {
        self.logger_name = Some(logger.into());
        self
    }

    /// Opt in to converting closed `tracing` spans into LogBrew span events.
    #[must_use]
    #[inline]
    pub const fn with_span_events(mut self) -> Self {
        self.capture_spans = true;
        self
    }

    /// Override the span event ID prefix used before the layer's monotonic counter.
    #[must_use]
    #[inline]
    pub fn with_span_id_prefix<Prefix>(mut self, prefix: Prefix) -> Self
    where
        Prefix: Into<String>,
    {
        self.span_id_prefix = prefix.into();
        self
    }
}

impl<S, T> Layer<S> for LogBrewTracingLayer<T>
where
    S: Subscriber + for<'lookup> LookupSpan<'lookup>,
    T: Fn() -> String + Clone + Send + Sync + 'static,
{
    #[inline]
    fn on_close(&self, id: Id, ctx: Context<'_, S>) {
        if !self.capture_spans {
            return;
        }

        let Some(span) = ctx.span(&id) else {
            return;
        };
        let Some(state) = span.extensions_mut().remove::<TracingSpanState>() else {
            return;
        };
        let reference = SpanReference::from(&state);
        let Ok(context) = tracing_event_context(Some(&reference), self.context.as_ref()) else {
            return;
        };

        let span_metadata = span_metadata_with_event_summary(&state);
        let mut event = SpanEvent::new(
            state.name,
            state.trace_id,
            state.span_id,
            if state.error { "error" } else { "ok" },
        )
        .with_duration_ms(duration_millis(state.started_at.elapsed()))
        .with_metadata(span_metadata)
        .with_context(context);
        if let Some(parent_span_id) = state.parent_span_id {
            event = event.with_parent_span_id(parent_span_id);
        }

        if let Ok(mut client) = self.client.lock() {
            drop(client.span(state.event_id, state.timestamp, event));
        }
    }

    #[inline]
    fn on_event(&self, event: &TracingEvent<'_>, ctx: Context<'_, S>) {
        let metadata = event.metadata();
        let mut visitor = TracingLogVisitor::new(&self.allowed_fields);
        event.record(&mut visitor);

        let message = visitor
            .message
            .unwrap_or_else(|| "tracing event".to_owned());
        let mut log_metadata = visitor.metadata;
        let correlation = current_event_span_correlation(event, &ctx);
        if let Some(state) = correlation.as_ref() {
            state.extend_metadata(&mut log_metadata);
        }
        insert_callsite_metadata(&mut log_metadata, metadata);

        let logger = self
            .logger_name
            .as_deref()
            .unwrap_or_else(|| metadata.target())
            .trim()
            .to_owned();
        let Ok(context) = tracing_event_context(correlation.as_ref(), self.context.as_ref()) else {
            return;
        };
        let issue = (self.capture_error_issues && *metadata.level() == Level::ERROR).then(|| {
            tracing_error_issue(&message, metadata, log_metadata.clone(), context.clone())
        });
        let level = match *metadata.level() {
            Level::ERROR => "error",
            Level::WARN => "warning",
            _ => "info",
        };
        let mut log = LogEvent::new(message, level)
            .with_metadata(log_metadata)
            .with_context(context);
        if !logger.is_empty() {
            log = log.with_logger(logger);
        }

        let sequence = self.next_id.fetch_add(1, Ordering::Relaxed);
        let event_id = format!("{}_{}", self.event_id_prefix.trim(), sequence);
        let timestamp = (self.timestamp)();
        if let Ok(mut client) = self.client.lock() {
            drop(client.log(&event_id, &timestamp, log));
            if let Some(issue_event) = issue {
                drop(client.issue(format!("{event_id}_issue"), timestamp, issue_event));
            }
        }

        if self.capture_spans {
            record_current_span_event(event, &ctx);
        }
    }

    #[inline]
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        if !self.capture_spans {
            return;
        }

        let metadata = attrs.metadata();
        let mut visitor = TracingLogVisitor::new(&self.allowed_fields);
        attrs.record(&mut visitor);
        let parent = parent_span_reference(attrs, &ctx).or_else(|| {
            incoming_trace_context(&visitor).map(|trace| SpanReference {
                trace_id: trace.trace_id,
                span_id: trace.parent_span_id,
                parent_span_id: None,
                sampled: Some(trace.sampled),
            })
        });
        let mut span_metadata = visitor.metadata;
        insert_callsite_metadata(&mut span_metadata, metadata);
        let sequence = self.next_span_id.fetch_add(1, Ordering::Relaxed);
        let sampled = parent.as_ref().and_then(|state| state.sampled);
        if let Some(flag) = sampled
            && !span_metadata.contains_key("sampled")
        {
            drop(span_metadata.insert("sampled".to_owned(), MetadataValue::Bool(flag)));
        }
        let state = TracingSpanState {
            event_id: format!("{}_{}", self.span_id_prefix.trim(), sequence),
            trace_id: parent.as_ref().map_or_else(
                || format!("{:032x}", u128::from(sequence)),
                |state| state.trace_id.clone(),
            ),
            span_id: format!("{sequence:016x}"),
            parent_span_id: parent.map(|state| state.span_id),
            name: metadata.name().trim().to_owned(),
            timestamp: (self.timestamp)(),
            started_at: Instant::now(),
            metadata: span_metadata,
            sampled,
            error: false,
            event_count: 0,
            error_event_count: 0,
            last_error_target: None,
        };

        if let Some(span) = ctx.span(id) {
            span.extensions_mut().insert(state);
        }
    }

    #[inline]
    fn on_record(&self, id: &Id, values: &Record<'_>, ctx: Context<'_, S>) {
        if !self.capture_spans {
            return;
        }

        let Some(span) = ctx.span(id) else {
            return;
        };

        let mut visitor = TracingLogVisitor::new(&self.allowed_fields);
        values.record(&mut visitor);
        if let Some(state) = span.extensions_mut().get_mut::<TracingSpanState>() {
            state.metadata.extend(visitor.metadata);
        }
    }
}

#[derive(Debug)]
struct TracingSpanState {
    event_id: String,
    trace_id: String,
    span_id: String,
    parent_span_id: Option<String>,
    name: String,
    timestamp: String,
    started_at: Instant,
    metadata: Metadata,
    sampled: Option<bool>,
    error: bool,
    event_count: u64,
    error_event_count: u64,
    last_error_target: Option<String>,
}

#[derive(Clone, Debug)]
struct SpanReference {
    trace_id: String,
    span_id: String,
    parent_span_id: Option<String>,
    sampled: Option<bool>,
}

impl From<&TracingSpanState> for SpanReference {
    fn from(state: &TracingSpanState) -> Self {
        Self {
            trace_id: state.trace_id.clone(),
            span_id: state.span_id.clone(),
            parent_span_id: state.parent_span_id.clone(),
            sampled: state.sampled,
        }
    }
}

impl SpanReference {
    fn extend_metadata(&self, metadata: &mut Metadata) {
        metadata.extend([
            ("traceId".into(), self.trace_id.clone().into()),
            ("spanId".into(), self.span_id.clone().into()),
        ]);
        if let Some(value) = self.parent_span_id.as_ref() {
            drop(metadata.insert("parentSpanId".into(), value.clone().into()));
        }
        if let Some(value) = self.sampled
            && !metadata.contains_key("sampled")
        {
            drop(metadata.insert("sampled".into(), value.into()));
        }
    }
}

struct TracingLogVisitor<'fields> {
    allowed_fields: &'fields [String],
    message: Option<String>,
    metadata: Metadata,
    traceparent: Option<String>,
}

impl<'fields> TracingLogVisitor<'fields> {
    fn allows(&self, field: &Field) -> bool {
        self.allowed_fields
            .iter()
            .any(|allowed| allowed == field.name())
    }

    fn new(allowed_fields: &'fields [String]) -> Self {
        Self {
            allowed_fields,
            message: None,
            metadata: Metadata::new(),
            traceparent: None,
        }
    }

    fn record_string(&mut self, field: &Field, value: String) {
        if is_traceparent_field(field.name()) {
            self.traceparent = Some(value);
            return;
        }
        if field.name() == "message" {
            self.message = Some(value);
            return;
        }
        if !self.allows(field) {
            return;
        }
        if is_route_field(field.name()) {
            if let Ok(route) = sanitize_route_template("tracing route template", &value) {
                drop(
                    self.metadata
                        .insert(field.name().to_owned(), MetadataValue::String(route)),
                );
            }
            return;
        }
        drop(
            self.metadata
                .insert(field.name().to_owned(), MetadataValue::String(value)),
        );
    }

    fn record_value(&mut self, field: &Field, value: MetadataValue) {
        if self.allows(field) {
            drop(self.metadata.insert(field.name().to_owned(), value));
        }
    }
}

impl Visit for TracingLogVisitor<'_> {
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.record_value(field, MetadataValue::Bool(value));
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        if is_traceparent_field(field.name()) {
            self.traceparent = Some(format!("{value:?}").trim_matches('"').to_owned());
            return;
        }
        if field.name() == "message" {
            self.record_string(field, format!("{value:?}"));
        }
    }

    fn record_f64(&mut self, field: &Field, value: f64) {
        if value.is_finite() {
            self.record_value(field, MetadataValue::from(value));
        }
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.record_value(field, MetadataValue::from(value));
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        self.record_string(field, value.to_owned());
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.record_value(field, MetadataValue::from(value));
    }
}

/// Copy the current `tracing` span's OpenTelemetry context into LogBrew's dependency-free shape.
///
/// This helper is available with the `tracing-opentelemetry` feature. It returns `None` when no
/// valid OpenTelemetry span context is attached, for example when the app has not installed a
/// `tracing_opentelemetry` layer or the current span is disabled.
#[cfg(feature = "tracing-opentelemetry")]
#[must_use]
#[inline]
pub fn opentelemetry_span_context_from_current_tracing_span() -> Option<OpenTelemetrySpanContext> {
    let span = tracing::Span::current();
    opentelemetry_span_context_from_tracing_span(&span)
}

/// Copy one `tracing` span's OpenTelemetry trace ID, span ID, and trace flags.
///
/// The helper intentionally ignores tracestate, baggage, span attributes, events, links, and
/// exporter/provider state; apps can pass the returned context to `Traceparent` helpers to create
/// LogBrew child spans or one-header downstream propagation.
#[cfg(feature = "tracing-opentelemetry")]
#[must_use]
#[inline]
pub fn opentelemetry_span_context_from_tracing_span(
    span: &tracing::Span,
) -> Option<OpenTelemetrySpanContext> {
    use opentelemetry::trace::TraceContextExt as _;
    use tracing_opentelemetry::OpenTelemetrySpanExt as _;

    let context = span.context();
    let span_context = context.span().span_context().clone();
    if !span_context.is_valid() {
        return None;
    }

    OpenTelemetrySpanContext::new(
        span_context.trace_id().to_string(),
        span_context.span_id().to_string(),
        format!("{:02x}", span_context.trace_flags().to_u8()),
    )
    .ok()
}

fn insert_callsite_metadata(metadata: &mut Metadata, callsite: &tracing_core::Metadata<'_>) {
    metadata.extend([
        ("tracingTarget".into(), callsite.target().into()),
        ("tracingLevel".into(), callsite.level().as_str().into()),
    ]);
}

fn tracing_error_issue(
    message: &str,
    callsite: &tracing_core::Metadata<'_>,
    mut metadata: Metadata,
    context: TelemetryContext,
) -> IssueEvent {
    let filename = callsite
        .file()
        .and_then(|value| sanitize_filename(value).ok());
    let grouping_key = format!(
        "rust.tracing.event:{}:{}:{}",
        callsite.target(),
        filename.as_deref().unwrap_or("unknown"),
        callsite
            .line()
            .map_or_else(|| "unknown".into(), |line| line.to_string())
    )
    .chars()
    .take(1024)
    .collect::<String>();
    metadata.extend([
        ("mechanism".into(), "tracing.event".into()),
        ("handled".into(), true.into()),
        ("issueGroupingKey".into(), grouping_key.into()),
        ("issueGroupingSource".into(), "tracing_callsite".into()),
        ("issueEvidenceCompleteness".into(), "partial".into()),
        (
            "issueMissingEvidence".into(),
            "exception,stackFrames".into(),
        ),
        (
            "issueRedactedEvidence".into(),
            "unallowlistedEventFields".into(),
        ),
    ]);
    if let Some(name) = filename {
        drop(metadata.insert("sourceFileName".into(), name.into()));
    }
    if let Some(line) = callsite.line() {
        drop(metadata.insert("sourceLineNumber".into(), line.into()));
    }
    if let Some(module) = callsite
        .module_path()
        .filter(|value| !value.trim().is_empty())
    {
        drop(metadata.insert(
            "sourceModule".into(),
            module.chars().take(512).collect::<String>().into(),
        ));
    }
    IssueEvent::new(message, "error")
        .with_message(message)
        .with_metadata(metadata)
        .with_context(context)
}

fn tracing_event_context(
    span: Option<&SpanReference>,
    configured: Option<&TelemetryContext>,
) -> Result<TelemetryContext, crate::SdkError> {
    let framework = TelemetryContext::new().with_resource(
        TelemetryResource::new().with_framework(TelemetryNamedVersion::new("tracing")),
    );
    let trace = span.map(|reference| {
        let mut trace_context =
            TelemetryTraceContext::new(&reference.trace_id).with_span_id(&reference.span_id);
        if let Some(parent_span_id) = reference.parent_span_id.as_ref() {
            trace_context = trace_context.with_parent_span_id(parent_span_id);
        }
        if let Some(sampled) = reference.sampled {
            trace_context = trace_context.with_sampled(sampled);
        }
        TelemetryContext::new().with_trace(trace_context)
    });
    merge_captured_contexts([Some(framework), configured.cloned(), trace])?.ok_or_else(|| {
        crate::SdkError::new(
            "validation_error",
            "tracing telemetry context could not be created",
        )
    })
}

fn parent_span_reference<S>(attrs: &Attributes<'_>, ctx: &Context<'_, S>) -> Option<SpanReference>
where
    S: Subscriber + for<'lookup> LookupSpan<'lookup>,
{
    let id = attrs.parent().cloned().or_else(|| {
        attrs
            .is_contextual()
            .then(|| ctx.current_span().id().cloned())
            .flatten()
    })?;
    ctx.span(&id)?
        .extensions()
        .get::<TracingSpanState>()
        .map(Into::into)
}

fn current_event_span_correlation<S>(
    event: &TracingEvent<'_>,
    ctx: &Context<'_, S>,
) -> Option<SpanReference>
where
    S: Subscriber + for<'lookup> LookupSpan<'lookup>,
{
    let scope = ctx.event_scope(event)?;
    let current = scope.from_root().last()?;
    current
        .extensions()
        .get::<TracingSpanState>()
        .map(Into::into)
}

fn record_current_span_event<S>(event: &TracingEvent<'_>, ctx: &Context<'_, S>)
where
    S: Subscriber + for<'lookup> LookupSpan<'lookup>,
{
    let Some(scope) = ctx.event_scope(event) else {
        return;
    };
    let Some(current) = scope.from_root().last() else {
        return;
    };
    if let Some(state) = current.extensions_mut().get_mut::<TracingSpanState>() {
        state.event_count = state.event_count.saturating_add(1);
        if *event.metadata().level() == Level::ERROR {
            state.error = true;
            state.error_event_count = state.error_event_count.saturating_add(1);
            state.last_error_target = Some(event.metadata().target().to_owned());
        }
    }
}

fn span_metadata_with_event_summary(state: &TracingSpanState) -> Metadata {
    let mut metadata = state.metadata.clone();
    for (name, count) in [
        ("tracingSpanEventCount", state.event_count),
        ("tracingSpanErrorEventCount", state.error_event_count),
    ] {
        if count > 0 {
            drop(metadata.insert(name.into(), count.into()));
        }
    }
    if let Some(target) = state.last_error_target.as_ref() {
        metadata.extend([
            ("tracingLastErrorLevel".into(), "ERROR".into()),
            ("tracingLastErrorTarget".into(), target.clone().into()),
        ]);
    }
    metadata
}

fn incoming_trace_context(visitor: &TracingLogVisitor<'_>) -> Option<TraceparentContext> {
    let traceparent = visitor.traceparent.as_deref()?;
    Traceparent::parse(traceparent).ok()
}

fn is_route_field(name: &str) -> bool {
    matches!(name, "routeTemplate" | "route_template")
}

fn is_traceparent_field(name: &str) -> bool {
    matches!(name, "traceparent" | "trace_parent")
}
