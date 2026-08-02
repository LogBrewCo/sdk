use crate::{IssueEvent, Metadata, SdkError};
use serde_json::{Map, Value};
use std::collections::VecDeque;

pub(crate) const MAX_STACK_FRAMES: usize = 32;
pub(crate) const MAX_BREADCRUMBS: usize = 64;

const MAX_EXCEPTION_TYPE: usize = 256;
const MAX_MECHANISM_TYPE: usize = 64;
const MAX_FRAME_FILENAME: usize = 2048;
const MAX_FRAME_FUNCTION: usize = 256;
const MAX_FRAME_MODULE: usize = 512;
const MAX_BREADCRUMB_NAME: usize = 64;
const MAX_BREADCRUMB_MESSAGE: usize = 512;
const MAX_BREADCRUMB_DATA_FIELDS: usize = 8;
const MAX_BREADCRUMB_DATA_STRING: usize = 256;
const MAX_COORDINATE: u32 = i32::MAX as u32;

#[derive(Clone, Debug, PartialEq, Eq)]
/// Runtime path that captured an issue exception and whether it escaped.
pub struct IssueExceptionMechanism {
    mechanism_type: String,
    handled: bool,
}

impl IssueExceptionMechanism {
    /// Create a typed issue mechanism with an explicit handled state.
    pub fn new(mechanism_type: impl Into<String>, handled: bool) -> Self {
        Self {
            mechanism_type: mechanism_type.into(),
            handled,
        }
    }

