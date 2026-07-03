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
