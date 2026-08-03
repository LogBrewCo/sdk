package logbrew

func telemetryContextMap(context *TelemetryContext) map[string]any {
	value := map[string]any{"schemaVersion": context.SchemaVersion}
	if context.Resource != nil {
		value["resource"] = telemetryResourceMap(context.Resource)
	}
	if context.Trace != nil {
		trace := map[string]any{"traceId": context.Trace.TraceID}
		if context.Trace.SpanID != "" {
			trace["spanId"] = context.Trace.SpanID
		}
		if context.Trace.ParentSpanID != "" {
			trace["parentSpanId"] = context.Trace.ParentSpanID
		}
		if context.Trace.Sampled != nil {
			trace["sampled"] = *context.Trace.Sampled
		}
		value["trace"] = trace
	}
	if context.Session != nil {
		session := map[string]any{"id": context.Session.ID}
		if context.Session.PreviousID != "" {
			session["previousId"] = context.Session.PreviousID
		}
		value["session"] = session
	}
	if context.Subject != nil {
		value["subject"] = map[string]any{"id": context.Subject.ID, "kind": context.Subject.Kind}
	}
	if context.Tags != nil {
		tags := make(map[string]any, len(context.Tags))
		for key, item := range context.Tags {
			tags[key] = item
		}
		value["tags"] = tags
	}
	return value
}

func telemetryResourceMap(resource *TelemetryResource) map[string]any {
	value := make(map[string]any)
	if resource.Service != nil {
		value["service"] = telemetryNamedVersionMap(resource.Service)
	}
	if resource.Deployment != nil {
		deployment := make(map[string]any)
		if resource.Deployment.Environment != "" {
			deployment["environment"] = resource.Deployment.Environment
		}
		if resource.Deployment.Release != "" {
			deployment["release"] = resource.Deployment.Release
		}
		value["deployment"] = deployment
	}
	if resource.Runtime != nil {
		value["runtime"] = telemetryNamedVersionMap(resource.Runtime)
	}
	if resource.Framework != nil {
		value["framework"] = telemetryNamedVersionMap(resource.Framework)
	}
	if resource.OperatingSystem != nil {
		operatingSystem := map[string]any{"name": resource.OperatingSystem.Name}
		if resource.OperatingSystem.Version != "" {
			operatingSystem["version"] = resource.OperatingSystem.Version
		}
		if resource.OperatingSystem.Build != "" {
			operatingSystem["build"] = resource.OperatingSystem.Build
		}
		value["operatingSystem"] = operatingSystem
	}
	if resource.Device != nil {
		device := make(map[string]any)
		if resource.Device.Family != "" {
			device["family"] = resource.Device.Family
		}
		if resource.Device.Model != "" {
			device["model"] = resource.Device.Model
		}
		if resource.Device.Architecture != "" {
			device["architecture"] = resource.Device.Architecture
		}
		value["device"] = device
	}
	if resource.Application != nil {
		application := make(map[string]any)
		if resource.Application.Name != "" {
			application["name"] = resource.Application.Name
		}
		if resource.Application.Version != "" {
			application["version"] = resource.Application.Version
		}
		if resource.Application.Build != "" {
			application["build"] = resource.Application.Build
		}
		value["application"] = application
	}
	return value
}

func telemetryNamedVersionMap(value *TelemetryNamedVersion) map[string]any {
	mapped := map[string]any{"name": value.Name}
	if value.Version != "" {
		mapped["version"] = value.Version
	}
	return mapped
}
