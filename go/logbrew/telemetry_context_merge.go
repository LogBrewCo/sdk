package logbrew

func mergeTelemetryContexts(base, override *TelemetryContext) (*TelemetryContext, error) {
	normalizedBase, err := validateTelemetryContext(base, "client telemetry context")
	if err != nil {
		return nil, err
	}
	normalizedOverride, err := validateTelemetryContext(override, "event telemetry context")
	if err != nil {
		return nil, err
	}
	if normalizedBase == nil {
		return normalizedOverride, nil
	}
	if normalizedOverride == nil {
		return normalizedBase, nil
	}
	merged := &TelemetryContext{
		SchemaVersion: telemetryContextSchemaVersion,
		Resource:      mergeTelemetryResources(normalizedBase.Resource, normalizedOverride.Resource),
		Trace:         cloneTelemetryTrace(normalizedBase.Trace),
		Session:       cloneTelemetrySession(normalizedBase.Session),
		Subject:       cloneTelemetrySubject(normalizedBase.Subject),
	}
	if normalizedOverride.Trace != nil {
		merged.Trace = cloneTelemetryTrace(normalizedOverride.Trace)
	}
	if normalizedOverride.Session != nil {
		merged.Session = cloneTelemetrySession(normalizedOverride.Session)
	}
	if normalizedOverride.Subject != nil {
		merged.Subject = cloneTelemetrySubject(normalizedOverride.Subject)
	}
	if normalizedBase.Tags != nil || normalizedOverride.Tags != nil {
		merged.Tags = make(map[string]string, len(normalizedBase.Tags)+len(normalizedOverride.Tags))
		for key, value := range normalizedBase.Tags {
			merged.Tags[key] = value
		}
		for key, value := range normalizedOverride.Tags {
			merged.Tags[key] = value
		}
	}
	return validateTelemetryContext(merged, "merged telemetry context")
}

func mergeTelemetryResources(base, override *TelemetryResource) *TelemetryResource {
	if base == nil {
		return cloneTelemetryResource(override)
	}
	if override == nil {
		return cloneTelemetryResource(base)
	}
	return &TelemetryResource{
		Service:         mergeTelemetryNamedVersion(base.Service, override.Service),
		Deployment:      mergeTelemetryDeployment(base.Deployment, override.Deployment),
		Runtime:         mergeTelemetryNamedVersion(base.Runtime, override.Runtime),
		Framework:       mergeTelemetryNamedVersion(base.Framework, override.Framework),
		OperatingSystem: mergeTelemetryOperatingSystem(base.OperatingSystem, override.OperatingSystem),
		Device:          mergeTelemetryDevice(base.Device, override.Device),
		Application:     mergeTelemetryApplication(base.Application, override.Application),
	}
}

func mergeTelemetryNamedVersion(base, override *TelemetryNamedVersion) *TelemetryNamedVersion {
	if base == nil {
		return cloneTelemetryNamedVersion(override)
	}
	if override == nil {
		return cloneTelemetryNamedVersion(base)
	}
	merged := *base
	if override.Name != "" {
		merged.Name = override.Name
	}
	if override.Version != "" {
		merged.Version = override.Version
	}
	return &merged
}

func mergeTelemetryDeployment(base, override *TelemetryDeployment) *TelemetryDeployment {
	if base == nil {
		return cloneTelemetryDeployment(override)
	}
	if override == nil {
		return cloneTelemetryDeployment(base)
	}
	merged := *base
	if override.Environment != "" {
		merged.Environment = override.Environment
	}
	if override.Release != "" {
		merged.Release = override.Release
	}
	return &merged
}

func mergeTelemetryOperatingSystem(base, override *TelemetryOperatingSystem) *TelemetryOperatingSystem {
	if base == nil {
		return cloneTelemetryOperatingSystem(override)
	}
	if override == nil {
		return cloneTelemetryOperatingSystem(base)
	}
	merged := *base
	if override.Name != "" {
		merged.Name = override.Name
	}
	if override.Version != "" {
		merged.Version = override.Version
	}
	if override.Build != "" {
		merged.Build = override.Build
	}
	return &merged
}

func mergeTelemetryDevice(base, override *TelemetryDevice) *TelemetryDevice {
	if base == nil {
		return cloneTelemetryDevice(override)
	}
	if override == nil {
		return cloneTelemetryDevice(base)
	}
	merged := *base
	if override.Family != "" {
		merged.Family = override.Family
	}
	if override.Model != "" {
		merged.Model = override.Model
	}
	if override.Architecture != "" {
		merged.Architecture = override.Architecture
	}
	return &merged
}

func mergeTelemetryApplication(base, override *TelemetryApplication) *TelemetryApplication {
	if base == nil {
		return cloneTelemetryApplication(override)
	}
	if override == nil {
		return cloneTelemetryApplication(base)
	}
	merged := *base
	if override.Name != "" {
		merged.Name = override.Name
	}
	if override.Version != "" {
		merged.Version = override.Version
	}
	if override.Build != "" {
		merged.Build = override.Build
	}
	return &merged
}

func cloneTelemetryContextUnchecked(context *TelemetryContext) *TelemetryContext {
	if context == nil {
		return nil
	}
	return &TelemetryContext{
		SchemaVersion: context.SchemaVersion,
		Resource:      cloneTelemetryResource(context.Resource),
		Trace:         cloneTelemetryTrace(context.Trace),
		Session:       cloneTelemetrySession(context.Session),
		Subject:       cloneTelemetrySubject(context.Subject),
		Tags:          cloneTelemetryTags(context.Tags),
	}
}

func cloneTelemetryResource(value *TelemetryResource) *TelemetryResource {
	if value == nil {
		return nil
	}
	return &TelemetryResource{
		Service:         cloneTelemetryNamedVersion(value.Service),
		Deployment:      cloneTelemetryDeployment(value.Deployment),
		Runtime:         cloneTelemetryNamedVersion(value.Runtime),
		Framework:       cloneTelemetryNamedVersion(value.Framework),
		OperatingSystem: cloneTelemetryOperatingSystem(value.OperatingSystem),
		Device:          cloneTelemetryDevice(value.Device),
		Application:     cloneTelemetryApplication(value.Application),
	}
}

func cloneTelemetryNamedVersion(value *TelemetryNamedVersion) *TelemetryNamedVersion {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneTelemetryDeployment(value *TelemetryDeployment) *TelemetryDeployment {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneTelemetryOperatingSystem(value *TelemetryOperatingSystem) *TelemetryOperatingSystem {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneTelemetryDevice(value *TelemetryDevice) *TelemetryDevice {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneTelemetryApplication(value *TelemetryApplication) *TelemetryApplication {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneTelemetryTrace(value *TelemetryTraceContext) *TelemetryTraceContext {
	if value == nil {
		return nil
	}
	copy := *value
	if value.Sampled != nil {
		copy.Sampled = boolPointer(*value.Sampled)
	}
	return &copy
}

func cloneTelemetrySession(value *TelemetrySessionContext) *TelemetrySessionContext {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneTelemetrySubject(value *TelemetrySubjectContext) *TelemetrySubjectContext {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneTelemetryTags(value map[string]string) map[string]string {
	if value == nil {
		return nil
	}
	cloned := make(map[string]string, len(value))
	for key, item := range value {
		cloned[key] = item
	}
	return cloned
}

func boolPointer(value bool) *bool {
	return &value
}
