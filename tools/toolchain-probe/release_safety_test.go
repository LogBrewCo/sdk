package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const (
	safeProtection = `{"required_status_checks":{"strict":true,"contexts":["Contract checks"],
		"checks":[{"context":"Contract checks"}]},"allow_force_pushes":{"enabled":false},
		"allow_deletions":{"enabled":false}}`
	safeSummary = `{"name":"main","protected":true,"protection":{"enabled":true,
		"required_status_checks":{"contexts":[],"checks":[{"context":"Contract checks"}]}}}`
	safeEnvironment = `{"name":"release","deployment_branch_policy":{"protected_branches":true,
		"custom_branch_policies":false},"protection_rules":[{"type":"branch_policy"}]}`
)

func decodeFixture(t *testing.T, text string) any {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestReleaseSafetyFindings(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		check func(any) []string
		input string
		want  []string
	}{
		{nil, safeProtection, nil},
		{nil, `{"required_status_checks":{"strict":false,"contexts":[]},"allow_force_pushes":{"enabled":true},
			"allow_deletions":{"enabled":true}}`, []string{
			"main: required status checks must be strict", "main: required status check 'Contract checks' is missing",
			"main: force pushes must stay disabled", "main: branch deletion must stay disabled",
		}},
		{nil, `{"allow_force_pushes":{},"allow_deletions":null}`, []string{
			"main: required status checks are not enabled", "main: force-push protection state is missing",
			"main: branch-deletion protection state is missing",
		}},
		{nil, `[]`, []string{"main: branch protection response is not an object"}},
		{summaryFindings, safeSummary, nil},
		{summaryFindings, `{"protected":false,"protection":{"enabled":true,"required_status_checks":{}}}`, []string{
			"main: branch must be protected", "main: required status check 'Contract checks' is missing",
		}},
		{summaryFindings, `{"protected":true,"protection":{"enabled":true}}`,
			[]string{"main: required status checks are not visible in public summary"}},
		{summaryFindings, `{"protection":{"enabled":false}}`, []string{
			"main: branch must be protected", "main: public branch protection summary is missing",
		}},
		{summaryFindings, `"main"`, []string{"main: branch summary response is not an object"}},
		{environmentFindings, safeEnvironment, nil},
		{environmentFindings, `{"name":"other","deployment_branch_policy":{"protected_branches":false,
			"custom_branch_policies":true},"protection_rules":[]}`, []string{
			"release: environment name did not match response",
			"release: deployments must be restricted to protected branches",
			"release: custom branch policies should stay disabled", "release: branch policy protection rule is missing",
		}},
		{environmentFindings, `{"name":"release","protection_rules":{"type":"branch_policy"}}`, []string{
			"release: deployment branch policy is not enabled", "release: branch policy protection rule is missing",
		}},
		{environmentFindings, `null`, []string{"release: environment response is not an object"}},
	} {
		check := test.check
		if check == nil {
			check = func(value any) []string { return branchProtectionFailures(value, "main", "Contract checks") }
		}
		if got := check(decodeFixture(t, test.input)); !slices.Equal(got, test.want) {
			t.Fatalf("%s: %q, want %q", test.input, got, test.want)
		}
	}
}

func summaryFindings(value any) []string {
	return branchSummaryFailures(value, "main", "Contract checks")
}
func environmentFindings(value any) []string { return environmentFailures(value, "release") }

func fakeGitHub(responses map[string]string) func(string) ([]byte, error) {
	return func(path string) ([]byte, error) {
		if response, found := responses[path]; found {
			return []byte(response), nil
		}
		return nil, errors.New("HTTP 404: Not Found")
	}
}

func TestReleaseSafetyCommand(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	write := func(name, text string) string {
		path := filepath.Join(directory, name)
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	protection, branchSummary, environment := write("p.json", safeProtection), write("s.json", safeSummary),
		write("e.json", safeEnvironment)
	unsafe := write("unsafe.json", `{"name":"release"}`)
	api := fakeGitHub(map[string]string{
		"repos/LogBrewCo/sdk/branches/main":        safeSummary,
		"repos/LogBrewCo/sdk/environments/release": safeEnvironment,
		"repos/LogBrewCo/sdk/branches/broken":      `{`,
	})
	for _, test := range []struct {
		arguments []string
		code      int
		output    string
	}{
		{[]string{"--branch-protection-json", protection, "--environment-json", environment}, exitOK,
			"GitHub release safety ok: main requires 'Contract checks', force pushes/deletion are disabled"},
		{[]string{"--branch-summary-json", branchSummary, "--environment-json", environment}, exitOK,
			"public summary shows main is protected"},
		{[]string{"--allow-public-branch-summary"}, exitOK, "public summary shows main is protected"},
		{nil, exitFailure, "failed: gh api repos/LogBrewCo/sdk/branches/main/protection failed: HTTP 404"},
		{[]string{"--allow-public-branch-summary", "--branch", "broken"}, exitFailure,
			"failed: gh api repos/LogBrewCo/sdk/branches/broken returned invalid JSON"},
		{[]string{"--branch-protection-json", protection, "--environment", "staging"}, exitFailure,
			"environments/staging failed: HTTP 404"},
		{[]string{"--branch-protection-json", protection, "--environment-json", unsafe}, exitFailure,
			"failed:\n- release: deployment branch policy is not enabled\n- release: branch policy"},
		{[]string{"--branch-protection-json", directory}, exitFailure, directory + " is not a readable JSON document"},
		{[]string{"--branch-protection-json", protection, "--branch-summary-json", branchSummary}, exitUsage, "usage:"},
		{[]string{"extra"}, exitUsage, "usage:"},
		{[]string{"--unknown"}, exitUsage, "flag provided but not defined"},
	} {
		var output, diagnostic bytes.Buffer
		code := checkReleaseSafety(test.arguments, api, &output, &diagnostic)
		if code != test.code || !strings.Contains(output.String()+diagnostic.String(), test.output) {
			t.Fatalf("%v: code %d output %q %q", test.arguments, code, output.String(), diagnostic.String())
		}
	}
}

func TestGitHubCLIReportsFailures(t *testing.T) {
	directory := t.TempDir()
	t.Setenv("PATH", directory)
	if _, err := ghAPI("repos/x"); err == nil || !strings.Contains(err.Error(), "GitHub CLI `gh` is required") {
		t.Fatalf("missing gh: %v", err)
	}
	script := "#!/bin/sh\nif [ \"$2\" = ok ]; then echo '{}'; elif [ \"$2\" = quiet ]; then echo out; exit 1; " +
		"else echo denied >&2; exit 1; fi\n"
	if err := os.WriteFile(filepath.Join(directory, "gh"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]string{"ok": "", "quiet": "out", "denied": "denied"} {
		data, err := ghAPI(path)
		if (want == "" && (err != nil || string(data) != "{}\n")) || (want != "" && (err == nil || err.Error() != want)) {
			t.Fatalf("%s: %q %v", path, data, err)
		}
	}
}
