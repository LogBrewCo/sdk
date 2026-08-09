use crate::{
    SdkError, TelemetryContext, context_entry, metadata_entry, require_allowed_value,
    require_non_empty,
};
use serde_json::{Map, Value};

#[derive(Clone, Debug, PartialEq)]
/// Public metric-event builder for explicit low-cardinality metric measurements.
pub struct MetricEvent {
    name: String,
    description: Option<String>,
    kind: String,
    value: f64,
    unit: String,
    temporality: String,
    metadata: Option<Map<String, Value>>,
    context: Option<TelemetryContext>,
}

impl MetricEvent {
    /// Create a metric event with name, kind, value, unit, and temporality fields.
    pub fn new(
        name: impl Into<String>,
        kind: impl Into<String>,
        value: f64,
        unit: impl Into<String>,
        temporality: impl Into<String>,
    ) -> Self {
        Self {
            name: name.into(),
            description: None,
            kind: kind.into(),
            value,
            unit: unit.into(),
            temporality: temporality.into(),
            metadata: None,
            context: None,
        }
    }

    /// Attach a stable display meaning; do not include identifiers or changing values.
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Attach primitive, low-cardinality metadata to the metric payload.
    pub fn with_metadata(mut self, metadata: Map<String, Value>) -> Self {
        self.metadata = Some(metadata);
        self
    }

    /// Attach an explicit shared telemetry context override.
    pub fn with_context(mut self, context: TelemetryContext) -> Self {
        self.context = Some(context);
        self
    }

    pub(crate) fn attributes(self) -> Result<Map<String, Value>, SdkError> {
        require_non_empty("metric name", &self.name)?;
        require_allowed_value(
            "metric kind",
            &self.kind,
            &["counter", "gauge", "histogram"],
        )?;
        require_non_empty("metric unit", &self.unit)?;
        if !self.value.is_finite() {
            return Err(SdkError::new(
                "validation_error",
                "metric value must be finite",
            ));
        }
        validate_metric_temporality(&self.kind, &self.temporality, self.value)?;

        if let Some(metadata) = &self.metadata {
            require_primitive_metadata(metadata)?;
        }
        let mut map = Map::new();
        map.insert("name".to_string(), Value::String(self.name));
        if let Some(description) = self.description {
            map.insert(
                "description".to_string(),
                Value::String(normalize_metric_description(&description)?),
            );
        }
        map.insert("kind".to_string(), Value::String(self.kind));
        map.insert("value".to_string(), Value::from(self.value));
        map.insert("unit".to_string(), Value::String(self.unit));
        map.insert("temporality".to_string(), Value::String(self.temporality));
        metadata_entry(&mut map, self.metadata);
        context_entry(&mut map, self.context)?;
        Ok(map)
    }
}

fn normalize_metric_description(value: &str) -> Result<String, SdkError> {
    let normalized = value.trim();
    let invalid_character = normalized.chars().any(|character| {
        character <= '\u{001f}'
            || ('\u{007f}'..='\u{009f}').contains(&character)
            || character == '\u{2028}'
            || character == '\u{2029}'
    });
    if normalized.is_empty() || normalized.chars().count() > 1024 || invalid_character {
        return Err(SdkError::new(
            "validation_error",
            "metric description must be a non-blank string of at most 1024 non-control characters",
        ));
    }
    Ok(normalized.to_string())
}

fn validate_metric_temporality(kind: &str, temporality: &str, value: f64) -> Result<(), SdkError> {
    if kind == "gauge" {
        return require_allowed_value("metric temporality", temporality, &["instant"]);
    }
    require_allowed_value("metric temporality", temporality, &["delta", "cumulative"])?;
    if value < 0.0 {
        return Err(SdkError::new(
            "validation_error",
            "counter and histogram metric values must be non-negative",
        ));
    }
    Ok(())
}

fn require_primitive_metadata(metadata: &Map<String, Value>) -> Result<(), SdkError> {
    for value in metadata.values() {
        match value {
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
            Value::Array(_) | Value::Object(_) => {
                return Err(SdkError::new(
                    "validation_error",
                    "metric metadata values must be primitive",
                ));
            }
        }
    }
    Ok(())
}