    pub(crate) fn attributes(&self) -> Result<Map<String, Value>, SdkError> {
        let mut value = Map::new();
        value.insert(
            "type".to_string(),
            Value::String(require_machine_name(
                "issue exception mechanism type",
                &self.mechanism_type,
                MAX_MECHANISM_TYPE,
                true,
            )?),
        );
        value.insert("handled".to_string(), Value::Bool(self.handled));
        Ok(value)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Structured exception identity attached to an issue.
pub struct IssueException {
    exception_type: String,
    mechanism: Option<IssueExceptionMechanism>,
}

impl IssueException {
    /// Create exception identity from a stable type name.
    pub fn new(exception_type: impl Into<String>) -> Self {
        Self {
            exception_type: exception_type.into(),
            mechanism: None,
        }
    }

    /// Attach the capture mechanism and handled state.
    pub fn with_mechanism(mut self, mechanism: IssueExceptionMechanism) -> Self {
        self.mechanism = Some(mechanism);
        self
    }

    pub(crate) fn attributes(&self) -> Result<Map<String, Value>, SdkError> {
        let mut value = Map::new();
        value.insert(
            "type".to_string(),
            Value::String(require_exception_type(&self.exception_type)?),
        );
        if let Some(mechanism) = &self.mechanism {
            value.insert(
                "mechanism".to_string(),
                Value::Object(mechanism.attributes()?),
            );
        }
        Ok(value)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// Privacy-bounded code identity for one issue stack frame.
pub struct IssueStackFrame {
    filename: String,
    line: u32,
    column: u32,
    function: Option<String>,
    module: Option<String>,
    in_app: Option<bool>,
    debug_id: Option<String>,
}

impl IssueStackFrame {
    /// Create a frame with required source identity and positive coordinates.
    pub fn new(filename: impl Into<String>, line: u32, column: u32) -> Self {
        Self {
            filename: filename.into(),
            line,
            column,
            function: None,
            module: None,
            in_app: None,
            debug_id: None,
        }
    }

    /// Create a frame from a Rust panic or caller source location.
    pub fn from_location(location: &std::panic::Location<'_>) -> Self {
        Self::new(location.file(), location.line(), location.column())
    }

    /// Attach an optional function or method name.
    pub fn with_function(mut self, function: impl Into<String>) -> Self {
        self.function = Some(function.into());
        self
    }

    /// Attach an optional Rust module or code namespace.
    pub fn with_module(mut self, module: impl Into<String>) -> Self {
        self.module = Some(module.into());
        self
    }

    /// Mark whether the application owns this frame.
    pub fn with_in_app(mut self, in_app: bool) -> Self {
        self.in_app = Some(in_app);
        self
    }

    /// Attach an optional build Debug ID.
    pub fn with_debug_id(mut self, debug_id: impl Into<String>) -> Self {
        self.debug_id = Some(debug_id.into());
        self
    }

    pub(crate) fn attributes(&self) -> Result<Map<String, Value>, SdkError> {
        let mut value = Map::new();
        value.insert(
            "filename".to_string(),
            Value::String(sanitize_filename(&self.filename)?),
        );
        value.insert(
            "line".to_string(),
            Value::from(require_coordinate("issue stack frame line", self.line)?),
        );
        value.insert(
            "column".to_string(),
            Value::from(require_coordinate("issue stack frame column", self.column)?),
        );
        if let Some(function) = &self.function {
            value.insert(
                "function".to_string(),
                Value::String(require_text(
                    "issue stack frame function",
                    function,
                    MAX_FRAME_FUNCTION,
                    false,
                )?),
            );
        }
        if let Some(module) = &self.module {
            value.insert(
                "module".to_string(),
                Value::String(require_text(
                    "issue stack frame module",
                    module,
                    MAX_FRAME_MODULE,
                    true,
                )?),
            );
        }
        if let Some(in_app) = self.in_app {
            value.insert("inApp".to_string(), Value::Bool(in_app));
        }
        if let Some(debug_id) = &self.debug_id {
            value.insert(
                "debugId".to_string(),
                Value::String(normalize_debug_id(debug_id)?),
            );
        }
        Ok(value)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
/// One bounded oldest-to-newest step that happened before an issue.
pub struct IssueBreadcrumb {
    timestamp: String,
    category: String,
    breadcrumb_type: Option<String>,
    level: Option<String>,
    message: Option<String>,
    data: Option<Metadata>,
}

impl IssueBreadcrumb {
    /// Create a breadcrumb with an RFC 3339 timestamp and stable category.
    pub fn new(timestamp: impl Into<String>, category: impl Into<String>) -> Self {
        Self {
            timestamp: timestamp.into(),
            category: category.into(),
            breadcrumb_type: None,
            level: None,
            message: None,
            data: None,
        }
    }

    /// Attach an optional stable breadcrumb type.
    pub fn with_type(mut self, breadcrumb_type: impl Into<String>) -> Self {
        self.breadcrumb_type = Some(breadcrumb_type.into());
        self
    }

    /// Attach an optional breadcrumb severity.
    pub fn with_level(mut self, level: impl Into<String>) -> Self {
        self.level = Some(level.into());
        self
    }

    /// Attach an optional bounded breadcrumb message.
    pub fn with_message(mut self, message: impl Into<String>) -> Self {
        self.message = Some(message.into());
        self
    }

    /// Attach up to eight flat finite primitive data fields.
    pub fn with_data(mut self, data: Metadata) -> Self {
        self.data = Some(data);
        self
    }

    pub(crate) fn attributes(&self) -> Result<Map<String, Value>, SdkError> {
        let mut value = Map::new();
        value.insert(
            "timestamp".to_string(),
            Value::String(require_breadcrumb_timestamp(&self.timestamp)?),
        );
        value.insert(
            "category".to_string(),
            Value::String(require_machine_name(
                "issue breadcrumb category",
                &self.category,
                MAX_BREADCRUMB_NAME,
                true,
            )?),
        );
        if let Some(breadcrumb_type) = &self.breadcrumb_type {
            value.insert(
                "type".to_string(),
                Value::String(require_machine_name(
                    "issue breadcrumb type",
                    breadcrumb_type,
                    MAX_BREADCRUMB_NAME,
                    true,
                )?),
            );
        }
        if let Some(level) = &self.level {
            value.insert(
                "level".to_string(),
                Value::String(normalize_breadcrumb_level(level)?),
            );
        }
        if let Some(message) = &self.message {
            value.insert(
                "message".to_string(),
                Value::String(require_text(
                    "issue breadcrumb message",
                    message,
                    MAX_BREADCRUMB_MESSAGE,
                    false,
                )?),
            );
        }
        if let Some(data) = &self.data {
            value.insert(
                "data".to_string(),
                Value::Object(copy_breadcrumb_data(data)?),
            );
        }
        Ok(value)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
/// Bounded caller-owned breadcrumb history for future issue snapshots.
pub struct IssueBreadcrumbBuffer {
    breadcrumbs: VecDeque<IssueBreadcrumb>,
    truncated: bool,
}

impl IssueBreadcrumbBuffer {
    /// Create an empty 64-entry breadcrumb buffer.
    pub fn new() -> Self {
        Self::default()
    }

    /// Record one breadcrumb, evicting the oldest entry when the buffer is full.
    pub fn push(&mut self, breadcrumb: IssueBreadcrumb) {
        if self.breadcrumbs.len() == MAX_BREADCRUMBS {
            self.breadcrumbs.pop_front();
            self.truncated = true;
        }
        self.breadcrumbs.push_back(breadcrumb);
    }

    /// Return the number of retained breadcrumbs.
    pub fn len(&self) -> usize {
        self.breadcrumbs.len()
    }

    /// Return whether no breadcrumbs are currently retained.
    pub fn is_empty(&self) -> bool {
        self.breadcrumbs.is_empty()
    }

    /// Return whether earlier breadcrumb history was evicted.
    pub fn is_truncated(&self) -> bool {
        self.truncated
    }

    /// Apply a detached oldest-to-newest snapshot to an issue event.
    pub fn apply_to(&self, issue: IssueEvent) -> IssueEvent {
        if self.breadcrumbs.is_empty() {
            return issue;
        }
        issue
            .with_breadcrumbs(self.breadcrumbs.iter().cloned())
            .with_breadcrumbs_truncated(self.truncated)
    }
}

pub(crate) fn error_type_name<E: ?Sized>() -> String {
    let candidate = std::any::type_name::<E>().trim();
    if candidate.is_empty() {
        return "Error".to_string();
    }
    let bounded = candidate
        .chars()
        .take(MAX_EXCEPTION_TYPE)
        .collect::<String>();
    safe_text(&bounded, MAX_EXCEPTION_TYPE, true, "Error")
}

pub(crate) fn panic_payload_type(payload: &(dyn std::any::Any + Send)) -> &'static str {
    if payload.is::<&'static str>() {
        "&str"
    } else if payload.is::<String>() {
        "String"
    } else {
        "unknown"
    }
}

pub(crate) fn require_exception_type(value: &str) -> Result<String, SdkError> {
    require_text("issue exception type", value, MAX_EXCEPTION_TYPE, true)
}

fn require_coordinate(label: &str, value: u32) -> Result<u32, SdkError> {
    if value == 0 || value > MAX_COORDINATE {
        return Err(validation(format!("{label} must be a positive integer")));
    }
    Ok(value)
}

fn sanitize_filename(value: &str) -> Result<String, SdkError> {
    let mut end = value.len();
    if let Some(index) = value.find('?') {
        end = end.min(index);
    }
    if let Some(index) = value.find('#') {
        end = end.min(index);
    }
    let normalized = value[..end].trim().replace('\\', "/");
    let without_trailing_separator = normalized.trim_end_matches('/');
    let basename = without_trailing_separator
        .rsplit('/')
        .next()
        .unwrap_or(without_trailing_separator);
    require_text(
        "issue stack frame filename",
        basename,
        MAX_FRAME_FILENAME,
        true,
    )
}

fn normalize_debug_id(value: &str) -> Result<String, SdkError> {
    let normalized = value.trim().to_ascii_lowercase();
    let bytes = normalized.as_bytes();
    let valid = bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit());
    if !valid {
        return Err(validation("issue stack frame debugId is invalid"));
    }
    Ok(normalized)
}

fn copy_breadcrumb_data(data: &Metadata) -> Result<Metadata, SdkError> {
    if data.len() > MAX_BREADCRUMB_DATA_FIELDS {
        return Err(validation(
            "issue breadcrumb data must contain at most 8 fields",
        ));
    }
    let mut copied = Metadata::new();
    for (key, value) in data {
        require_machine_name("issue breadcrumb data key", key, MAX_BREADCRUMB_NAME, false)
            .map_err(|_| validation("issue breadcrumb data keys must be stable machine names"))?;
        let copied_value = match value {
            Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
            Value::String(value) => Value::String(require_text(
                &format!("issue breadcrumb data value for {key}"),
                value,
                MAX_BREADCRUMB_DATA_STRING,
                false,
            )?),
            _ => {
                return Err(validation(format!(
                    "issue breadcrumb data value for {key} must be a finite primitive"
                )));
            }
        };
        copied.insert(key.clone(), copied_value);
    }
    Ok(copied)
}

fn normalize_breadcrumb_level(value: &str) -> Result<String, SdkError> {
    let normalized = match value.trim() {
        "trace" | "debug" => "debug",
        "log" | "info" => "info",
        "warn" | "warning" => "warning",
        "error" => "error",
        "fatal" | "critical" => "critical",
        _ => {
            return Err(validation(
                "issue breadcrumb level must be one of: trace, debug, info, log, warn, warning, error, fatal, critical",
            ));
        }
    };
    Ok(normalized.to_string())
}

fn require_machine_name(
    label: &str,
    value: &str,
    maximum: usize,
    allow_colon: bool,
) -> Result<String, SdkError> {
    let normalized = value.trim();
    let mut characters = normalized.chars();
    let Some(first) = characters.next() else {
        return Err(validation(format!("{label} must be a stable machine name")));
    };
    let valid = first.is_ascii_alphabetic()
        && normalized.chars().count() <= maximum
        && characters.all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '_' | '.' | '-')
                || (allow_colon && character == ':')
        });
    if !valid {
        return Err(validation(format!("{label} must be a stable machine name")));
    }
    Ok(normalized.to_string())
}

fn require_text(
    label: &str,
    value: &str,
    maximum: usize,
    reject_location_text: bool,
) -> Result<String, SdkError> {
    let normalized = value.trim();
    let invalid = normalized.is_empty()
        || normalized.chars().count() > maximum
        || normalized.chars().any(is_control_character)
        || (reject_location_text && (normalized.contains('?') || normalized.contains('#')));
    if invalid {
        return Err(validation(format!(
            "{label} is invalid or exceeds {maximum} characters"
        )));
    }
    Ok(normalized.to_string())
}

fn safe_text(value: &str, maximum: usize, reject_location_text: bool, fallback: &str) -> String {
    require_text(
        "issue diagnostic identity",
        value,
        maximum,
        reject_location_text,
    )
    .unwrap_or_else(|_| fallback.to_string())
}

fn is_control_character(character: char) -> bool {
    let codepoint = character as u32;
    codepoint <= 31 || (127..=159).contains(&codepoint)
}

fn require_breadcrumb_timestamp(value: &str) -> Result<String, SdkError> {
    let normalized = value.trim();
    if !is_rfc3339_timestamp(normalized) {
        return Err(validation(
            "issue breadcrumb timestamp must be RFC 3339 with an explicit timezone",
        ));
    }
    Ok(normalized.to_string())
}

fn is_rfc3339_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return false;
    }
    let Some(year) = digits(bytes, 0, 4) else {
        return false;
    };
    let Some(month) = digits(bytes, 5, 2) else {
        return false;
    };
    let Some(day) = digits(bytes, 8, 2) else {
        return false;
    };
    let Some(hour) = digits(bytes, 11, 2) else {
        return false;
    };
    let Some(minute) = digits(bytes, 14, 2) else {
        return false;
    };
    let Some(second) = digits(bytes, 17, 2) else {
        return false;
    };
    if year == 0
        || !(1..=12).contains(&month)
        || day == 0
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return false;
    }

    let mut index = 19;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let fractional_start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == fractional_start {
            return false;
        }
    }
    if bytes.get(index) == Some(&b'Z') {
        return index + 1 == bytes.len();
    }
    if !matches!(bytes.get(index), Some(b'+') | Some(b'-')) || index + 6 != bytes.len() {
        return false;
    }
    bytes.get(index + 3) == Some(&b':')
        && digits(bytes, index + 1, 2).is_some_and(|offset_hour| offset_hour <= 23)
        && digits(bytes, index + 4, 2).is_some_and(|offset_minute| offset_minute <= 59)
}

fn digits(bytes: &[u8], start: usize, length: usize) -> Option<u32> {
    let slice = bytes.get(start..start + length)?;
    if !slice.iter().all(u8::is_ascii_digit) {
        return None;
    }
    slice.iter().try_fold(0_u32, |value, digit| {
        value.checked_mul(10)?.checked_add(u32::from(digit - b'0'))
    })
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year.is_multiple_of(400) || (year.is_multiple_of(4) && !year.is_multiple_of(100)) => {
            29
        }
        2 => 28,
        _ => 0,
    }
}

fn validation(message: impl Into<String>) -> SdkError {
    SdkError::new("validation_error", message)
}
