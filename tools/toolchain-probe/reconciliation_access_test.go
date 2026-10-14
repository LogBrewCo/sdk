package main

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"
)

func TestReconciliationAccessCommand(t *testing.T) {
	t.Parallel()
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	var output, diagnostic bytes.Buffer
	if runReleaseMetadata([]string{"reconciliation-access", root}, &output, &diagnostic) != exitOK ||
		diagnostic.Len() != 0 ||
		output.String() != "{\"scope\":\"reconciliation-access_release_metadata\",\"valid\":true}\n" {
		t.Fatal("reconciliation access command missing or receipt invalid")
	}
}

func TestReconciliationRequiredOperations(t *testing.T) {
	t.Parallel()
	source := repositorySource(t, reconciliationWorkflowPath)
	for _, required := range []string{
		`[[ "$CONTROL_REF" != "refs/heads/main"`, nativeProbeInvocation + " publication-run",
		"python-archive resolve-public", protectedNativeUses,
		"python-archive create-manifest", nativeProbeInvocation + " nuget-public",
		`--source-root "$GITHUB_WORKSPACE"`, nativeProbeInvocation + " python-public-consumer",
		"real_user_dotnet_selected_public_nuget_smoke.sh",
	} {
		changed := strings.ReplaceAll(source, required, "omitted-operation")
		if changed == source || validReconciliationAccess([]byte(changed)) {
			t.Errorf("missing reconciliation operation accepted: %s", required)
		}
	}
	for _, action := range []string{"gh-action-pypi-publish", "nuget/login"} {
		changed := source + "      - uses: " + action + "@v1\n"
		if validReconciliationAccess([]byte(changed)) {
			t.Errorf("publishing action accepted: %s", action)
		}
	}
	if validReconciliationAccess([]byte(source + "      - run: dotnet nuget push package.nupkg\n")) {
		t.Fatal("publication command accepted in reconciliation")
	}
}

func TestReconciliationAccessMutations(t *testing.T) {
	t.Parallel()
	source := repositorySource(t, pythonReconcileWorkflow)
	if !validReconciliationAccess([]byte(source)) {
		t.Fatal("actual reconciliation access policy rejected")
	}
	for before, after := range map[string]string{
		"  actions: read":  "  actions: write",
		"  contents: read": "  contents: write",
		"permissions:\n":   "permissions:\n  packages: write\n",
		"on:\n":            "on:\n  push: {}\n",
		"  pypi:\n":        "  unexpected:\n",
		"jobs:\n":          "jobs:\n  unexpected: {uses: another/workflow.yml@main}\n",
	} {
		if !strings.Contains(source, before) ||
			validReconciliationAccess([]byte(strings.ReplaceAll(source, before, after))) {
			t.Fatal("root permission, trigger, or job mutation accepted")
		}
	}
}

func TestReconciliationAccessJobOverrides(t *testing.T) {
	t.Parallel()
	source := repositorySource(t, pythonReconcileWorkflow)
	for _, job := range []string{"pypi", "nuget"} {
		header := "  " + job + ":\n"
		for _, extra := range []string{
			"    permissions: write-all\n", "    environment: release\n", "    uses: other/workflow.yml@main\n",
			"    permissions: {}\n", "    environment: null\n",
		} {
			if validReconciliationAccess([]byte(strings.Replace(source, header, header+extra, 1))) {
				t.Fatal("job override accepted")
			}
		}
	}
}

func TestReconciliationAccessCheckoutMutations(t *testing.T) {
	t.Parallel()
	source := repositorySource(t, pythonReconcileWorkflow)
	//nolint:gosec // G101: synthetic boolean checkout mutation, reviewed 2026-09-12; rejection tested below.
	for before, after := range map[string]string{
		"ref: ${{ inputs.ref }}":               "ref: main # ref: ${{ inputs.ref }}",
		protectedControlRef:                    "ref: ${{ inputs.ref }} # ref: ${{ github.workflow_sha }}",
		"persist-credentials: false":           "persist-credentials: true # persist-credentials: false",
		"repository: ${{ github.repository }}": "repository: other/repo",
		"path: .release-control":               "path: .different-control",
		"uses: actions/checkout@v6":            "uses: actions/checkout@v5",
		"      - name: Check out":              "      - if: false\n        name: Check out",
		"with:\n          ref:":                "with:\n          token: custom\n          ref:",
	} {
		count := strings.Count(source, before)
		if count == 0 {
			t.Fatal("checkout mutation does not match source fixture")
		}
		for occurrence := range count {
			parts := strings.Split(source, before)
			mutated := strings.Join(parts[:occurrence+1], before) + after + strings.Join(parts[occurrence+1:], before)
			if validReconciliationAccess([]byte(mutated)) {
				t.Fatal("checkout binding mutation accepted in one job")
			}
		}
	}
}

func TestReconciliationAccessBoundedInput(t *testing.T) {
	t.Parallel()
	source := repositorySource(t, pythonReconcileWorkflow)
	assertReleaseMetadataFiles(t, reconciliationAccessFamily, map[string]string{reconciliationWorkflowPath: source})
	for _, injected := range []string{
		"      - uses: actions/checkout@v6\n", "      - null\n",
	} {
		mutated := source + injected
		if validReconciliationAccess([]byte(mutated)) {
			t.Fatal("extra checkout or malformed step accepted")
		}
	}
	for _, invalid := range []string{"", "jobs: null", "jobs: [pypi, nuget]", "permissions: read-all"} {
		if validReconciliationAccess([]byte(invalid)) {
			t.Fatal("incomplete access policy accepted")
		}
	}
}
