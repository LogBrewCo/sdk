package logbrew

import "runtime"

func createGoRuntimeContext() *TelemetryContext {
	runtimeIdentity := &TelemetryNamedVersion{Name: "go"}
	if value, ok := boundedRuntimeContextValue(runtime.Version()); ok {
		runtimeIdentity.Version = value
	}
	resource := &TelemetryResource{Runtime: runtimeIdentity}
	if value, ok := boundedRuntimeContextValue(runtime.GOOS); ok {
		resource.OperatingSystem = &TelemetryOperatingSystem{Name: value}
	}
	if value, ok := boundedRuntimeContextValue(runtime.GOARCH); ok {
		resource.Device = &TelemetryDevice{Architecture: value}
	}
	return &TelemetryContext{SchemaVersion: telemetryContextSchemaVersion, Resource: resource}
}

func boundedRuntimeContextValue(value string) (string, bool) {
	normalized, err := requiredTelemetryString(value, "runtime context value")
	return normalized, err == nil
}

func telemetryContextWithTrace(context *TelemetryContext, trace TraceContext) *TelemetryContext {
	cloned := cloneTelemetryContextUnchecked(context)
	if cloned == nil {
		cloned = &TelemetryContext{SchemaVersion: telemetryContextSchemaVersion}
	}
	cloned.Trace = &TelemetryTraceContext{
		TraceID:      trace.TraceID,
		SpanID:       trace.SpanID,
		ParentSpanID: trace.ParentSpanID,
		Sampled:      boolPointer(trace.Sampled),
	}
	return cloned
}
