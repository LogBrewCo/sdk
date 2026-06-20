package logbrew

import (
	"math"
	"net/url"
	"reflect"
	"regexp"
	"strings"
)

// SupportTicketDraftInput describes an explicit local-only draft for planned
// backend support-ticket routes. It does not open a ticket or send telemetry.
type SupportTicketDraftInput struct {
	ProjectID   string
	Source      string
	Category    string
	Title       string
	Description string
	Environment string
	Runtime     string
	Framework   string
	SDKPackage  string
	SDKVersion  string
	Release     string
	TraceID     string
	EventID     string
	Diagnostics map[string]any
}

// SupportTicketDraft is the planned support-ticket create payload after local
// validation and diagnostics redaction.
type SupportTicketDraft struct {
	ProjectID   string         `json:"project_id,omitempty"`
	Source      string         `json:"source"`
	Category    string         `json:"category"`
	Title       string         `json:"title"`
	Description string         `json:"description"`
	Environment string         `json:"environment,omitempty"`
	Runtime     string         `json:"runtime,omitempty"`
	Framework   string         `json:"framework,omitempty"`
	SDKPackage  string         `json:"sdk_package,omitempty"`
	SDKVersion  string         `json:"sdk_version,omitempty"`
	Release     string         `json:"release,omitempty"`
	TraceID     string         `json:"trace_id,omitempty"`
	EventID     string         `json:"event_id,omitempty"`
	Diagnostics map[string]any `json:"diagnostics,omitempty"`
}

var (
	supportTicketSources    = []string{"cli", "sdk", "website", "docs", "mobile"}
	supportTicketCategories = []string{
		"sdk_install_failure",
		"ingest_failure",
		"auth_failure",
		"project_setup",
		"dashboard_issue",
		"docs_confusion",
		"cli_issue",
		"mobile_issue",
		"billing_question",
		"other",
	}
	supportSensitiveKeys = map[string]struct{}{
		"apikey":           {},
		"auth":             {},
		"authorization":    {},
		"authtoken":        {},
		"bearer":           {},
		"clientsecret":     {},
		"connectionstring": {},
		"cookie":           {},
		"credential":       {},
		"credentials":      {},
		"dsn":              {},
		"password":         {},
		"passwd":           {},
		"privatekey":       {},
		"refreshtoken":     {},
		"secret":           {},
		"session":          {},
		"setcookie":        {},
		"token":            {},
	}
	supportSensitiveKeyMarkers = []string{
		"auth",
		"connectionstring",
		"cookie",
		"credential",
		"dsn",
		"password",
		"passwd",
		"privatekey",
		"secret",
		"session",
		"token",
	}
	supportSensitiveAssignmentPattern = regexp.MustCompile(`(?i)(?:authorization|api[_-]?key|token|secret|password|passwd|cookie)\s*[:=]`)
	supportTokenPattern               = regexp.MustCompile(`(?i)(?:\bBearer\s+[A-Za-z0-9._~+/=-]+|\blbw_ingest_[A-Za-z0-9._-]+|\b(?:sk|pk|xox[abprs]?)-[A-Za-z0-9_-]{10,}|\bAKIA[0-9A-Z]{16}\b)`)
	supportURLPattern                 = regexp.MustCompile(`(?i)https?://[^\s"'<>]+`)
	supportPOSIXPathPattern           = regexp.MustCompile(`(?:^|[^\w.-])(?:/Users|/home|/var/folders|/private/var|/tmp)/[^\s"'<>]+`)
	supportWindowsPathPattern         = regexp.MustCompile(`\b[A-Za-z]:\\[^\s"'<>]+`)
)

const (
	supportDiagnosticsMaxDepth       = 5
	supportDiagnosticsMaxStringBytes = 500
	supportDiagnosticsMaxItems       = 20
	supportRedacted                  = "[redacted]"
)

