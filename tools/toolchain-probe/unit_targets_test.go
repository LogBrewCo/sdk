package main

import (
	"strings"
	"testing"
)

const unitPathFixture = "tests/test_a.py"

func TestUnitTargets(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		modules string
		paths   []string
	}{
		{"", nil},
		{"", []string{" \t", "./"}},
		{"", []string{"go/logbrew.go"}},
		{"", []string{"scripts/new_unknown_helper.py"}},
		{"", []string{"scripts/validate_fixtures.py"}},
		{"", []string{"scripts/new_unknown_helper.sh"}},
		{"", []string{".github/workflows/unknown.yml"}},
		{"", []string{"tests/helpers.py"}},
		{"", []string{unitPathFixture, "tests/helpers.py"}},
		{"tests.test_a tests.test_b", []string{unitPathFixture, unitPathFixture, " ./tests/test_b.py "}},
		{"tests.test_nested.test_case", []string{"tests/test_nested/test_case.py"}},
		{"", []string{"tests/test_bad\nmodules=bad.py"}},
		{"", []string{"tests/test_$(command).py"}},
		{"", []string{"tests/test_bad;command.py"}},
		{"", []string{"tests/test_bad/../test_case.py"}},
		{"", []string{"tests/test_bad-name.py"}},
		{"tests.test_maven_central_public_smoke", []string{mavenPublicSmoke}},
		{"tests.test_native_release_public_smoke", []string{"scripts/real_user_native_release_public_smoke.sh"}},
		{"tests.test_react_native_global_errors", []string{"scripts/real_user_react_native_smoke.sh"}},
		{"tests.test_default_ingest_endpoints", []string{
			"js/logbrew-node/index.js", "scripts/real_user_node_ingest_contract_smoke.sh",
			"tests/test_default_ingest_endpoints.py",
		}},
		{
			"tests.test_go_workflow_cache_path tests.test_js_installed_artifact_workflow_gates " +
				"tests.test_release_artifact_smoke_gates",
			[]string{".github/workflows/ci.yml"},
		},
	} {
		t.Run(strings.Join(test.paths, ","), func(t *testing.T) {
			t.Parallel()
			var output strings.Builder
			if code := writeUnitTargets(&output, test.paths); code != exitOK {
				t.Fatalf("target output failed: %d", code)
			}
			flag := "false"
			if test.modules == "" {
				flag = fixtureTrueJSON
			}
			if want := "run_all=" + flag + "\nmodules=" + test.modules + "\n"; output.String() != want {
				t.Fatalf("targets = %q, want %q", output.String(), want)
			}
		})
	}
}

func TestReleaseUnitTargets(t *testing.T) {
	t.Parallel()
	for _, test := range []struct{ workflow, scripts, modules string }{
		{"reconcile-public-packages", "check_release_metadata", "release_artifact_receipt_modes release_metadata"},
		{
			"publish-packages", "check_release_metadata",
			"release_metadata swiftpm_public_smoke",
		},
	} {
		t.Run(test.workflow, func(t *testing.T) {
			t.Parallel()
			paths := []string{".github/workflows/" + test.workflow + ".yml"}
			for script := range strings.FieldsSeq(test.scripts) {
				paths = append(paths, "scripts/"+script+".py")
			}
			expected := strings.Fields(test.modules)
			for index, module := range expected {
				expected[index] = "tests.test_" + module
			}
			var output strings.Builder
			if writeUnitTargets(&output, paths) != exitOK ||
				output.String() != "run_all=false\nmodules="+strings.Join(expected, " ")+"\n" {
				t.Fatalf("release targets = %q", output.String())
			}
		})
	}
}
