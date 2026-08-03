package logbrew

import (
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"
)

func validateTelemetryContext(context *TelemetryContext, label string) (*TelemetryContext, error) {
	if context == nil {
		return nil, nil
	}
	if context.SchemaVersion != telemetryContextSchemaVersion {
		return nil, invalidTelemetryContext(fmt.Sprintf("%s schemaVersion must be %d", label, telemetryContextSchemaVersion))
	}
	normalized := &TelemetryContext{SchemaVersion: telemetryContextSchemaVersion}
	var err error
	if context.Resource != nil {
		normalized.Resource, err = normalizeTelemetryResource(context.Resource, label+" resource")
		if err != nil {
			return nil, err
		}
	}
	if context.Trace != nil {
		normalized.Trace, err = normalizeTelemetryTrace(context.Trace, label+" trace")
		if err != nil {
			return nil, err
		}
	}
	if context.Session != nil {
		normalized.Session, err = normalizeTelemetrySession(context.Session, label+" session")
		if err != nil {
			return nil, err
		}
	}
	if context.Subject != nil {
		normalized.Subject, err = normalizeTelemetrySubject(context.Subject, label+" subject")
		if err != nil {
			return nil, err
		}
	}
	if context.Tags != nil {
		normalized.Tags, err = normalizeTelemetryTags(context.Tags, label+" tags")
		if err != nil {
			return nil, err
		}
	}
	if normalized.Resource == nil && normalized.Trace == nil && normalized.Session == nil && normalized.Subject == nil && normalized.Tags == nil {
		return nil, invalidTelemetryContext(label + " must include resource, trace, session, subject, or tags")
	}
	return normalized, nil
}

func normalizeTelemetryResource(resource *TelemetryResource, label string) (*TelemetryResource, error) {
	normalized := &TelemetryResource{}
	var err error
	if resource.Service != nil {
		normalized.Service, err = normalizeTelemetryNamedVersion(resource.Service, label+" service")
		if err != nil {
			return nil, err
		}
	}
	if resource.Deployment != nil {
		normalized.Deployment, err = normalizeTelemetryDeployment(resource.Deployment, label+" deployment")
		if err != nil {
			return nil, err
		}
	}
	if resource.Runtime != nil {
		normalized.Runtime, err = normalizeTelemetryNamedVersion(resource.Runtime, label+" runtime")
		if err != nil {
			return nil, err
		}
	}
	if resource.Framework != nil {
		normalized.Framework, err = normalizeTelemetryNamedVersion(resource.Framework, label+" framework")
		if err != nil {
			return nil, err
		}
	}
	if resource.OperatingSystem != nil {
		normalized.OperatingSystem, err = normalizeTelemetryOperatingSystem(resource.OperatingSystem, label+" operatingSystem")
		if err != nil {
			return nil, err
		}
	}
	if resource.Device != nil {
		normalized.Device, err = normalizeTelemetryDevice(resource.Device, label+" device")
		if err != nil {
			return nil, err
		}
	}
	if resource.Application != nil {
		normalized.Application, err = normalizeTelemetryApplication(resource.Application, label+" application")
		if err != nil {
			return nil, err
		}
	}
	if telemetryResourceEmpty(normalized) {
		return nil, invalidTelemetryContext(label + " must not be empty")
	}
	return normalized, nil
}

func normalizeTelemetryNamedVersion(value *TelemetryNamedVersion, label string) (*TelemetryNamedVersion, error) {
	if value.Name == "" {
		return nil, invalidTelemetryContext(label + " name is required")
	}
	name, err := requiredTelemetryString(value.Name, label+" name")
	if err != nil {
		return nil, err
	}
	version, err := optionalTelemetryString(value.Version, label+" version")
	if err != nil {
		return nil, err
	}
	return &TelemetryNamedVersion{Name: name, Version: version}, nil
}

func normalizeTelemetryDeployment(value *TelemetryDeployment, label string) (*TelemetryDeployment, error) {
	environment, err := optionalTelemetryString(value.Environment, label+" environment")
	if err != nil {
		return nil, err
	}
	release, err := optionalTelemetryString(value.Release, label+" release")
	if err != nil {
		return nil, err
	}
	if environment == "" && release == "" {
		return nil, invalidTelemetryContext(label + " must not be empty")
	}
	return &TelemetryDeployment{Environment: environment, Release: release}, nil
}

func normalizeTelemetryOperatingSystem(value *TelemetryOperatingSystem, label string) (*TelemetryOperatingSystem, error) {
	if value.Name == "" {
		return nil, invalidTelemetryContext(label + " name is required")
	}
	name, err := requiredTelemetryString(value.Name, label+" name")
	if err != nil {
		return nil, err
	}
	version, err := optionalTelemetryString(value.Version, label+" version")
	if err != nil {
		return nil, err
	}
	build, err := optionalTelemetryString(value.Build, label+" build")
	if err != nil {
		return nil, err
	}
	return &TelemetryOperatingSystem{Name: name, Version: version, Build: build}, nil
}

func normalizeTelemetryDevice(value *TelemetryDevice, label string) (*TelemetryDevice, error) {
	family, err := optionalTelemetryString(value.Family, label+" family")
	if err != nil {
		return nil, err
	}
	model, err := optionalTelemetryString(value.Model, label+" model")
	if err != nil {
		return nil, err
	}
	architecture, err := optionalTelemetryString(value.Architecture, label+" architecture")
	if err != nil {
		return nil, err
	}
	if family == "" && model == "" && architecture == "" {
		return nil, invalidTelemetryContext(label + " must not be empty")
	}
	return &TelemetryDevice{Family: family, Model: model, Architecture: architecture}, nil
}

