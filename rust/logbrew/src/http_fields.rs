use crate::{SdkError, require_non_empty};
use serde_json::{Map, Value};

pub(crate) fn telemetry_metadata(
    source: &'static str,
    metadata: Option<Map<String, Value>>,
) -> Result<Map<String, Value>, SdkError> {
    let mut copied = Map::new();
    copied.insert("source".to_string(), Value::String(source.to_string()));
    let Some(metadata) = metadata else {
        return Ok(copied);
    };

    for (key, value) in metadata {
        require_non_empty("metadata key", &key)?;
        require_primitive_metadata_value(&key, &value)?;
        if key != "source" {
            copied.insert(key, value);
        }
    }
    Ok(copied)
}

pub(crate) fn optional_route_template(
    label: &str,
    route_template: Option<String>,
) -> Result<Option<String>, SdkError> {
    route_template
        .map(|route_template| sanitize_route_template(label, route_template))
        .transpose()
}

pub(crate) fn sanitize_route_template(
    label: &str,
    route_template: String,
) -> Result<String, SdkError> {
    require_non_empty(label, &route_template)?;
    let trimmed = route_template.trim();
    let lowercase = trimmed.to_ascii_lowercase();
    let route = if lowercase.starts_with("https://") {
        path_from_http_url(&trimmed[8..])?
    } else if lowercase.starts_with("http://") {
        path_from_http_url(&trimmed[7..])?
    } else {
        trimmed
    };
    let route = match first_present_index(route.find('?'), route.find('#')) {
        Some(cutoff) => route[..cutoff].trim_end(),
        None => route.trim_end(),
    };
    Ok(if route.is_empty() { "/" } else { route }.to_string())
}

pub(crate) fn normalize_method(label: &str, method: &str) -> Result<String, SdkError> {
    let method = method.trim().to_ascii_uppercase();
    if method.is_empty()
        || !method.bytes().all(|byte| {
            byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-'
        })
    {
        return Err(SdkError::new(
            "validation_error",
            format!("{label} must be a valid HTTP method"),
        ));
    }
    Ok(method)
}

pub(crate) fn validate_status_code(label: &str, status_code: Option<u16>) -> Result<(), SdkError> {
    if status_code.is_some_and(|status_code| !(100..=599).contains(&status_code)) {
        return Err(SdkError::new(
            "validation_error",
            format!("{label} must be between 100 and 599"),
        ));
    }
    Ok(())
}

pub(crate) fn validate_duration_ms(label: &str, duration_ms: Option<f64>) -> Result<(), SdkError> {
    if let Some(duration_ms) = duration_ms {
        if !duration_ms.is_finite() {
            return Err(SdkError::new(
                "validation_error",
                format!("{label} must be finite"),
            ));
        }
        if duration_ms < 0.0 {
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
    value.map(|value| required_label(label, value)).transpose()
}

pub(crate) fn required_label(label: &str, value: String) -> Result<String, SdkError> {
    require_non_empty(label, &value)?;
    Ok(value.trim().to_string())
}

pub(crate) fn status_code_class(status_code: u16) -> String {
    format!("{}xx", status_code / 100)
}

pub(crate) fn insert_optional(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        map.insert(key.to_string(), Value::String(value));
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
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => Ok(()),
        Value::Array(_) | Value::Object(_) => Err(SdkError::new(
            "validation_error",
            format!("metadata value for {key} must be primitive"),
        )),
    }
}

fn first_present_index(first: Option<usize>, second: Option<usize>) -> Option<usize> {
    match (first, second) {
        (Some(first), Some(second)) => Some(first.min(second)),
        (Some(first), None) => Some(first),
        (None, Some(second)) => Some(second),
        (None, None) => None,
    }
}
