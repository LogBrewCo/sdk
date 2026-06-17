use crate::{
    LogBrewClient, LogEvent, Metadata, MetadataValue, SharedLogBrewClient, SpanEvent, Traceparent,
    TraceparentContext, http_fields::sanitize_route_template,
};
use std::fmt;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
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
}

impl<T> LogBrewTracingLayer<T> {
    /// Build a `tracing` layer from an app-owned LogBrew client and timestamp source.
    pub fn new(client: SharedLogBrewClient, timestamp: T) -> Self {
        Self {
            client,
            timestamp,
            allowed_fields: Vec::new(),
            event_id_prefix: "evt_tracing_log".to_string(),
            span_id_prefix: "evt_tracing_span".to_string(),
            next_id: Arc::new(AtomicU64::new(1)),
            next_span_id: Arc::new(AtomicU64::new(1)),
            logger_name: None,
            capture_spans: false,
        }
    }

    /// Allowlist primitive event and span fields copied into LogBrew metadata.
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

    /// Override the span event ID prefix used before the layer's monotonic counter.
    pub fn with_span_id_prefix(mut self, prefix: impl Into<String>) -> Self {
        self.span_id_prefix = prefix.into();
        self
    }

    /// Override the logger name attached to converted LogBrew log events.
    pub fn with_logger(mut self, logger: impl Into<String>) -> Self {
        self.logger_name = Some(logger.into());
        self
    }

    /// Opt in to converting closed `tracing` spans into LogBrew span events.
    pub fn with_span_events(mut self) -> Self {
        self.capture_spans = true;
        self
    }
}

