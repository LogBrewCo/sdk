use crate::Metadata;
use serde_json::Value;

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
    "unsafe",
    "url",
    "user",
    "value",
];

pub(crate) fn sanitized_metadata(metadata: Metadata) -> Metadata {
    metadata
        .into_iter()
        .filter(|entry| is_safe_key(&entry.0) && value_is_primitive(&entry.1))
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
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect()
}

const fn value_is_primitive(value: &Value) -> bool {
    matches!(
        value,
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
    )
}
