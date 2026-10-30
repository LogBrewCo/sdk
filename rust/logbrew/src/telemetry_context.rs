use crate::SdkError;
use alloc::collections::BTreeMap;
use alloc::rc::Rc;
use core::cell::RefCell;
use core::marker::PhantomData;
use core::pin::Pin;
use core::sync::atomic::{AtomicU64, Ordering};
use core::task::{Context, Poll};
use serde::{Deserialize, Serialize};
use std::env::consts;

/// Current wire-contract version for shared LogBrew telemetry context.
pub const TELEMETRY_CONTEXT_SCHEMA_VERSION: u8 = 1;

const MAX_CONTEXT_STRING_CHARS: usize = 256;
const MAX_CONTEXT_ID_CHARS: usize = 200;
const MAX_TAG_KEY_CHARS: usize = 64;
const MAX_TAGS: usize = 32;
const ZERO_TRACE_ID: &str = "00000000000000000000000000000000";
const ZERO_SPAN_ID: &str = "0000000000000000";

thread_local! {
    static ACTIVE_CONTEXTS: RefCell<Vec<ActiveContext>> = const { RefCell::new(Vec::new()) };
}

static NEXT_CONTEXT_TOKEN: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Bounded service, runtime, or framework identity.
pub struct TelemetryNamedVersion {
    /// Service, runtime, or framework name.
    pub name: String,
    /// Version label.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

impl TelemetryNamedVersion {
    /// Create an identity with a name and no version.
    #[inline]
    pub fn new<NameInput>(name: NameInput) -> Self
    where
        NameInput: Into<String>,
    {
        Self {
            name: name.into(),
            version: None,
        }
    }