// CreateSupportTicketDraft builds a local-only, token-free support-ticket
// create payload draft without calling backend support routes.
func CreateSupportTicketDraft(input SupportTicketDraftInput) (SupportTicketDraft, error) {
	if err := requireAllowedValue("support ticket source", input.Source, supportTicketSources); err != nil {
		return SupportTicketDraft{}, err
	}
	if err := requireAllowedValue("support ticket category", input.Category, supportTicketCategories); err != nil {
		return SupportTicketDraft{}, err
	}
	if err := requireNonEmpty("support ticket title", input.Title); err != nil {
		return SupportTicketDraft{}, err
	}
	if err := requireNonEmpty("support ticket description", input.Description); err != nil {
		return SupportTicketDraft{}, err
	}
	draft := SupportTicketDraft{
		Source:      input.Source,
		Category:    input.Category,
		Title:       strings.TrimSpace(input.Title),
		Description: strings.TrimSpace(input.Description),
	}
	if value, err := cleanSupportOptionalString("support ticket project_id", input.ProjectID); err != nil {
		return SupportTicketDraft{}, err
	} else {
		draft.ProjectID = value
	}
	if value, err := cleanSupportOptionalString("support ticket environment", input.Environment); err != nil {
		return SupportTicketDraft{}, err
	} else {
		draft.Environment = value
	}
	if value, err := cleanSupportOptionalString("support ticket runtime", input.Runtime); err != nil {
		return SupportTicketDraft{}, err
	} else {
		draft.Runtime = value
	}
	if value, err := cleanSupportOptionalString("support ticket framework", input.Framework); err != nil {
		return SupportTicketDraft{}, err
	} else {
		draft.Framework = value
	}
	if value, err := cleanSupportOptionalString("support ticket sdk_package", input.SDKPackage); err != nil {
		return SupportTicketDraft{}, err
	} else {
		draft.SDKPackage = value
	}
	if value, err := cleanSupportOptionalString("support ticket sdk_version", input.SDKVersion); err != nil {
		return SupportTicketDraft{}, err
	} else {
		draft.SDKVersion = value
	}
	if value, err := cleanSupportOptionalString("support ticket release", input.Release); err != nil {
		return SupportTicketDraft{}, err
	} else {
		draft.Release = value
	}
	if input.TraceID != "" {
		traceID := strings.ToLower(strings.TrimSpace(input.TraceID))
		if err := requireTraceID(traceID); err != nil {
			return SupportTicketDraft{}, err
		}
		draft.TraceID = traceID
	}
	if value, err := cleanSupportOptionalString("support ticket event_id", input.EventID); err != nil {
		return SupportTicketDraft{}, err
	} else {
		draft.EventID = value
	}
	if input.Diagnostics != nil {
		draft.Diagnostics = sanitizeSupportDiagnostics(input.Diagnostics)
	}
	return draft, nil
}

func cleanSupportOptionalString(label, value string) (string, error) {
	if value == "" {
		return "", nil
	}
	if err := requireNonEmpty(label, value); err != nil {
		return "", err
	}
	return strings.TrimSpace(value), nil
}

func sanitizeSupportDiagnostics(diagnostics map[string]any) map[string]any {
	safe := map[string]any{}
	for key, value := range diagnostics {
		if key == "" {
			continue
		}
		if isSensitiveSupportKey(key) {
			safe[key] = supportRedacted
			continue
		}
		if sanitized, ok := sanitizeSupportDiagnosticValue(value, 0); ok {
			safe[key] = sanitized
		}
	}
	if len(safe) == 0 {
		return nil
	}
	return safe
}

func sanitizeSupportDiagnosticValue(value any, depth int) (any, bool) {
	if depth > supportDiagnosticsMaxDepth {
		return nil, false
	}
	if err, ok := value.(error); ok {
		return map[string]any{"type": supportErrorType(err)}, true
	}
	switch typed := value.(type) {
	case nil, bool, string, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		return sanitizeSupportPrimitive(typed)
	case float32:
		if math.IsInf(float64(typed), 0) || math.IsNaN(float64(typed)) {
			return nil, false
		}
		return typed, true
	case float64:
		if math.IsInf(typed, 0) || math.IsNaN(typed) {
			return nil, false
		}
		return typed, true
	case map[string]any:
		return sanitizeSupportDiagnosticMap(typed, depth)
	case []any:
		return sanitizeSupportDiagnosticSlice(reflect.ValueOf(typed), depth), true
	default:
		reflected := reflect.ValueOf(value)
		if !reflected.IsValid() {
			return nil, true
		}
		switch reflected.Kind() {
		case reflect.Map:
			if reflected.Type().Key().Kind() == reflect.String {
				return sanitizeSupportDiagnosticReflectMap(reflected, depth), true
			}
		case reflect.Slice, reflect.Array:
			return sanitizeSupportDiagnosticSlice(reflected, depth), true
		}
	}
	return nil, false
}

