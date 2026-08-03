use crate::SdkError;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::future::Future;
use std::marker::PhantomData;
use std::pin::Pin;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};

/// Current wire-contract version for shared LogBrew telemetry context.
pub const TELEMETRY_CONTEXT_SCHEMA_VERSION: u8 = 1;
const MAX_CONTEXT_STRING_CHARS: usize = 256;
const MAX_CONTEXT_ID_CHARS: usize = 200;
const MAX_TAG_KEY_CHARS: usize = 64;
const MAX_TAGS: usize = 32;
const ZERO_TRACE_ID: &str = "00000000000000000000000000000000";
const ZERO_SPAN_ID: &str = "0000000000000000";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Bounded service, runtime, or framework identity.
pub struct TelemetryNamedVersion {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

impl TelemetryNamedVersion {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            version: None,
        }
    }

    pub fn with_version(mut self, version: impl Into<String>) -> Self {
        self.version = Some(version.into());
        self
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Deployment environment and release identity.
pub struct TelemetryDeployment {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release: Option<String>,
}

impl TelemetryDeployment {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_environment(mut self, environment: impl Into<String>) -> Self {
        self.environment = Some(environment.into());
        self
    }

    pub fn with_release(mut self, release: impl Into<String>) -> Self {
        self.release = Some(release.into());
        self
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Operating-system family and optional safe version/build identity.
pub struct TelemetryOperatingSystem {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build: Option<String>,
}

impl TelemetryOperatingSystem {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            version: None,
            build: None,
        }
    }

    pub fn with_version(mut self, version: impl Into<String>) -> Self {
        self.version = Some(version.into());
        self
    }

    pub fn with_build(mut self, build: impl Into<String>) -> Self {
        self.build = Some(build.into());
        self
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Broad device or runtime-host class without unique host identity.
pub struct TelemetryDevice {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub architecture: Option<String>,
}

impl TelemetryDevice {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_family(mut self, family: impl Into<String>) -> Self {
        self.family = Some(family.into());
        self
    }

    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }

    pub fn with_architecture(mut self, architecture: impl Into<String>) -> Self {
        self.architecture = Some(architecture.into());
        self
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Instrumented application and build identity.
pub struct TelemetryApplication {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build: Option<String>,
}

impl TelemetryApplication {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    pub fn with_version(mut self, version: impl Into<String>) -> Self {
        self.version = Some(version.into());
        self
    }

    pub fn with_build(mut self, build: impl Into<String>) -> Self {
        self.build = Some(build.into());
        self
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Shared service, deployment, runtime, framework, OS, device, and app identity.
pub struct TelemetryResource {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<TelemetryNamedVersion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deployment: Option<TelemetryDeployment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<TelemetryNamedVersion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub framework: Option<TelemetryNamedVersion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operating_system: Option<TelemetryOperatingSystem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<TelemetryDevice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub application: Option<TelemetryApplication>,
}

impl TelemetryResource {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_service(mut self, service: TelemetryNamedVersion) -> Self {
        self.service = Some(service);
        self
    }

    pub fn with_deployment(mut self, deployment: TelemetryDeployment) -> Self {
        self.deployment = Some(deployment);
        self
    }

    pub fn with_runtime(mut self, runtime: TelemetryNamedVersion) -> Self {
        self.runtime = Some(runtime);
        self
    }

    pub fn with_framework(mut self, framework: TelemetryNamedVersion) -> Self {
        self.framework = Some(framework);
        self
    }

    pub fn with_operating_system(mut self, operating_system: TelemetryOperatingSystem) -> Self {
        self.operating_system = Some(operating_system);
        self
    }

    pub fn with_device(mut self, device: TelemetryDevice) -> Self {
        self.device = Some(device);
        self
    }

    pub fn with_application(mut self, application: TelemetryApplication) -> Self {
        self.application = Some(application);
        self
    }

    fn is_empty(&self) -> bool {
        self.service.is_none()
            && self.deployment.is_none()
            && self.runtime.is_none()
            && self.framework.is_none()
            && self.operating_system.is_none()
            && self.device.is_none()
            && self.application.is_none()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Exact W3C-compatible trace and span correlation.
pub struct TelemetryTraceContext {
    pub trace_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub span_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_span_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sampled: Option<bool>,
}

impl TelemetryTraceContext {
    pub fn new(trace_id: impl Into<String>) -> Self {
        Self {
            trace_id: trace_id.into(),
            span_id: None,
            parent_span_id: None,
            sampled: None,
        }
    }

    pub fn with_span_id(mut self, span_id: impl Into<String>) -> Self {
        self.span_id = Some(span_id.into());
        self
    }

    pub fn with_parent_span_id(mut self, parent_span_id: impl Into<String>) -> Self {
        self.parent_span_id = Some(parent_span_id.into());
        self
    }

    pub fn with_sampled(mut self, sampled: bool) -> Self {
        self.sampled = Some(sampled);
        self
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Opaque application-owned session identity.
pub struct TelemetrySessionContext {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_id: Option<String>,
}

impl TelemetrySessionContext {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            previous_id: None,
        }
    }

    pub fn with_previous_id(mut self, previous_id: impl Into<String>) -> Self {
        self.previous_id = Some(previous_id.into());
        self
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
/// Privacy classification for an opaque telemetry subject identifier.
pub enum TelemetrySubjectKind {
    Anonymous,
    User,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Explicit opaque user or anonymous identity without direct PII.
pub struct TelemetrySubjectContext {
    pub id: String,
    pub kind: TelemetrySubjectKind,
}

impl TelemetrySubjectContext {
    pub fn anonymous(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            kind: TelemetrySubjectKind::Anonymous,
        }
    }

    pub fn user(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            kind: TelemetrySubjectKind::User,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Versioned privacy-bounded context available on every LogBrew signal.
pub struct TelemetryContext {
    pub schema_version: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<TelemetryResource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace: Option<TelemetryTraceContext>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<TelemetrySessionContext>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<TelemetrySubjectContext>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tags: BTreeMap<String, String>,
}

impl Default for TelemetryContext {
    fn default() -> Self {
        Self::new()
    }
}

impl TelemetryContext {
    pub fn new() -> Self {
        Self {
            schema_version: TELEMETRY_CONTEXT_SCHEMA_VERSION,
            resource: None,
            trace: None,
            session: None,
            subject: None,
            tags: BTreeMap::new(),
        }
    }

    pub fn with_resource(mut self, resource: TelemetryResource) -> Self {
        self.resource = Some(resource);
        self
    }

    pub fn with_trace(mut self, trace: TelemetryTraceContext) -> Self {
        self.trace = Some(trace);
        self
    }

    pub fn with_session(mut self, session: TelemetrySessionContext) -> Self {
        self.session = Some(session);
        self
    }

    pub fn with_subject(mut self, subject: TelemetrySubjectContext) -> Self {
        self.subject = Some(subject);
        self
    }

    pub fn with_tag(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.tags.insert(key.into(), value.into());
        self
    }

    pub fn with_tags<I, K, V>(mut self, tags: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        self.tags.extend(
            tags.into_iter()
                .map(|(key, value)| (key.into(), value.into())),
        );
        self
    }

    /// Conservative Rust runtime, target OS-family, and architecture identity.
    pub fn runtime_defaults() -> Self {
        let resource = TelemetryResource::new()
            .with_runtime(TelemetryNamedVersion::new("rust"))
            .with_operating_system(TelemetryOperatingSystem::new(normalized_target_os()))
            .with_device(TelemetryDevice::new().with_architecture(std::env::consts::ARCH));
        Self::new().with_resource(resource)
    }
}

/// Validate, normalize, and detach one schema-v1 telemetry context.
pub fn validate_telemetry_context(
    context: &TelemetryContext,
) -> Result<TelemetryContext, SdkError> {
    validate_context(context, "telemetry context")
}

/// Merge base and override context using the same field-aware capture semantics as the client.
pub fn merge_telemetry_contexts(
    base: Option<&TelemetryContext>,
    override_context: Option<&TelemetryContext>,
) -> Result<Option<TelemetryContext>, SdkError> {
    let base = base
        .map(|context| validate_context(context, "base telemetry context"))
        .transpose()?;
    let override_context = override_context
        .map(|context| validate_context(context, "override telemetry context"))
        .transpose()?;
    merge_normalized_contexts(base, override_context)
}

fn validate_context(context: &TelemetryContext, label: &str) -> Result<TelemetryContext, SdkError> {
    if context.schema_version != TELEMETRY_CONTEXT_SCHEMA_VERSION {
        return Err(invalid_context(format!(
            "{label} schemaVersion must be {TELEMETRY_CONTEXT_SCHEMA_VERSION}"
        )));
    }
    let resource = context
        .resource
        .as_ref()
        .map(|resource| validate_resource(resource, &format!("{label} resource")))
        .transpose()?;
    let trace = context
        .trace
        .as_ref()
        .map(|trace| validate_trace(trace, &format!("{label} trace")))
        .transpose()?;
    let session = context
        .session
        .as_ref()
        .map(|session| validate_session(session, &format!("{label} session")))
        .transpose()?;
    let subject = context
        .subject
        .as_ref()
        .map(|subject| validate_subject(subject, &format!("{label} subject")))
        .transpose()?;
    let tags = validate_tags(&context.tags, &format!("{label} tags"))?;
    if resource.is_none()
        && trace.is_none()
        && session.is_none()
        && subject.is_none()
        && tags.is_empty()
    {
        return Err(invalid_context(format!(
            "{label} must include resource, trace, session, subject, or tags"
        )));
    }
    Ok(TelemetryContext {
        schema_version: TELEMETRY_CONTEXT_SCHEMA_VERSION,
        resource,
        trace,
        session,
        subject,
        tags,
    })
}

fn validate_resource(
    resource: &TelemetryResource,
    label: &str,
) -> Result<TelemetryResource, SdkError> {
    if resource.is_empty() {
        return Err(invalid_context(format!("{label} must not be empty")));
    }
    Ok(TelemetryResource {
        service: resource
            .service
            .as_ref()
            .map(|value| validate_named_version(value, &format!("{label} service")))
            .transpose()?,
        deployment: resource
            .deployment
            .as_ref()
            .map(|value| validate_deployment(value, &format!("{label} deployment")))
            .transpose()?,
        runtime: resource
            .runtime
            .as_ref()
            .map(|value| validate_named_version(value, &format!("{label} runtime")))
            .transpose()?,
        framework: resource
            .framework
            .as_ref()
            .map(|value| validate_named_version(value, &format!("{label} framework")))
            .transpose()?,
        operating_system: resource
            .operating_system
            .as_ref()
            .map(|value| validate_operating_system(value, &format!("{label} operatingSystem")))
            .transpose()?,
        device: resource
            .device
            .as_ref()
            .map(|value| validate_device(value, &format!("{label} device")))
            .transpose()?,
        application: resource
            .application
            .as_ref()
            .map(|value| validate_application(value, &format!("{label} application")))
            .transpose()?,
    })
}

fn validate_named_version(
    value: &TelemetryNamedVersion,
    label: &str,
) -> Result<TelemetryNamedVersion, SdkError> {
    Ok(TelemetryNamedVersion {
        name: required_string(
            &value.name,
            &format!("{label} name"),
            MAX_CONTEXT_STRING_CHARS,
        )?,
        version: optional_string(
            value.version.as_deref(),
            &format!("{label} version"),
            MAX_CONTEXT_STRING_CHARS,
        )?,
    })
}

fn validate_deployment(
    value: &TelemetryDeployment,
    label: &str,
) -> Result<TelemetryDeployment, SdkError> {
    let value = TelemetryDeployment {
        environment: optional_string(
            value.environment.as_deref(),
            &format!("{label} environment"),
            MAX_CONTEXT_STRING_CHARS,
        )?,
        release: optional_string(
            value.release.as_deref(),
            &format!("{label} release"),
            MAX_CONTEXT_STRING_CHARS,
        )?,
    };
    if value.environment.is_none() && value.release.is_none() {
        return Err(invalid_context(format!("{label} must not be empty")));
    }
    Ok(value)
}

fn validate_operating_system(
    value: &TelemetryOperatingSystem,
    label: &str,
) -> Result<TelemetryOperatingSystem, SdkError> {
    Ok(TelemetryOperatingSystem {
        name: required_string(
            &value.name,
            &format!("{label} name"),
            MAX_CONTEXT_STRING_CHARS,
        )?,
        version: optional_string(
            value.version.as_deref(),
            &format!("{label} version"),
            MAX_CONTEXT_STRING_CHARS,
        )?,
        build: optional_string(
            value.build.as_deref(),
            &format!("{label} build"),
            MAX_CONTEXT_STRING_CHARS,
        )?,
    })
}

fn validate_device(value: &TelemetryDevice, label: &str) -> Result<TelemetryDevice, SdkError> {
    let value = TelemetryDevice {
        family: optional_string(
            value.family.as_deref(),
            &format!("{label} family"),
            MAX_CONTEXT_STRING_CHARS,
        )?,
        model: optional_string(
            value.model.as_deref(),
            &format!("{label} model"),
            MAX_CONTEXT_STRING_CHARS,
        )?,
        architecture: optional_string(
            value.architecture.as_deref(),
            &format!("{label} architecture"),
            MAX_CONTEXT_STRING_CHARS,
        )?,
    };
    if value.family.is_none() && value.model.is_none() && value.architecture.is_none() {
        return Err(invalid_context(format!("{label} must not be empty")));
    }
    Ok(value)
}

fn validate_application(
    value: &TelemetryApplication,
    label: &str,
) -> Result<TelemetryApplication, SdkError> {
    let value = TelemetryApplication {
        name: optional_string(
            value.name.as_deref(),
            &format!("{label} name"),
            MAX_CONTEXT_STRING_CHARS,
        )?,
        version: optional_string(
            value.version.as_deref(),
            &format!("{label} version"),
            MAX_CONTEXT_STRING_CHARS,
        )?,
        build: optional_string(
            value.build.as_deref(),
            &format!("{label} build"),
            MAX_CONTEXT_STRING_CHARS,
        )?,
    };
    if value.name.is_none() && value.version.is_none() && value.build.is_none() {
        return Err(invalid_context(format!("{label} must not be empty")));
    }
    Ok(value)
}

fn validate_trace(
    value: &TelemetryTraceContext,
    label: &str,
) -> Result<TelemetryTraceContext, SdkError> {
    Ok(TelemetryTraceContext {
        trace_id: hex_id(
            &value.trace_id,
            32,
            ZERO_TRACE_ID,
            &format!("{label} traceId"),
        )?,
        span_id: optional_hex_id(
            value.span_id.as_deref(),
            16,
            ZERO_SPAN_ID,
            &format!("{label} spanId"),
        )?,
        parent_span_id: optional_hex_id(
            value.parent_span_id.as_deref(),
            16,
            ZERO_SPAN_ID,
            &format!("{label} parentSpanId"),
        )?,
        sampled: value.sampled,
    })
}

fn validate_session(
    value: &TelemetrySessionContext,
    label: &str,
) -> Result<TelemetrySessionContext, SdkError> {
    let id = required_string(&value.id, &format!("{label} id"), MAX_CONTEXT_ID_CHARS)?;
    let previous_id = optional_string(
        value.previous_id.as_deref(),
        &format!("{label} previousId"),
        MAX_CONTEXT_ID_CHARS,
    )?;
    if previous_id.as_deref() == Some(id.as_str()) {
        return Err(invalid_context(format!(
            "{label} previousId must differ from id"
        )));
    }
    Ok(TelemetrySessionContext { id, previous_id })
}

fn validate_subject(
    value: &TelemetrySubjectContext,
    label: &str,
) -> Result<TelemetrySubjectContext, SdkError> {
    Ok(TelemetrySubjectContext {
        id: required_string(&value.id, &format!("{label} id"), MAX_CONTEXT_ID_CHARS)?,
        kind: value.kind,
    })
}

fn validate_tags(
    tags: &BTreeMap<String, String>,
    label: &str,
) -> Result<BTreeMap<String, String>, SdkError> {
    if tags.len() > MAX_TAGS {
        return Err(invalid_context(format!(
            "{label} must contain at most {MAX_TAGS} entries"
        )));
    }
    let mut normalized = BTreeMap::new();
    for (key, value) in tags {
        if !valid_tag_key(key) {
            return Err(invalid_context(format!("{label} key is invalid")));
        }
        normalized.insert(
            key.clone(),
            required_string(
                value,
                &format!("{label} value for {key}"),
                MAX_CONTEXT_STRING_CHARS,
            )?,
        );
    }
    Ok(normalized)
}

fn required_string(value: &str, label: &str, maximum: usize) -> Result<String, SdkError> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > maximum
        || value.chars().any(is_forbidden_control)
    {
        return Err(invalid_context(format!("{label} is invalid")));
    }
    Ok(value.to_string())
}

fn optional_string(
    value: Option<&str>,
    label: &str,
    maximum: usize,
) -> Result<Option<String>, SdkError> {
    value
        .map(|value| required_string(value, label, maximum))
        .transpose()
}

fn is_forbidden_control(value: char) -> bool {
    let value = value as u32;
    value <= 0x1f || (0x7f..=0x9f).contains(&value)
}

fn valid_tag_key(value: &str) -> bool {
    if value.is_empty() || value.chars().count() > MAX_TAG_KEY_CHARS {
        return false;
    }
    let mut bytes = value.bytes();
    bytes.next().is_some_and(|byte| byte.is_ascii_alphabetic())
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

fn hex_id(value: &str, length: usize, zero: &str, label: &str) -> Result<String, SdkError> {
    let value = value.trim().to_ascii_lowercase();
    if value.len() != length || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) || value == zero
    {
        return Err(invalid_context(format!(
            "{label} must be {length} non-zero hex characters"
        )));
    }
    Ok(value)
}

fn optional_hex_id(
    value: Option<&str>,
    length: usize,
    zero: &str,
    label: &str,
) -> Result<Option<String>, SdkError> {
    value
        .map(|value| hex_id(value, length, zero, label))
        .transpose()
}

fn invalid_context(message: impl Into<String>) -> SdkError {
    SdkError::new("validation_error", message)
}

fn merge_normalized_contexts(
    base: Option<TelemetryContext>,
    override_context: Option<TelemetryContext>,
) -> Result<Option<TelemetryContext>, SdkError> {
    let merged = match (base, override_context) {
        (None, None) => return Ok(None),
        (Some(context), None) | (None, Some(context)) => context,
        (Some(base), Some(override_context)) => {
            let mut tags = base.tags;
            tags.extend(override_context.tags);
            TelemetryContext {
                schema_version: TELEMETRY_CONTEXT_SCHEMA_VERSION,
                resource: merge_resources(base.resource, override_context.resource),
                trace: override_context.trace.or(base.trace),
                session: override_context.session.or(base.session),
                subject: override_context.subject.or(base.subject),
                tags,
            }
        }
    };
    validate_context(&merged, "merged telemetry context").map(Some)
}

fn merge_resources(
    base: Option<TelemetryResource>,
    override_resource: Option<TelemetryResource>,
) -> Option<TelemetryResource> {
    match (base, override_resource) {
        (None, None) => None,
        (Some(resource), None) | (None, Some(resource)) => Some(resource),
        (Some(base), Some(override_resource)) => Some(TelemetryResource {
            service: merge_named_version(base.service, override_resource.service),
            deployment: merge_deployment(base.deployment, override_resource.deployment),
            runtime: merge_named_version(base.runtime, override_resource.runtime),
            framework: merge_named_version(base.framework, override_resource.framework),
            operating_system: merge_operating_system(
                base.operating_system,
                override_resource.operating_system,
            ),
            device: merge_device(base.device, override_resource.device),
            application: merge_application(base.application, override_resource.application),
        }),
    }
}

fn merge_named_version(
    base: Option<TelemetryNamedVersion>,
    override_value: Option<TelemetryNamedVersion>,
) -> Option<TelemetryNamedVersion> {
    match (base, override_value) {
        (None, None) => None,
        (Some(value), None) | (None, Some(value)) => Some(value),
        (Some(base), Some(override_value)) => Some(TelemetryNamedVersion {
            name: override_value.name,
            version: override_value.version.or(base.version),
        }),
    }
}

fn merge_deployment(
    base: Option<TelemetryDeployment>,
    override_value: Option<TelemetryDeployment>,
) -> Option<TelemetryDeployment> {
    match (base, override_value) {
        (None, None) => None,
        (Some(value), None) | (None, Some(value)) => Some(value),
        (Some(base), Some(override_value)) => Some(TelemetryDeployment {
            environment: override_value.environment.or(base.environment),
            release: override_value.release.or(base.release),
        }),
    }
}

fn merge_operating_system(
    base: Option<TelemetryOperatingSystem>,
    override_value: Option<TelemetryOperatingSystem>,
) -> Option<TelemetryOperatingSystem> {
    match (base, override_value) {
        (None, None) => None,
        (Some(value), None) | (None, Some(value)) => Some(value),
        (Some(base), Some(override_value)) => Some(TelemetryOperatingSystem {
            name: override_value.name,
            version: override_value.version.or(base.version),
            build: override_value.build.or(base.build),
        }),
    }
}

fn merge_device(
    base: Option<TelemetryDevice>,
    override_value: Option<TelemetryDevice>,
) -> Option<TelemetryDevice> {
    match (base, override_value) {
        (None, None) => None,
        (Some(value), None) | (None, Some(value)) => Some(value),
        (Some(base), Some(override_value)) => Some(TelemetryDevice {
            family: override_value.family.or(base.family),
            model: override_value.model.or(base.model),
            architecture: override_value.architecture.or(base.architecture),
        }),
    }
}

fn merge_application(
    base: Option<TelemetryApplication>,
    override_value: Option<TelemetryApplication>,
) -> Option<TelemetryApplication> {
    match (base, override_value) {
        (None, None) => None,
        (Some(value), None) | (None, Some(value)) => Some(value),
        (Some(base), Some(override_value)) => Some(TelemetryApplication {
            name: override_value.name.or(base.name),
            version: override_value.version.or(base.version),
            build: override_value.build.or(base.build),
        }),
    }
}

fn normalized_target_os() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        value => value,
    }
}

#[derive(Clone)]
struct ActiveContext {
    token: u64,
    context: TelemetryContext,
}

thread_local! {
    static ACTIVE_CONTEXTS: RefCell<Vec<ActiveContext>> = const { RefCell::new(Vec::new()) };
}

static NEXT_CONTEXT_TOKEN: AtomicU64 = AtomicU64::new(1);

/// Return a detached snapshot of the current thread/poll-scoped telemetry context.
pub fn current_telemetry_context() -> Option<TelemetryContext> {
    ACTIVE_CONTEXTS.with(|contexts| {
        contexts
            .borrow()
            .iter()
            .try_fold(None, |merged, active| {
                merge_normalized_contexts(merged, Some(active.context.clone()))
            })
            .expect("active telemetry contexts were validated before insertion")
    })
}

/// Activate context for the current synchronous thread until the guard closes or drops.
pub fn activate_telemetry_context(
    context: TelemetryContext,
) -> Result<TelemetryContextGuard, SdkError> {
    let context = validate_context(&context, "active telemetry context")?;
    merge_normalized_contexts(current_telemetry_context(), Some(context.clone()))?;
    let token = NEXT_CONTEXT_TOKEN.fetch_add(1, Ordering::Relaxed);
    ACTIVE_CONTEXTS.with(|contexts| contexts.borrow_mut().push(ActiveContext { token, context }));
    Ok(TelemetryContextGuard {
        token: Some(token),
        not_send: PhantomData,
    })
}

/// Run one synchronous closure with context and restore the exact previous scope on unwind.
pub fn with_telemetry_context<F, R>(context: TelemetryContext, operation: F) -> Result<R, SdkError>
where
    F: FnOnce() -> R,
{
    let _guard = activate_telemetry_context(context)?;
    Ok(operation())
}

#[derive(Debug)]
#[must_use = "the guard must be kept alive for the intended synchronous context scope"]
/// Same-thread RAII guard returned by [`activate_telemetry_context`].
pub struct TelemetryContextGuard {
    token: Option<u64>,
    not_send: PhantomData<Rc<()>>,
}

impl TelemetryContextGuard {
    /// Restore this guard's context contribution. Repeated calls are harmless.
    pub fn close(&mut self) {
        let Some(token) = self.token.take() else {
            return;
        };
        ACTIVE_CONTEXTS.with(|contexts| {
            let mut contexts = contexts.borrow_mut();
            if let Some(index) = contexts.iter().position(|active| active.token == token) {
                contexts.remove(index);
            }
        });
    }
}

impl Drop for TelemetryContextGuard {
    fn drop(&mut self) {
        self.close();
    }
}

/// Wrap a future so context is installed only while each poll runs.
pub fn with_telemetry_context_async<F>(
    context: TelemetryContext,
    future: F,
) -> Result<TelemetryContextFuture<F>, SdkError>
where
    F: Future,
{
    Ok(TelemetryContextFuture {
        context: validate_context(&context, "async telemetry context")?,
        future: Box::pin(future),
        completed: false,
    })
}

/// Executor-safe future wrapper returned by [`with_telemetry_context_async`].
#[must_use = "futures do nothing unless polled or awaited"]
pub struct TelemetryContextFuture<F> {
    context: TelemetryContext,
    future: Pin<Box<F>>,
    completed: bool,
}

impl<F> Future for TelemetryContextFuture<F>
where
    F: Future,
{
    type Output = Result<F::Output, SdkError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        if self.completed {
            panic!("TelemetryContextFuture polled after completion");
        }
        let guard = match activate_telemetry_context(self.context.clone()) {
            Ok(guard) => guard,
            Err(error) => {
                self.completed = true;
                return Poll::Ready(Err(error));
            }
        };
        let result = self.future.as_mut().poll(cx);
        drop(guard);
        match result {
            Poll::Pending => Poll::Pending,
            Poll::Ready(output) => {
                self.completed = true;
                Poll::Ready(Ok(output))
            }
        }
    }
}

pub(crate) fn context_to_value(context: &TelemetryContext) -> Result<serde_json::Value, SdkError> {
    let context = validate_context(context, "event telemetry context")?;
    serde_json::to_value(context).map_err(|_| {
        SdkError::new(
            "serialization_error",
            "telemetry context could not be serialized",
        )
    })
}

pub(crate) fn context_from_value(value: serde_json::Value) -> Result<TelemetryContext, SdkError> {
    let context: TelemetryContext = serde_json::from_value(value)
        .map_err(|_| invalid_context("event context must be a TelemetryContext"))?;
    validate_context(&context, "event telemetry context")
}

pub(crate) fn merge_captured_contexts(
    contexts: impl IntoIterator<Item = Option<TelemetryContext>>,
) -> Result<Option<TelemetryContext>, SdkError> {
    contexts.into_iter().try_fold(None, |merged, context| {
        merge_normalized_contexts(merged, context)
    })
}
