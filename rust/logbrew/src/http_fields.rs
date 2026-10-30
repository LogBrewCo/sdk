use crate::{SdkError, require_non_empty};
use core::time::Duration;
use serde_json::{Map, Value};

pub(crate) fn telemetry_metadata(
    source: &'static str,
    metadata: Option<Map<String, Value>>,
) -> Result<Map<String, Value>, SdkError> {
    let mut copied = Map::new();
    drop(copied.insert("source".to_owned(), Value::String(source.to_owned())));
    let Some(entries) = metadata else {
        return Ok(copied);
    };

    for (key, value) in entries {
        require_non_empty("metadata key", &key)?;
        require_primitive_metadata_value(&key, &value)?;
        if key != "source" {
            drop(copied.insert(key, value));
        }
    }
    Ok(copied)
}

pub(crate) fn optional_route_template(
    label: &str,
    route_template: Option<String>,
) -> Result<Option<String>, SdkError> {
    route_template
        .map(|template| sanitize_route_template(label, &template))
        .transpose()
}

pub(crate) fn sanitize_route_template(
    label: &str,
    route_template: &str,
) -> Result<String, SdkError> {
    require_non_empty(label, route_template)?;
    let trimmed = route_template.trim();
    let lowercase = trimmed.to_ascii_lowercase();
    let route = if lowercase.starts_with("https://") {
        path_from_http_url(trimmed.get(8..).unwrap_or_default())?
    } else if lowercase.starts_with("http://") {
        path_from_http_url(trimmed.get(7..).unwrap_or_default())?
    } else {
        trimmed
    };
    let path = [route.find('?'), route.find('#')]
        .into_iter()
        .flatten()
        .min()
        .and_then(|cutoff| route.get(..cutoff))
        .unwrap_or(route)
        .trim_end();
    Ok(if path.is_empty() { "/" } else { path }.to_owned())
}

pub(crate) fn normalize_method(label: &str, method: &str) -> Result<String, SdkError> {
    let normalized = method.trim().to_ascii_uppercase();
    if normalized.is_empty()
        || !normalized.bytes().all(|byte| {
            byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-'
        })
    {
        return Err(SdkError::new(
            "validation_error",
            format!("{label} must be a valid HTTP method"),
        ));
    }
    Ok(normalized)
}

pub(crate) fn validate_status_code(label: &str, status_code: Option<u16>) -> Result<(), SdkError> {
    if status_code.is_some_and(|code| !(100..=599).contains(&code)) {
        return Err(SdkError::new(
            "validation_error",
            format!("{label} must be between 100 and 599"),
        ));
    }
    Ok(())
}

pub(crate) fn validate_duration_ms(label: &str, duration_ms: Option<f64>) -> Result<(), SdkError> {
    if let Some(duration) = duration_ms {
        if !duration.is_finite() {
            return Err(SdkError::new(
                "validation_error",
                format!("{label} must be finite"),
            ));
        }
        if duration < 0.0_f64 {
            return Err(SdkError::new(
                "validation_error",
                format!("{label} must be non-negative"),
            ));
        }
    }
    Ok(())
}

pub(crate) fn optional_label(
    label: &str,
    value: Option<String>,
) -> Result<Option<String>, SdkError> {
    value.map(|text| required_label(label, &text)).transpose()
}

pub(crate) fn required_label(label: &str, value: &str) -> Result<String, SdkError> {
    require_non_empty(label, value)?;
    Ok(value.trim().to_owned())
}

pub(crate) fn status_code_class(status_code: u16) -> String {
    format!("{}xx", status_code.div_euclid(100))
}

pub(crate) fn duration_millis(duration: Duration) -> f64 {
    duration
        .checked_mul(1_000)
        .map_or(f64::MAX, |scaled| scaled.as_secs_f64())
}

pub(crate) fn insert_optional(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(text) = value {
        drop(map.insert(key.to_owned(), Value::String(text)));
    }
}

fn path_from_http_url(rest: &str) -> Result<&str, SdkError> {
    let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    if host_end == 0 {
        return Err(SdkError::new(
            "validation_error",
            "route_template URL host must be non-empty",
        ));
    }
    Ok(rest.get(host_end..).unwrap_or("/"))
}

fn require_primitive_metadata_value(key: &str, value: &Value) -> Result<(), SdkError> {
    match *value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => Ok(()),
        Value::Array(_) | Value::Object(_) => Err(SdkError::new(
            "validation_error",
            format!("metadata value for {key} must be primitive"),
        )),
    }
}