    /// Set the version label.
    #[must_use]
    #[inline]
    pub fn with_version<VersionInput>(mut self, version: VersionInput) -> Self
    where
        VersionInput: Into<String>,
    {
        self.version = Some(version.into());
        self
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Deployment environment and release identity.
pub struct TelemetryDeployment {
    /// Deployment environment, such as `production`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    /// Release identifier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release: Option<String>,
}

impl TelemetryDeployment {
    /// Create an empty deployment identity.
    #[must_use]
    #[inline]
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the deployment environment.
    #[must_use]
    #[inline]
    pub fn with_environment<Environment>(mut self, environment: Environment) -> Self
    where
        Environment: Into<String>,
    {
        self.environment = Some(environment.into());
        self
    }

    /// Set the release identifier.
    #[must_use]
    #[inline]
    pub fn with_release<Release>(mut self, release: Release) -> Self
    where
        Release: Into<String>,
    {
        self.release = Some(release.into());
        self
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Operating-system family and optional safe version/build identity.
pub struct TelemetryOperatingSystem {
    /// Operating-system family, such as `linux`.
    pub name: String,
    /// Operating-system version.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Operating-system build identifier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build: Option<String>,
}

impl TelemetryOperatingSystem {
    /// Create an operating-system identity from its family name.
    #[inline]
    pub fn new<NameInput>(name: NameInput) -> Self
    where
        NameInput: Into<String>,
    {
        Self {
            name: name.into(),
            version: None,
            build: None,
        }
    }

    /// Set the operating-system build identifier.
    #[must_use]
    #[inline]
    pub fn with_build<BuildInput>(mut self, build: BuildInput) -> Self
    where
        BuildInput: Into<String>,
    {
        self.build = Some(build.into());
        self
    }

    /// Set the operating-system version.
    #[must_use]
    #[inline]
    pub fn with_version<VersionInput>(mut self, version: VersionInput) -> Self
    where
        VersionInput: Into<String>,
    {
        self.version = Some(version.into());
        self
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Broad device or runtime-host class without unique host identity.
pub struct TelemetryDevice {
    /// Device family, such as `server` or `desktop`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    /// Device model class.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// CPU architecture, such as `aarch64`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub architecture: Option<String>,
}

impl TelemetryDevice {
    /// Create an empty device identity.
    #[must_use]
    #[inline]
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the CPU architecture.
    #[must_use]
    #[inline]
    pub fn with_architecture<Architecture>(mut self, architecture: Architecture) -> Self
    where
        Architecture: Into<String>,
    {
        self.architecture = Some(architecture.into());
        self
    }

    /// Set the device family.
    #[must_use]
    #[inline]
    pub fn with_family<Family>(mut self, family: Family) -> Self
    where
        Family: Into<String>,
    {
        self.family = Some(family.into());
        self
    }

    /// Set the device model class.
    #[must_use]
    #[inline]
    pub fn with_model<Model>(mut self, model: Model) -> Self
    where
        Model: Into<String>,
    {
        self.model = Some(model.into());
        self
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Instrumented application and build identity.
pub struct TelemetryApplication {
    /// Application name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Application version.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Application build identifier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build: Option<String>,
}

impl TelemetryApplication {
    /// Create an empty application identity.
    #[must_use]
    #[inline]
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the application build identifier.
    #[must_use]
    #[inline]
    pub fn with_build<Build>(mut self, build: Build) -> Self
    where
        Build: Into<String>,
    {
        self.build = Some(build.into());
        self
    }

    /// Set the application name.
    #[must_use]
    #[inline]
    pub fn with_name<Name>(mut self, name: Name) -> Self
    where
        Name: Into<String>,
    {
        self.name = Some(name.into());
        self
    }

    /// Set the application version.
    #[must_use]
    #[inline]
    pub fn with_version<Version>(mut self, version: Version) -> Self
    where
        Version: Into<String>,
    {
        self.version = Some(version.into());
        self
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Shared service, deployment, runtime, framework, OS, device, and app identity.
pub struct TelemetryResource {
    /// Service name and version.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<TelemetryNamedVersion>,
    /// Deployment environment and release.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deployment: Option<TelemetryDeployment>,
    /// Runtime name and version.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<TelemetryNamedVersion>,
    /// Framework name and version.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub framework: Option<TelemetryNamedVersion>,
    /// Operating-system identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operating_system: Option<TelemetryOperatingSystem>,
    /// Device or host class.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<TelemetryDevice>,
    /// Application identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub application: Option<TelemetryApplication>,
}

impl TelemetryResource {
    const fn is_empty(&self) -> bool {
        self.service.is_none()
            && self.deployment.is_none()
            && self.runtime.is_none()
            && self.framework.is_none()
            && self.operating_system.is_none()
            && self.device.is_none()
            && self.application.is_none()
    }

    /// Create an empty resource.
    #[must_use]
    #[inline]
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the application identity.
    #[must_use]
    #[inline]
    pub fn with_application(mut self, application: TelemetryApplication) -> Self {
        self.application = Some(application);
        self
    }

    /// Set the deployment identity.
    #[must_use]
    #[inline]
    pub fn with_deployment(mut self, deployment: TelemetryDeployment) -> Self {
        self.deployment = Some(deployment);
        self
    }

    /// Set the device identity.
    #[must_use]
    #[inline]
    pub fn with_device(mut self, device: TelemetryDevice) -> Self {
        self.device = Some(device);
        self
    }

    /// Set the framework identity.
    #[must_use]
    #[inline]
    pub fn with_framework(mut self, framework: TelemetryNamedVersion) -> Self {
        self.framework = Some(framework);
        self
    }

    /// Set the operating-system identity.
    #[must_use]
    #[inline]
    pub fn with_operating_system(mut self, operating_system: TelemetryOperatingSystem) -> Self {
        self.operating_system = Some(operating_system);
        self
    }

    /// Set the runtime identity.
    #[must_use]
    #[inline]
    pub fn with_runtime(mut self, runtime: TelemetryNamedVersion) -> Self {
        self.runtime = Some(runtime);
        self
    }

    /// Set the service identity.
    #[must_use]
    #[inline]
    pub fn with_service(mut self, service: TelemetryNamedVersion) -> Self {
        self.service = Some(service);
        self
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Exact W3C-compatible trace and span correlation.
pub struct TelemetryTraceContext {
    /// 32-character W3C trace ID.
    pub trace_id: String,
    /// 16-character W3C span ID.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub span_id: Option<String>,
    /// Parent span ID.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_span_id: Option<String>,
    /// Whether the trace is sampled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sampled: Option<bool>,
}

impl TelemetryTraceContext {
    /// Create trace context from a trace ID.
    #[inline]
    pub fn new<TraceId>(trace_id: TraceId) -> Self
    where
        TraceId: Into<String>,
    {
        Self {
            trace_id: trace_id.into(),
            span_id: None,
            parent_span_id: None,
            sampled: None,
        }
    }

    /// Set the parent span ID.
    #[must_use]
    #[inline]
    pub fn with_parent_span_id<ParentSpanId>(mut self, parent_span_id: ParentSpanId) -> Self
    where
        ParentSpanId: Into<String>,
    {
        self.parent_span_id = Some(parent_span_id.into());
        self
    }

    /// Set the sampled flag.
    #[must_use]
    #[inline]
    pub const fn with_sampled(mut self, sampled: bool) -> Self {
        self.sampled = Some(sampled);
        self
    }

    /// Set the span ID.
    #[must_use]
    #[inline]
    pub fn with_span_id<SpanId>(mut self, span_id: SpanId) -> Self
    where
        SpanId: Into<String>,
    {
        self.span_id = Some(span_id.into());
        self
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Opaque application-owned session identity.
pub struct TelemetrySessionContext {
    /// Session ID.
    pub id: String,
    /// ID of the session this one replaced.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_id: Option<String>,
}

impl TelemetrySessionContext {
    /// Create session context from a session ID.
    #[inline]
    pub fn new<IdInput>(id: IdInput) -> Self
    where
        IdInput: Into<String>,
    {
        Self {
            id: id.into(),
            previous_id: None,
        }
    }

    /// Set the previous session ID.
    #[must_use]
    #[inline]
    pub fn with_previous_id<PreviousId>(mut self, previous_id: PreviousId) -> Self
    where
        PreviousId: Into<String>,
    {
        self.previous_id = Some(previous_id.into());
        self
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
/// Privacy classification for an opaque telemetry subject identifier.
pub enum TelemetrySubjectKind {
    /// An anonymous visitor or device.
    Anonymous,
    /// A signed-in user.
    User,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Explicit opaque user or anonymous identity without direct PII.
pub struct TelemetrySubjectContext {
    /// Subject ID.
    pub id: String,
    /// Whether the subject is anonymous or a user.
    pub kind: TelemetrySubjectKind,
}

impl TelemetrySubjectContext {
    /// Create an anonymous subject.
    #[inline]
    pub fn anonymous<IdInput>(id: IdInput) -> Self
    where
        IdInput: Into<String>,
    {
        Self {
            id: id.into(),
            kind: TelemetrySubjectKind::Anonymous,
        }
    }

    /// Create a user subject.
    #[inline]
    pub fn user<Id>(id: Id) -> Self
    where
        Id: Into<String>,
    {
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
    /// Context schema version; always 1.
    pub schema_version: u8,
    /// Service, runtime, and host identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<TelemetryResource>,
    /// Trace context.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace: Option<TelemetryTraceContext>,
    /// Session context.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<TelemetrySessionContext>,
    /// Anonymous or user subject.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<TelemetrySubjectContext>,
    /// Low-cardinality string tags.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tags: BTreeMap<String, String>,
}

impl Default for TelemetryContext {
    #[inline]
    fn default() -> Self {
        Self::new()
    }
}

impl TelemetryContext {
    fn into_validated(self, label: &str) -> Result<Self, SdkError> {
        validate_context(&self, label)
    }

    /// Create an empty schema-v1 context.
    #[must_use]
    #[inline]
    pub const fn new() -> Self {
        Self {
            schema_version: TELEMETRY_CONTEXT_SCHEMA_VERSION,
            resource: None,
            trace: None,
            session: None,
            subject: None,
            tags: BTreeMap::new(),
        }
    }

    /// Conservative Rust runtime, target OS-family, and architecture identity.
    #[must_use]
    #[inline]
    pub fn runtime_defaults() -> Self {
        let resource = TelemetryResource::new()
            .with_runtime(TelemetryNamedVersion::new("rust"))
            .with_operating_system(TelemetryOperatingSystem::new(normalized_target_os()))
            .with_device(TelemetryDevice::new().with_architecture(consts::ARCH));
        Self::new().with_resource(resource)
    }

    /// Set the resource identity.
    #[must_use]
    #[inline]
    pub fn with_resource(mut self, resource: TelemetryResource) -> Self {
        self.resource = Some(resource);
        self
    }

    /// Set the session context.
    #[must_use]
    #[inline]
    pub fn with_session(mut self, session: TelemetrySessionContext) -> Self {
        self.session = Some(session);
        self
    }

    /// Set the subject.
    #[must_use]
    #[inline]
    pub fn with_subject(mut self, subject: TelemetrySubjectContext) -> Self {
        self.subject = Some(subject);
        self
    }

    /// Add one tag.
    #[must_use]
    #[inline]
    pub fn with_tag<Key, ValueInput>(mut self, key: Key, value: ValueInput) -> Self
    where
        Key: Into<String>,
        ValueInput: Into<String>,
    {
        drop(self.tags.insert(key.into(), value.into()));
        self
    }

    /// Add several tags.
    #[must_use]
    #[inline]
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

    /// Set the trace context.
    #[must_use]
    #[inline]
    pub fn with_trace(mut self, trace: TelemetryTraceContext) -> Self {
        self.trace = Some(trace);
        self
    }
}

#[derive(Clone)]
struct ActiveContext {
    token: u64,
    context: TelemetryContext,
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
    #[inline]
    pub fn close(&mut self) {
        let Some(token) = self.token.take() else {
            return;
        };
        ACTIVE_CONTEXTS.with(|contexts| {
            let mut active_contexts = contexts.borrow_mut();
            if let Some(index) = active_contexts
                .iter()
                .position(|active| active.token == token)
            {
                drop(active_contexts.remove(index));
            }
        });
    }
}

impl Drop for TelemetryContextGuard {
    #[inline]
    fn drop(&mut self) {
        self.close();
    }
}

/// Executor-safe future wrapper returned by [`with_telemetry_context_async`].
#[derive(Debug)]
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

    #[inline]
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        assert!(
            !self.completed,
            "TelemetryContextFuture polled after completion"
        );
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

/// Validate, normalize, and detach one schema-v1 telemetry context.
///
/// # Errors
///
/// Returns an [`SdkError`] when an input fails validation.
#[inline]
pub fn validate_telemetry_context(
    context: &TelemetryContext,
) -> Result<TelemetryContext, SdkError> {
    validate_context(context, "telemetry context")
}

/// Merge base and override context using the same field-aware capture semantics as the client.
///
/// # Errors
///
/// Returns an [`SdkError`] when an input fails validation.
#[inline]
pub fn merge_telemetry_contexts(
    base: Option<&TelemetryContext>,
    override_context: Option<&TelemetryContext>,
) -> Result<Option<TelemetryContext>, SdkError> {
    let validated_base = base
        .map(|context| validate_context(context, "base telemetry context"))
        .transpose()?;
    let validated_override = override_context
        .map(|context| validate_context(context, "override telemetry context"))
        .transpose()?;
    merge_normalized_contexts(validated_base, validated_override)
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
    let normalized = TelemetryDeployment {
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
    if normalized.environment.is_none() && normalized.release.is_none() {
        return Err(invalid_context(format!("{label} must not be empty")));
    }
    Ok(normalized)
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
    let normalized = TelemetryDevice {
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
    if normalized.family.is_none()
        && normalized.model.is_none()
        && normalized.architecture.is_none()
    {
        return Err(invalid_context(format!("{label} must not be empty")));
    }
    Ok(normalized)
}

fn validate_application(
    value: &TelemetryApplication,
    label: &str,
) -> Result<TelemetryApplication, SdkError> {
    let normalized = TelemetryApplication {
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
    if normalized.name.is_none() && normalized.version.is_none() && normalized.build.is_none() {
        return Err(invalid_context(format!("{label} must not be empty")));
    }
    Ok(normalized)
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
        drop(normalized.insert(
            key.clone(),
            required_string(
                value,
                &format!("{label} value for {key}"),
                MAX_CONTEXT_STRING_CHARS,
            )?,
        ));
    }
    Ok(normalized)
}

fn required_string(value: &str, label: &str, maximum: usize) -> Result<String, SdkError> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > maximum
        || trimmed.chars().any(is_forbidden_control)
    {
        return Err(invalid_context(format!("{label} is invalid")));
    }
    Ok(trimmed.to_owned())
}

fn optional_string(
    value: Option<&str>,
    label: &str,
    maximum: usize,
) -> Result<Option<String>, SdkError> {
    value
        .map(|text| required_string(text, label, maximum))
        .transpose()
}

fn is_forbidden_control(value: char) -> bool {
    let code = u32::from(value);
    code <= 0x1f || (0x7f..=0x9f).contains(&code)
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
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.len() != length
        || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit())
        || normalized == zero
    {
        return Err(invalid_context(format!(
            "{label} must be {length} non-zero hex characters"
        )));
    }
    Ok(normalized)
}

fn optional_hex_id(
    value: Option<&str>,
    length: usize,
    zero: &str,
    label: &str,
) -> Result<Option<String>, SdkError> {
    value
        .map(|text| hex_id(text, length, zero, label))
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
        (Some(older), Some(newer)) => {
            let mut tags = older.tags;
            tags.extend(newer.tags);
            TelemetryContext {
                schema_version: TELEMETRY_CONTEXT_SCHEMA_VERSION,
                resource: merge_resources(older.resource, newer.resource),
                trace: newer.trace.or(older.trace),
                session: newer.session.or(older.session),
                subject: newer.subject.or(older.subject),
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
        (Some(older), Some(newer)) => Some(TelemetryResource {
            service: merge_named_version(older.service, newer.service),
            deployment: merge_deployment(older.deployment, newer.deployment),
            runtime: merge_named_version(older.runtime, newer.runtime),
            framework: merge_named_version(older.framework, newer.framework),
            operating_system: merge_operating_system(
                older.operating_system,
                newer.operating_system,
            ),
            device: merge_device(older.device, newer.device),
            application: merge_application(older.application, newer.application),
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
        (Some(older), Some(newer)) => Some(TelemetryNamedVersion {
            name: newer.name,
            version: newer.version.or(older.version),
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
        (Some(older), Some(newer)) => Some(TelemetryDeployment {
            environment: newer.environment.or(older.environment),
            release: newer.release.or(older.release),
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
        (Some(older), Some(newer)) => Some(TelemetryOperatingSystem {
            name: newer.name,
            version: newer.version.or(older.version),
            build: newer.build.or(older.build),
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
        (Some(older), Some(newer)) => Some(TelemetryDevice {
            family: newer.family.or(older.family),
            model: newer.model.or(older.model),
            architecture: newer.architecture.or(older.architecture),
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
        (Some(older), Some(newer)) => Some(TelemetryApplication {
            name: newer.name.or(older.name),
            version: newer.version.or(older.version),
            build: newer.build.or(older.build),
        }),
    }
}

fn normalized_target_os() -> &'static str {
    match consts::OS {
        "macos" => "darwin",
        value => value,
    }
}

/// Return a detached snapshot of the current thread/poll-scoped telemetry context.
#[must_use]
#[inline]
pub fn current_telemetry_context() -> Option<TelemetryContext> {
    ACTIVE_CONTEXTS.with(|contexts| {
        contexts
            .borrow()
            .iter()
            .try_fold(None, |merged, active| {
                merge_normalized_contexts(merged, Some(active.context.clone()))
            })
            .ok()
            .flatten()
    })
}

/// Activate context for the current synchronous thread until the guard closes or drops.
///
/// # Errors
///
/// Returns an [`SdkError`] when the context fails validation.
#[inline]
pub fn activate_telemetry_context(
    context: TelemetryContext,
) -> Result<TelemetryContextGuard, SdkError> {
    let validated = context.into_validated("active telemetry context")?;
    drop(merge_normalized_contexts(
        current_telemetry_context(),
        Some(validated.clone()),
    )?);
    let token = NEXT_CONTEXT_TOKEN.fetch_add(1, Ordering::Relaxed);
    ACTIVE_CONTEXTS.with(|contexts| {
        contexts.borrow_mut().push(ActiveContext {
            token,
            context: validated,
        });
    });
    Ok(TelemetryContextGuard {
        token: Some(token),
        not_send: PhantomData,
    })
}

/// Run one synchronous closure with context and restore the exact previous scope on unwind.
///
/// # Errors
///
/// Returns an [`SdkError`] when the context fails validation; the closure does not run.
#[inline]
pub fn with_telemetry_context<F, R>(context: TelemetryContext, operation: F) -> Result<R, SdkError>
where
    F: FnOnce() -> R,
{
    let _guard = activate_telemetry_context(context)?;
    Ok(operation())
}

/// Wrap a future so context is installed only while each poll runs.
///
/// # Errors
///
/// Returns an [`SdkError`] when the context fails validation.
#[inline]
pub fn with_telemetry_context_async<F>(
    context: TelemetryContext,
    future: F,
) -> Result<TelemetryContextFuture<F>, SdkError>
where
    F: Future,
{
    Ok(TelemetryContextFuture {
        context: context.into_validated("async telemetry context")?,
        future: Box::pin(future),
        completed: false,
    })
}

pub(crate) fn context_to_value(context: &TelemetryContext) -> Result<serde_json::Value, SdkError> {
    let validated = validate_context(context, "event telemetry context")?;
    serde_json::to_value(validated).map_err(|_error| {
        SdkError::new(
            "serialization_error",
            "telemetry context could not be serialized",
        )
    })
}

pub(crate) fn context_from_value(value: serde_json::Value) -> Result<TelemetryContext, SdkError> {
    let context: TelemetryContext = serde_json::from_value(value)
        .map_err(|_error| invalid_context("event context must be a TelemetryContext"))?;
    validate_context(&context, "event telemetry context")
}

pub(crate) fn merge_captured_contexts(
    contexts: impl IntoIterator<Item = Option<TelemetryContext>>,
) -> Result<Option<TelemetryContext>, SdkError> {
    contexts.into_iter().try_fold(None, |merged, context| {
        merge_normalized_contexts(merged, context)
    })
}
