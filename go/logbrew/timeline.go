package logbrew

import (
	"fmt"
	"math"
	"net/url"
	"strings"
)

// ProductActionInput describes an app-owned product step that should be
// captured as an agent-readable action event.
type ProductActionInput struct {
	Name          string
	Status        string
	RouteTemplate string
	SessionID     string
	TraceID       string
	Screen        string
	Funnel        string
	Step          string
	Metadata      map[string]any
}

// NetworkMilestoneInput describes an app-owned API milestone that should be
// captured as an agent-readable action event.
type NetworkMilestoneInput struct {
	Name          string
	RouteTemplate string
	Method        string
	Status        string
	StatusCode    *int
	DurationMs    *float64
	SessionID     string
	TraceID       string
	Metadata      map[string]any
}

// CreateProductActionAttributes builds privacy-safe action attributes for a
// product milestone without automatic click capture or global app mutation.
func CreateProductActionAttributes(input ProductActionInput) (ActionAttributes, error) {
	if err := requireNonEmpty("product action name", input.Name); err != nil {
		return ActionAttributes{}, err
	}
	status := input.Status
	if status == "" {
		status = "success"
	}
	if err := requireAllowedValue("product action status", status, actionStatus); err != nil {
		return ActionAttributes{}, err
	}
	resultMetadata := timelineMetadata("product.action", input.Metadata, map[string]any{
		"routeTemplate": sanitizeRouteTemplate(input.RouteTemplate),
		"sessionId":     stringOrNil(input.SessionID),
		"traceId":       stringOrNil(input.TraceID),
		"screen":        stringOrNil(input.Screen),
		"funnel":        stringOrNil(input.Funnel),
		"step":          stringOrNil(input.Step),
	})
	return ActionAttributes{Name: input.Name, Status: status, Metadata: resultMetadata}, nil
}

// CreateNetworkMilestoneAttributes builds privacy-safe action attributes for
// an API milestone without patching HTTP clients or capturing payloads/headers.
func CreateNetworkMilestoneAttributes(input NetworkMilestoneInput) (ActionAttributes, error) {
	routeTemplate, err := requireRouteTemplate(input.RouteTemplate)
	if err != nil {
		return ActionAttributes{}, err
	}
	method, err := normalizeHTTPMethod(input.Method)
	if err != nil {
		return ActionAttributes{}, err
	}
	statusCode, hasStatusCode, err := statusCodeValue(input.StatusCode)
	if err != nil {
		return ActionAttributes{}, err
	}
	status := input.Status
	if status == "" {
		status = statusFromStatusCode(statusCode, hasStatusCode)
	}
	if err := requireAllowedValue("network milestone status", status, actionStatus); err != nil {
		return ActionAttributes{}, err
	}
	durationMs, hasDurationMs, err := nonNegativeNumberValue("network milestone durationMs", input.DurationMs)
	if err != nil {
		return ActionAttributes{}, err
	}
	name := strings.TrimSpace(input.Name)
	if name == "" {
		name = fmt.Sprintf("network.%s %s", strings.ToLower(method), routeTemplate)
	}
	timeline := map[string]any{
		"routeTemplate": routeTemplate,
		"method":        method,
		"sessionId":     stringOrNil(input.SessionID),
		"traceId":       stringOrNil(input.TraceID),
	}
	if hasStatusCode {
		timeline["statusCode"] = statusCode
	}
	if hasDurationMs {
		timeline["durationMs"] = durationMs
	}
	resultMetadata := timelineMetadata("network.milestone", input.Metadata, timeline)
	return ActionAttributes{Name: name, Status: status, Metadata: resultMetadata}, nil
}

func timelineMetadata(source string, local map[string]any, timeline map[string]any) map[string]any {
	result := map[string]any{"source": source}
	for key, value := range compactMetadata(local) {
		result[key] = value
	}
	for key, value := range timeline {
		if value != nil {
			result[key] = value
		}
	}
	return compactMetadata(result)
}

func requireRouteTemplate(routeTemplate string) (string, error) {
	sanitized := sanitizeRouteTemplate(routeTemplate)
	if err := requireNonEmpty("network milestone routeTemplate", sanitized); err != nil {
		return "", err
	}
	return sanitized, nil
}

func sanitizeRouteTemplate(routeTemplate string) string {
	trimmed := strings.TrimSpace(routeTemplate)
	if trimmed == "" {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err == nil && (parsed.IsAbs() || parsed.Host != "") {
		if parsed.Path == "" {
			return "/"
		}
		return parsed.Path
	}
	if index := strings.IndexAny(trimmed, "?#"); index >= 0 {
		trimmed = trimmed[:index]
	}
	if trimmed == "" {
		return "/"
	}
	return trimmed
}

func normalizeHTTPMethod(method string) (string, error) {
	value := strings.TrimSpace(method)
	if value == "" {
		value = "GET"
	}
	normalized := strings.ToUpper(value)
	if !isValidHTTPMethod(normalized) {
		return "", &SdkError{Code: "validation_error", Message: "network milestone method must be a valid HTTP method"}
	}
	return normalized, nil
}

func isValidHTTPMethod(method string) bool {
	if method == "" {
		return false
	}
	for index, char := range method {
		if index == 0 && (char < 'A' || char > 'Z') {
			return false
		}
		if !((char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '_' || char == '-') {
			return false
		}
	}
	return true
}

func statusCodeValue(statusCode *int) (int, bool, error) {
	if statusCode == nil {
		return 0, false, nil
	}
	if *statusCode < 100 || *statusCode > 599 {
		return 0, false, &SdkError{Code: "validation_error", Message: "network milestone statusCode must be an integer from 100 to 599"}
	}
	return *statusCode, true, nil
}

func statusFromStatusCode(statusCode int, present bool) string {
	if present && statusCode >= 400 {
		return "failure"
	}
	return "success"
}

func nonNegativeNumberValue(label string, value *float64) (float64, bool, error) {
	if value == nil {
		return 0, false, nil
	}
	if math.IsNaN(*value) || math.IsInf(*value, 0) || *value < 0 {
		return 0, false, &SdkError{Code: "validation_error", Message: fmt.Sprintf("%s must be a non-negative number", label)}
	}
	return *value, true, nil
}

func stringOrNil(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}
