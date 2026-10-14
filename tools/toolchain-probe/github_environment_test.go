package main

import "testing"

func githubEnvironmentFixture(t *testing.T) map[string]any {
	t.Helper()
	document, valid := decodeCheckDocument([]byte(`{"name":"release",
		"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false},
		"protection_rules":[{"type":"branch_policy"}],"can_admins_bypass":true}`))
	if !valid {
		t.Fatal("invalid environment fixture")
	}
	return eventObject(document)
}

func TestGitHubReleaseEnvironment(t *testing.T) {
	t.Parallel()
	const environmentName = "release"
	if !githubReleaseEnvironment(githubEnvironmentFixture(t), environmentName) {
		t.Fatal("valid release environment rejected")
	}
	for field, bad := range map[string]any{
		"name": "different-environment", "deployment_branch_policy": nil, "protection_rules": []any{},
	} {
		fixture := githubEnvironmentFixture(t)
		fixture[field] = bad
		if githubReleaseEnvironment(fixture, environmentName) {
			t.Fatal("invalid release environment accepted")
		}
	}
	for _, field := range []string{"protected_branches", "custom_branch_policies"} {
		for _, bad := range []any{nil, "enabled", 1} {
			fixture := githubEnvironmentFixture(t)
			eventObject(fixture["deployment_branch_policy"])[field] = bad
			if githubReleaseEnvironment(fixture, environmentName) {
				t.Fatal("missing or mistyped environment policy accepted")
			}
		}
	}
	fixture := githubEnvironmentFixture(t)
	fixture["protection_rules"] = []any{nil, "branch_policy", map[string]any{}}
	if githubReleaseEnvironment(fixture, environmentName) || githubReleaseEnvironment(nil, environmentName) {
		t.Fatal("invalid environment rules accepted")
	}
	custom := githubEnvironmentFixture(t)
	custom["name"] = "staging"
	if !githubReleaseEnvironment(custom, "staging") || githubReleaseEnvironment(custom, environmentName) {
		t.Fatal("environment name binding changed")
	}
}

func TestGitHubUnsafeEnvironmentPolicy(t *testing.T) {
	t.Parallel()
	for field, bad := range map[string]bool{"protected_branches": false, "custom_branch_policies": true} {
		unsafe := githubEnvironmentFixture(t)
		eventObject(unsafe["deployment_branch_policy"])[field] = bad
		if githubReleaseEnvironment(unsafe, "release") {
			t.Fatal("unsafe deployment branch policy accepted")
		}
	}
}

func TestGitHubPublicSummaryEvidence(t *testing.T) {
	t.Parallel()
	summary := map[string]any{
		"protected": true, "protection": map[string]any{
			githubProtectionEnabled:  true,
			"required_status_checks": map[string]any{githubStatusContexts: []any{githubContractContext}},
		},
	}
	if !githubPublicSummary(summary, githubContractContext) || githubFullProtection(summary, githubContractContext) {
		t.Fatal("public summary confused with full protection")
	}
	for _, bad := range []any{nil, false, fixtureTrueJSON, 1} {
		summary["protected"] = bad
		if githubPublicSummary(summary, githubContractContext) {
			t.Fatal("unprotected or mistyped summary accepted")
		}
	}
	summary["protected"] = true
	eventObject(summary["protection"])["required_status_checks"] = map[string]any{}
	if githubPublicSummary(summary, githubContractContext) {
		t.Fatal("summary without required context accepted")
	}
}
