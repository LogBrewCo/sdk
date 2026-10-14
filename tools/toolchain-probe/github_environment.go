package main

func githubBoolean(object map[string]any, name string, expected bool) bool {
	value, explicit := object[name].(bool)
	return explicit && value == expected
}

func githubPublicSummary(document any, requiredContext string) bool {
	summary, object := document.(map[string]any)
	if !object || requiredContext == "" || !githubBoolean(summary, "protected", true) {
		return false
	}
	protection := eventObject(summary["protection"])
	return githubBoolean(protection, githubProtectionEnabled, true) &&
		githubRequiredContext(protection, requiredContext)
}

func githubReleaseEnvironment(document any, name string) bool {
	environment, object := document.(map[string]any)
	if !object || name == "" || environment["name"] != name {
		return false
	}
	policy := eventObject(environment["deployment_branch_policy"])
	if !githubBoolean(policy, "protected_branches", true) || !githubBoolean(policy, "custom_branch_policies", false) {
		return false
	}
	rules, array := environment["protection_rules"].([]any)
	if !array {
		return false
	}
	for _, rule := range rules {
		if eventObject(rule)["type"] == "branch_policy" {
			return true
		}
	}
	return false
}
