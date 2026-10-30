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
    pub(super) fn attributes(self) -> Result<Map<String, Value>, SdkError> {
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

        if let Some(metadata) = self.metadata.as_ref() {
            require_primitive_metadata(metadata)?;
        }
        let mut map = Map::new();
        drop(map.insert("name".to_owned(), Value::String(self.name)));
        if let Some(description) = self.description {
            drop(map.insert(
                "description".to_owned(),
                Value::String(normalize_metric_description(&description)?),
            ));
        }
        drop(map.insert("kind".to_owned(), Value::String(self.kind)));
        drop(map.insert("value".to_owned(), Value::from(self.value)));
        drop(map.insert("unit".to_owned(), Value::String(self.unit)));
        drop(map.insert("temporality".to_owned(), Value::String(self.temporality)));
        metadata_entry(&mut map, self.metadata);
        context_entry(&mut map, self.context)?;
        Ok(map)
    }

    /// Create a metric event with name, kind, value, unit, and temporality fields.
    #[inline]
    pub fn new<Name, Kind, Unit, Temporality>(
        name: Name,
        kind: Kind,
        value: f64,
        unit: Unit,
        temporality: Temporality,
    ) -> Self
    where
        Name: Into<String>,
        Kind: Into<String>,
        Unit: Into<String>,
        Temporality: Into<String>,
    {
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

    /// Attach an explicit shared telemetry context override.
    #[must_use]
    #[inline]
    pub fn with_context(mut self, context: TelemetryContext) -> Self {
        self.context = Some(context);
        self
    }

    /// Attach a stable display meaning; do not include identifiers or changing values.
    #[must_use]
    #[inline]
    pub fn with_description<Description>(mut self, description: Description) -> Self
    where
        Description: Into<String>,
    {
        self.description = Some(description.into());
        self
    }

    /// Attach primitive, low-cardinality metadata to the metric payload.
    #[must_use]
    #[inline]
    pub fn with_metadata(mut self, metadata: Map<String, Value>) -> Self {
        self.metadata = Some(metadata);
        self
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
    Ok(normalized.to_owned())
}

fn validate_metric_temporality(kind: &str, temporality: &str, value: f64) -> Result<(), SdkError> {
    if kind == "gauge" {
        return require_allowed_value("metric temporality", temporality, &["instant"]);
    }
    require_allowed_value("metric temporality", temporality, &["delta", "cumulative"])?;
    if value < 0.0_f64 {
        return Err(SdkError::new(
            "validation_error",
            "counter and histogram metric values must be non-negative",
        ));
    }
    Ok(())
}

fn require_primitive_metadata(metadata: &Map<String, Value>) -> Result<(), SdkError> {
    for value in metadata.values() {
        match *value {
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
