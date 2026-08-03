package logbrew

const (
	telemetryContextSchemaVersion = 1
	maxContextIDLength            = 200
	maxContextStringLength        = 256
	maxContextTags                = 32
	maxContextTagKeyLength        = 64
)

// TelemetryNamedVersion is a bounded service, runtime, or framework identity.
type TelemetryNamedVersion struct {
	Name    string `json:"name"`
	Version string `json:"version,omitempty"`
}

// TelemetryDeployment identifies an application deployment without host data.
type TelemetryDeployment struct {
	Environment string `json:"environment,omitempty"`
	Release     string `json:"release,omitempty"`
}

// TelemetryOperatingSystem identifies an OS family and optional safe version.
type TelemetryOperatingSystem struct {
	Name    string `json:"name"`
	Version string `json:"version,omitempty"`
	Build   string `json:"build,omitempty"`
}

// TelemetryDevice describes a broad device or runtime host class. Do not put
// unique device identifiers, hostnames, IP addresses, or user names here.
type TelemetryDevice struct {
	Family       string `json:"family,omitempty"`
	Model        string `json:"model,omitempty"`
	Architecture string `json:"architecture,omitempty"`
}

// TelemetryApplication identifies the instrumented application and build.
type TelemetryApplication struct {
	Name    string `json:"name,omitempty"`
	Version string `json:"version,omitempty"`
	Build   string `json:"build,omitempty"`
}

// TelemetryResource is the shared service, deployment, runtime, framework,
// OS, device, and application identity attached to telemetry signals.
type TelemetryResource struct {
	Service         *TelemetryNamedVersion    `json:"service,omitempty"`
	Deployment      *TelemetryDeployment      `json:"deployment,omitempty"`
	Runtime         *TelemetryNamedVersion    `json:"runtime,omitempty"`
	Framework       *TelemetryNamedVersion    `json:"framework,omitempty"`
	OperatingSystem *TelemetryOperatingSystem `json:"operatingSystem,omitempty"`
	Device          *TelemetryDevice          `json:"device,omitempty"`
	Application     *TelemetryApplication     `json:"application,omitempty"`
}

// TelemetryTraceContext is exact W3C-compatible trace and span correlation for
// any telemetry signal.
type TelemetryTraceContext struct {
	TraceID      string `json:"traceId"`
	SpanID       string `json:"spanId,omitempty"`
	ParentSpanID string `json:"parentSpanId,omitempty"`
	Sampled      *bool  `json:"sampled,omitempty"`
}

// TelemetrySessionContext is an opaque application-owned session identity.
// It must not contain an email address, access token, or other direct PII.
type TelemetrySessionContext struct {
	ID         string `json:"id"`
	PreviousID string `json:"previousId,omitempty"`
}

// TelemetrySubjectContext is an explicit opaque user or anonymous identity.
// Applications should use their own irreversible or otherwise non-PII ID.
type TelemetrySubjectContext struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
}

// TelemetryContext is the versioned privacy-bounded context available on every
// LogBrew event type. Tags are limited to low-cardinality string dimensions.
type TelemetryContext struct {
	SchemaVersion int                      `json:"schemaVersion"`
	Resource      *TelemetryResource       `json:"resource,omitempty"`
	Trace         *TelemetryTraceContext   `json:"trace,omitempty"`
	Session       *TelemetrySessionContext `json:"session,omitempty"`
	Subject       *TelemetrySubjectContext `json:"subject,omitempty"`
	Tags          map[string]string        `json:"tags,omitempty"`
}

// ValidateTelemetryContext validates, normalizes, and detaches one shared
// context without queueing an event.
func ValidateTelemetryContext(context *TelemetryContext) (*TelemetryContext, error) {
	return validateTelemetryContext(context, "telemetry context")
}

// MergeTelemetryContexts applies the same client-base and event-override rules
// used by Client event capture and returns a detached result.
func MergeTelemetryContexts(base, override *TelemetryContext) (*TelemetryContext, error) {
	return mergeTelemetryContexts(base, override)
}