impl<S, T> Layer<S> for LogBrewTracingLayer<T>
where
    S: Subscriber + for<'lookup> LookupSpan<'lookup>,
    T: Fn() -> String + Clone + Send + Sync + 'static,
{
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        if !self.capture_spans {
            return;
        }

        let metadata = attrs.metadata();
        let mut visitor = TracingLogVisitor::new(&self.allowed_fields);
        attrs.record(&mut visitor);
        let incoming_trace = incoming_trace_context(&visitor);
        let mut span_metadata = visitor.metadata;
        span_metadata.insert(
            "tracingTarget".to_string(),
            MetadataValue::String(metadata.target().to_string()),
        );
        span_metadata.insert(
            "tracingLevel".to_string(),
            MetadataValue::String(metadata.level().as_str().to_string()),
        );

        let parent = parent_span_reference(attrs, &ctx);
        let sequence = self.next_span_id.fetch_add(1, Ordering::Relaxed);
        let sampled = parent
            .as_ref()
            .and_then(|state| state.sampled)
            .or_else(|| incoming_trace.as_ref().map(|trace| trace.sampled));
        if let Some(sampled) = sampled {
            span_metadata
                .entry("sampled".to_string())
                .or_insert(MetadataValue::Bool(sampled));
        }
        let state = TracingSpanState {
            event_id: format!("{}_{}", self.span_id_prefix.trim(), sequence),
            trace_id: parent
                .as_ref()
                .map(|state| state.trace_id.clone())
                .or_else(|| incoming_trace.as_ref().map(|trace| trace.trace_id.clone()))
                .unwrap_or_else(|| trace_id_for(sequence)),
            span_id: span_id_for(sequence),
            parent_span_id: parent
                .as_ref()
                .map(|state| state.span_id.clone())
                .or_else(|| incoming_trace.map(|trace| trace.parent_span_id)),
            name: metadata.name().trim().to_string(),
            timestamp: (self.timestamp)(),
            started_at: Instant::now(),
            metadata: span_metadata,
            sampled,
            error: false,
            event_count: 0,
            error_event_count: 0,
            last_error_event: None,
        };

        if let Some(span) = ctx.span(id) {
            span.extensions_mut().insert(state);
        }
    }

    fn on_record(&self, id: &Id, values: &Record<'_>, ctx: Context<'_, S>) {
        if !self.capture_spans {
            return;
        }

        let Some(span) = ctx.span(id) else {
            return;
        };
        let mut extensions = span.extensions_mut();
        let Some(state) = extensions.get_mut::<TracingSpanState>() else {
            return;
        };
        let mut visitor = TracingLogVisitor::new(&self.allowed_fields);
        values.record(&mut visitor);
        state.metadata.extend(visitor.metadata);
    }

    fn on_event(&self, event: &TracingEvent<'_>, ctx: Context<'_, S>) {
        let metadata = event.metadata();
        let mut visitor = TracingLogVisitor::new(&self.allowed_fields);
        event.record(&mut visitor);

        let message = visitor
            .message
            .unwrap_or_else(|| "tracing event".to_string());
        let mut log_metadata = visitor.metadata;
        if let Some(state) = current_event_span_correlation(event, &ctx) {
            log_metadata.insert("traceId".to_string(), MetadataValue::String(state.trace_id));
            log_metadata.insert("spanId".to_string(), MetadataValue::String(state.span_id));
            if let Some(parent_span_id) = state.parent_span_id {
                log_metadata.insert(
                    "parentSpanId".to_string(),
                    MetadataValue::String(parent_span_id),
                );
            }
            if let Some(sampled) = state.sampled {
                log_metadata
                    .entry("sampled".to_string())
                    .or_insert(MetadataValue::Bool(sampled));
            }
        }
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

        if self.capture_spans {
            record_current_span_event(event, &ctx);
        }
    }

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

        let span_metadata = span_metadata_with_event_summary(&state);
        let mut event = SpanEvent::new(
            state.name,
            state.trace_id,
            state.span_id,
            if state.error { "error" } else { "ok" },
        )
        .with_duration_ms(state.started_at.elapsed().as_secs_f64() * 1000.0)
        .with_metadata(span_metadata);
        if let Some(parent_span_id) = state.parent_span_id {
            event = event.with_parent_span_id(parent_span_id);
        }

        if let Ok(mut client) = self.client.lock() {
            let _ = queue_span(&mut client, state.event_id, state.timestamp, event);
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

fn queue_span(
    client: &mut LogBrewClient,
    event_id: String,
    timestamp: String,
    span: SpanEvent,
) -> Result<(), crate::SdkError> {
    client.span(event_id, timestamp, span)
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

fn trace_id_for(sequence: u64) -> String {
    format!("{:032x}", sequence as u128)
}

fn span_id_for(sequence: u64) -> String {
    format!("{sequence:016x}")
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
    last_error_event: Option<TracingSpanErrorEvent>,
}

#[derive(Clone, Debug)]
struct TracingSpanErrorEvent {
    level: String,
    target: String,
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

fn parent_span_reference<S>(attrs: &Attributes<'_>, ctx: &Context<'_, S>) -> Option<SpanReference>
where
    S: Subscriber + for<'lookup> LookupSpan<'lookup>,
{
    let span = attrs
        .parent()
        .and_then(|parent_id| ctx.span(parent_id))
        .or_else(|| {
            attrs
                .is_contextual()
                .then(|| ctx.current_span().id().and_then(|id| ctx.span(id)))
                .flatten()
        })?;
    span.extensions().get::<TracingSpanState>().map(Into::into)
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
            state.last_error_event = Some(TracingSpanErrorEvent {
                level: event.metadata().level().as_str().to_string(),
                target: event.metadata().target().to_string(),
            });
        }
    }
}

fn span_metadata_with_event_summary(state: &TracingSpanState) -> Metadata {
    let mut metadata = state.metadata.clone();
    if state.event_count > 0 {
        metadata.insert(
            "tracingSpanEventCount".to_string(),
            MetadataValue::from(state.event_count),
        );
    }
    if state.error_event_count > 0 {
        metadata.insert(
            "tracingSpanErrorEventCount".to_string(),
            MetadataValue::from(state.error_event_count),
        );
    }
    if let Some(event) = &state.last_error_event {
        metadata.insert(
            "tracingLastErrorLevel".to_string(),
            MetadataValue::String(event.level.clone()),
        );
        metadata.insert(
            "tracingLastErrorTarget".to_string(),
            MetadataValue::String(event.target.clone()),
        );
    }
    metadata
}

struct TracingLogVisitor<'a> {
    allowed_fields: &'a [String],
    message: Option<String>,
    metadata: Metadata,
    traceparent: Option<String>,
}

impl<'a> TracingLogVisitor<'a> {
    fn new(allowed_fields: &'a [String]) -> Self {
        Self {
            allowed_fields,
            message: None,
            metadata: Metadata::new(),
            traceparent: None,
        }
    }

    fn allows(&self, field: &Field) -> bool {
        self.allowed_fields
            .iter()
            .any(|allowed| allowed == field.name())
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
        if is_traceparent_field(field.name()) {
            self.traceparent = Some(format!("{value:?}").trim_matches('"').to_string());
            return;
        }
        if field.name() == "message" {
            self.record_string(field, format!("{value:?}"));
        }
    }
}

fn incoming_trace_context(visitor: &TracingLogVisitor<'_>) -> Option<TraceparentContext> {
    visitor
        .traceparent
        .as_deref()
        .and_then(|traceparent| Traceparent::parse(traceparent).ok())
}

fn is_route_field(name: &str) -> bool {
    matches!(name, "routeTemplate" | "route_template")
}

fn is_traceparent_field(name: &str) -> bool {
    matches!(name, "traceparent" | "trace_parent")
}
