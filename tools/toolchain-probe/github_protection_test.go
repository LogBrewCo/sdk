package main

import "testing"

const githubContractContext = "Contract checks"

func githubProtectionFixture(t *testing.T) map[string]any {
	t.Helper()
	document, valid := decodeCheckDocument([]byte(`{
		"required_status_checks":{"strict":true,"contexts":["Contract checks"],"checks":[]},
		"allow_force_pushes":{"enabled":false},"allow_deletions":{"enabled":false}
	}`))
	if !valid {
		t.Fatal("invalid protection fixture")
	}
	return eventObject(document)
}

func TestGitHubFullProtection(t *testing.T) {
	t.Parallel()
	if !githubFullProtection(githubProtectionFixture(t), githubContractContext) {
		t.Fatal("valid full branch protection rejected")
	}
	for _, field := range []string{"allow_force_pushes", "allow_deletions"} {
		for _, replacement := range []any{
			nil, true,
			map[string]any{},
			map[string]any{githubProtectionEnabled: true},
			map[string]any{githubProtectionEnabled: "disabled"},
			map[string]any{githubProtectionEnabled: 0},
		} {
			fixture := githubProtectionFixture(t)
			fixture[field] = replacement
			if githubFullProtection(fixture, githubContractContext) {
				t.Fatal("missing, mistyped or enabled protection accepted")
			}
		}
	}
	for _, strict := range []any{nil, false, fixtureTrueJSON, 1} {
		fixture := githubProtectionFixture(t)
		eventObject(fixture["required_status_checks"])["strict"] = strict
		if githubFullProtection(fixture, githubContractContext) {
			t.Fatal("non-boolean strict protection accepted")
		}
	}
	if githubFullProtection(nil, githubContractContext) || githubFullProtection(githubProtectionFixture(t), "") {
		t.Fatal("invalid full protection input accepted")
	}
}

func TestGitHubRequiredContextSources(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		checks map[string]any
		valid  bool
	}{
		{map[string]any{githubStatusContexts: []any{githubContractContext}}, true},
		{map[string]any{"checks": []any{nil, map[string]any{"context": githubContractContext}}}, true},
		{map[string]any{githubStatusContexts: githubContractContext}, false},
		{map[string]any{"checks": []any{map[string]any{"context": 1}}}, false},
		{map[string]any{}, false},
	} {
		fixture := githubProtectionFixture(t)
		test.checks["strict"] = true
		fixture["required_status_checks"] = test.checks
		if githubFullProtection(fixture, githubContractContext) != test.valid {
			t.Fatal("required context source validation changed")
		}
	}
}