func normalizeTelemetryApplication(value *TelemetryApplication, label string) (*TelemetryApplication, error) {
	name, err := optionalTelemetryString(value.Name, label+" name")
	if err != nil {
		return nil, err
	}
	version, err := optionalTelemetryString(value.Version, label+" version")
	if err != nil {
		return nil, err
	}
	build, err := optionalTelemetryString(value.Build, label+" build")
	if err != nil {
		return nil, err
	}
	if name == "" && version == "" && build == "" {
		return nil, invalidTelemetryContext(label + " must not be empty")
	}
	return &TelemetryApplication{Name: name, Version: version, Build: build}, nil
}

func normalizeTelemetryTrace(value *TelemetryTraceContext, label string) (*TelemetryTraceContext, error) {
	traceID, err := normalizedTelemetryHexID(value.TraceID, 32, zeroTraceID, label+" traceId")
	if err != nil {
		return nil, err
	}
	spanID, err := optionalTelemetryHexID(value.SpanID, 16, zeroSpanID, label+" spanId")
	if err != nil {
		return nil, err
	}
	parentSpanID, err := optionalTelemetryHexID(value.ParentSpanID, 16, zeroSpanID, label+" parentSpanId")
	if err != nil {
		return nil, err
	}
	var sampled *bool
	if value.Sampled != nil {
		copy := *value.Sampled
		sampled = &copy
	}
	return &TelemetryTraceContext{TraceID: traceID, SpanID: spanID, ParentSpanID: parentSpanID, Sampled: sampled}, nil
}

func normalizeTelemetrySession(value *TelemetrySessionContext, label string) (*TelemetrySessionContext, error) {
	id, err := requiredTelemetryID(value.ID, label+" id")
	if err != nil {
		return nil, err
	}
	previousID, err := optionalTelemetryID(value.PreviousID, label+" previousId")
	if err != nil {
		return nil, err
	}
	if previousID != "" && previousID == id {
		return nil, invalidTelemetryContext(label + " previousId must differ from id")
	}
	return &TelemetrySessionContext{ID: id, PreviousID: previousID}, nil
}

func normalizeTelemetrySubject(value *TelemetrySubjectContext, label string) (*TelemetrySubjectContext, error) {
	id, err := requiredTelemetryID(value.ID, label+" id")
	if err != nil {
		return nil, err
	}
	if value.Kind != "anonymous" && value.Kind != "user" {
		return nil, invalidTelemetryContext(label + " kind must be anonymous or user")
	}
	return &TelemetrySubjectContext{ID: id, Kind: value.Kind}, nil
}

func normalizeTelemetryTags(tags map[string]string, label string) (map[string]string, error) {
	if len(tags) < 1 || len(tags) > maxContextTags {
		return nil, invalidTelemetryContext(fmt.Sprintf("%s must contain 1-%d entries", label, maxContextTags))
	}
	keys := make([]string, 0, len(tags))
	for key := range tags {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	normalized := make(map[string]string, len(tags))
	for _, key := range keys {
		if !validTelemetryTagKey(key) {
			return nil, invalidTelemetryContext(label + " key is invalid")
		}
		value, err := requiredTelemetryString(tags[key], label+" value for "+key)
		if err != nil {
			return nil, err
		}
		normalized[key] = value
	}
	return normalized, nil
}

func telemetryResourceEmpty(value *TelemetryResource) bool {
	return value.Service == nil && value.Deployment == nil && value.Runtime == nil && value.Framework == nil &&
		value.OperatingSystem == nil && value.Device == nil && value.Application == nil
}

func requiredTelemetryString(value, label string) (string, error) {
	normalized := strings.TrimSpace(value)
	if !validTelemetryString(normalized, maxContextStringLength) {
		return "", invalidTelemetryContext(label + " is invalid")
	}
	return normalized, nil
}

func optionalTelemetryString(value, label string) (string, error) {
	if value == "" {
		return "", nil
	}
	return requiredTelemetryString(value, label)
}

func requiredTelemetryID(value, label string) (string, error) {
	normalized := strings.TrimSpace(value)
	if !validTelemetryString(normalized, maxContextIDLength) {
		return "", invalidTelemetryContext(label + " is invalid")
	}
	return normalized, nil
}

func optionalTelemetryID(value, label string) (string, error) {
	if value == "" {
		return "", nil
	}
	return requiredTelemetryID(value, label)
}

func validTelemetryString(value string, maximum int) bool {
	if value == "" || !utf8.ValidString(value) || utf8.RuneCountInString(value) > maximum {
		return false
	}
	for _, character := range value {
		if character <= 31 || (character >= 127 && character <= 159) {
			return false
		}
	}
	return true
}

func normalizedTelemetryHexID(value string, width int, zero, label string) (string, error) {
	if len(value) != width || !isHex(value) || strings.EqualFold(value, zero) {
		return "", invalidTelemetryContext(fmt.Sprintf("%s must be %d non-zero hex characters", label, width))
	}
	return strings.ToLower(value), nil
}

func optionalTelemetryHexID(value string, width int, zero, label string) (string, error) {
	if value == "" {
		return "", nil
	}
	return normalizedTelemetryHexID(value, width, zero, label)
}

func validTelemetryTagKey(value string) bool {
	if len(value) < 1 || len(value) > maxContextTagKeyLength || !isASCIIAlpha(value[0]) {
		return false
	}
	for index := 1; index < len(value); index++ {
		character := value[index]
		if isASCIIAlpha(character) || (character >= '0' && character <= '9') || character == '_' || character == '.' || character == '-' {
			continue
		}
		return false
	}
	return true
}

func invalidTelemetryContext(message string) error {
	return &SdkError{Code: "validation_error", Message: message}
}