func sanitizeSupportPrimitive(value any) (any, bool) {
	switch typed := value.(type) {
	case string:
		return sanitizeSupportString(typed), true
	default:
		return value, true
	}
}

func sanitizeSupportDiagnosticMap(value map[string]any, depth int) (map[string]any, bool) {
	safe := map[string]any{}
	for key, nested := range value {
		if key == "" {
			continue
		}
		if isSensitiveSupportKey(key) {
			safe[key] = supportRedacted
			continue
		}
		if sanitized, ok := sanitizeSupportDiagnosticValue(nested, depth+1); ok {
			safe[key] = sanitized
		}
	}
	return safe, true
}

func sanitizeSupportDiagnosticReflectMap(value reflect.Value, depth int) map[string]any {
	safe := map[string]any{}
	iter := value.MapRange()
	for iter.Next() {
		key := iter.Key().String()
		if key == "" {
			continue
		}
		if isSensitiveSupportKey(key) {
			safe[key] = supportRedacted
			continue
		}
		if sanitized, ok := sanitizeSupportDiagnosticValue(iter.Value().Interface(), depth+1); ok {
			safe[key] = sanitized
		}
	}
	return safe
}

func sanitizeSupportDiagnosticSlice(value reflect.Value, depth int) []any {
	limit := value.Len()
	if limit > supportDiagnosticsMaxItems {
		limit = supportDiagnosticsMaxItems
	}
	safe := make([]any, 0, limit)
	for index := 0; index < limit; index++ {
		if sanitized, ok := sanitizeSupportDiagnosticValue(value.Index(index).Interface(), depth+1); ok {
			safe = append(safe, sanitized)
		}
	}
	return safe
}

func supportErrorType(err error) string {
	if err == nil {
		return "<nil>"
	}
	errType := reflect.TypeOf(err)
	if errType.Kind() == reflect.Pointer {
		errType = errType.Elem()
	}
	if errType.PkgPath() != "" {
		return errType.PkgPath() + "." + errType.Name()
	}
	return errType.Name()
}

func isSensitiveSupportKey(key string) bool {
	normalized := normalizeSupportKey(key)
	if _, ok := supportSensitiveKeys[normalized]; ok {
		return true
	}
	for _, marker := range supportSensitiveKeyMarkers {
		if strings.Contains(normalized, marker) {
			return true
		}
	}
	return false
}

func normalizeSupportKey(key string) string {
	var normalized strings.Builder
	for _, char := range strings.ToLower(key) {
		if char >= 'a' && char <= 'z' || char >= '0' && char <= '9' {
			normalized.WriteRune(char)
		}
	}
	return normalized.String()
}

func sanitizeSupportString(value string) string {
	if supportSensitiveAssignmentPattern.MatchString(value) || supportTokenPattern.MatchString(value) {
		return supportRedacted
	}
	sanitized := supportURLPattern.ReplaceAllStringFunc(value, redactSupportURL)
	sanitized = supportPOSIXPathPattern.ReplaceAllStringFunc(sanitized, redactSupportPathMatch)
	sanitized = supportWindowsPathPattern.ReplaceAllString(sanitized, "[redacted-path]")
	if len(sanitized) > supportDiagnosticsMaxStringBytes {
		return sanitized[:supportDiagnosticsMaxStringBytes-3] + "..."
	}
	return sanitized
}

func redactSupportURL(value string) string {
	parsed, err := url.Parse(value)
	if err != nil {
		return "[redacted-url]"
	}
	return "[redacted-url]" + parsed.Path
}

func redactSupportPathMatch(value string) string {
	if strings.HasPrefix(value, "/") {
		return "[redacted-path]"
	}
	return value[:1] + "[redacted-path]"
}
