package main

const (
	githubProtectionEnabled = "enabled"
	githubStatusContexts    = "contexts"
)

func githubRequiredContext(protection map[string]any, required string) bool {
	checks := eventObject(protection["required_status_checks"])
	if contexts, array := checks[githubStatusContexts].([]any); array {
		for _, context := range contexts {
			if context == required {
				return true
			}
		}
	}
	if entries, array := checks["checks"].([]any); array {
		for _, entry := range entries {
			if eventObject(entry)["context"] == required {
				return true
			}
		}
	}
	return false
}

func githubDisabledProtection(protection map[string]any, name string) bool {
	flag, explicit := eventObject(protection[name])[githubProtectionEnabled].(bool)
	return explicit && !flag
}

func githubFullProtection(document any, requiredContext string) bool {
	protection, object := document.(map[string]any)
	if !object || requiredContext == "" {
		return false
	}
	checks := eventObject(protection["required_status_checks"])
	strict, explicit := checks["strict"].(bool)
	return explicit && strict && githubRequiredContext(protection, requiredContext) &&
		githubDisabledProtection(protection, "allow_force_pushes") &&
		githubDisabledProtection(protection, "allow_deletions")
}
