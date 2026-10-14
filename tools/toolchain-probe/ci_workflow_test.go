package main

import (
	"encoding/json"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

func TestNativeReleaseMetadataCICallers(t *testing.T) {
	t.Parallel()
	for _, path := range []string{ciWorkflowPath, readinessWorkflowPath} {
		workflow := repositorySource(t, path)
		expected := nativeProbeInvocation + ` release-metadata all "$GITHUB_WORKSPACE"`
		if !strings.Contains(workflow, expected) ||
			strings.Contains(workflow, "run: python3 "+releaseMetadataScript) {
			t.Errorf("native aggregate metadata gate missing in %s", path)
		}
	}
}

func TestNativeReleaseMetadataLocalCallers(t *testing.T) {
	t.Parallel()
	for path, command := range map[string]string{
		"scripts/check_cpp_package.sh": nativeProbeInvocation + ` release-metadata cpp "$package_root"`,
		"scripts/check_public_sdks.sh": nativeProbeInvocation + ` release-metadata all "$PWD"`,
	} {
		script := repositorySource(t, path)
		if !strings.Contains(script, command) || strings.Contains(script, releaseMetadataScript) {
			t.Errorf("native release metadata local gate missing in %s", path)
		}
	}
}

func TestNativeNugetMetadataCaller(t *testing.T) {
	t.Parallel()
	workflow := repositorySource(t, nugetPublicationWorkflow)
	command := nativeProbeInvocation + ` release-metadata all "$GITHUB_WORKSPACE" "${version_args[@]}"`
	build := strings.Index(workflow, "uses: ./.release-control/tools/toolchain-probe")
	validation := strings.Index(workflow, command)
	if build < 0 || validation <= build || strings.Contains(workflow, "python3 "+releaseMetadataScript) {
		t.Fatal("NuGet metadata must use the protected native verifier with selected version overrides")
	}
}

func TestNativeNPMMetadataCaller(t *testing.T) {
	t.Parallel()
	workflow := repositorySource(t, publicationWorkflow)
	steps := yamlField(parseMetadataYAML([]byte(workflow)), "jobs", "npm", "steps")
	checked, built, invoked := false, false, false
	for _, step := range steps.Content {
		if yamlScalar(yamlField(step, "name"), yamlStringTag, "Check out protected npm metadata verifier") {
			checked = validReconciliationCheckout(step, map[string]string{
				workflowRepositoryKey: workflowRepository,
				workflowRefKey:        workflowControlRef, "path": ".release-control",
			}, "sparse-checkout", "sparse-checkout-cone-mode")
		}
		if yamlScalar(yamlField(step, "uses"), yamlStringTag, "./.release-control/tools/toolchain-probe") {
			built = checked
		}
		if script := yamlField(step, "run"); script != nil && strings.Contains(script.Value,
			nativeProbeInvocation+` release-metadata all "$GITHUB_WORKSPACE" "${metadata_args[@]}"`) {
			invoked = built
		}
	}
	if !invoked {
		t.Fatal("npm metadata must run after protected native bootstrap with selected version overrides")
	}
}

func TestNativeNPMRegistryCaller(t *testing.T) {
	t.Parallel()
	workflow := repositorySource(t, publicationWorkflow)
	steps := yamlField(parseMetadataYAML([]byte(workflow)), "jobs", "npm", "steps")
	built, verified := false, false
	for _, step := range steps.Content {
		if yamlScalar(yamlField(step, "uses"), yamlStringTag, "./.release-control/tools/toolchain-probe") {
			built = true
		}
		if yamlScalar(yamlField(step, "name"), yamlStringTag, "Verify public npm packages") {
			script := yamlField(step, "run")
			verified = built && script != nil && validMetadataText([]byte(script.Value), []string{
				nativeProbeInvocation + ` registry-publication "${verify_args[@]}"`,
				"--require-npm-provenance --timeout 2 --retries 8 --retry-delay 1",
				`--npm-package "${package_version%%=*}" --npm-version "$package_version"`,
			}) && !strings.Contains(script.Value, "python3 scripts/check_registry_publication.py")
		}
	}
	if !verified {
		t.Fatal("npm registry readback must use native verifier with provenance and selected versions")
	}
}

func TestNativePythonRegistryCaller(t *testing.T) {
	t.Parallel()
	workflow := repositorySource(t, publicationWorkflow)
	steps := yamlField(parseMetadataYAML([]byte(workflow)), "jobs", registryPythonFamily, "steps")
	built, verified := false, false
	for _, step := range steps.Content {
		if yamlScalar(yamlField(step, "uses"), yamlStringTag, "./.release-control/tools/toolchain-probe") {
			built = true
		}
		if yamlScalar(yamlField(step, "name"), yamlStringTag, "Verify public PyPI packages") {
			script := yamlField(step, "run")
			verified = built && script != nil && validMetadataText([]byte(script.Value), []string{
				nativeProbeInvocation + ` registry-publication "${verify_args[@]}"`,
				"--include-pypi-extras", "--pypi-version", "--version",
			}) && !strings.Contains(script.Value, "python3 scripts/check_registry_publication.py")
		}
	}
	if !verified {
		t.Fatal("Python registry readback must use native verifier with selected package versions")
	}
}

func TestCISelectionContract(t *testing.T) {
	t.Parallel()
	workflow := repositorySource(t, ciWorkflowPath)
	requireSourceText(t, workflow,
		"name: Detect changed SDK areas", "needs: changed-areas", "unit_test_run_all", "unit_test_modules",
		"Run focused unit tests", "Run full unit tests", "Run Maven Central public install smoke",
		"Run React Native native persistence checks", "Compile installed Android bridge and native library",
		":logbrew:assembleRelease -PnewArchEnabled=false", "steps.areas.outputs.run_all", "steps.areas.outputs.modules",
		"go run . ci-selection --git", "MODULES: ${{ needs.changed-areas.outputs.unit_test_modules }}",
		`read -r -a modules <<< "$MODULES"`, `python3 -m unittest "${modules[@]}"`,
	)
	for _, text := range []string{
		"hashFiles(", "ci_changed_areas.py", "ci_unit_test_targets.py",
		"python3 -m unittest ${{", "actions/setup-go@",
	} {
		if strings.Contains(workflow, text) {
			t.Errorf("CI retains obsolete selection/bootstrap: %q", text)
		}
	}
	for area := range strings.FieldsSeq(knownAreas) {
		if !strings.Contains(workflow, "needs.changed-areas.outputs."+area) {
			t.Errorf("CI is missing the %s selection gate", area)
		}
	}
}

func TestCIPinnedToolchain(t *testing.T) {
	t.Parallel()
	workflow := repositorySource(t, ciWorkflowPath)
	for _, name := range []string{"changed-areas", "contract-checks", "python-compatibility"} {
		job := workflowJob(t, workflow, name)
		if !strings.Contains(job, "uses: ./tools/toolchain-probe") {
			t.Errorf("CI job %s lacks native pinned bootstrap", name)
		}
	}
	version, err := os.ReadFile(".go-version")
	if err != nil || string(version) != "1.27.1\n" {
		t.Fatal("unexpected native toolchain pin")
	}
}

func TestCINativeFixtureChecks(t *testing.T) {
	t.Parallel()
	for _, path := range []string{ciWorkflowPath, readinessWorkflowPath} {
		workflow := repositorySource(t, path)
		requireSourceText(t, workflow,
			`"$LOGBREW_TOOLCHAIN_PROBE_BIN" event-batch-check spec/event-batch.schema.json fixtures/valid-batch.json`,
			`"$LOGBREW_TOOLCHAIN_PROBE_BIN" event-batch-check spec/event-batch.schema.json `+
				`fixtures/invalid-batch.json --expect-invalid`,
		)
		contract := workflowJob(t, workflow, "contract-checks")
		requireOrderedSource(t, contract, "uses: ./tools/toolchain-probe", "event-batch-check")
		if strings.Contains(workflow, "validate_fixtures.py") {
			t.Error("fixture validation must use the bootstrapped native verifier")
		}
	}
}

const packageValidationFixture = `{
  "rust/logbrew/tests/run.sh": {"batches": 1, "fields": 0},
  "scripts/check_c_package.sh": {"batches": 4, "fields": 0},
  "scripts/check_cpp_package.sh": {"batches": 2, "fields": 0},
  "scripts/check_django_package.sh": {"batches": 1, "fields": 10, "consumer": "django"},
  "scripts/check_dotnet_package.sh": {"batches": 12, "fields": 0},
  "scripts/check_fastapi_package.sh": {"batches": 1, "fields": 10, "consumer": "fastapi"},
  "scripts/check_flask_package.sh": {"batches": 3, "fields": 12, "consumer": "flask"},
  "scripts/check_java_package.sh": {"batches": 4, "fields": 0},
  "scripts/check_kotlin_package.sh": {"batches": 4, "fields": 0},
  "scripts/check_objc_package.sh": {"batches": 2, "fields": 0},
  "scripts/check_ruby_package.sh": {"batches": 2, "fields": 0},
  "scripts/check_unity_package.sh": {"batches": 7, "fields": 0},
  "scripts/real_user_angular_smoke.sh": {"batches": 4, "fields": 0},
  "scripts/real_user_browser_smoke.sh": {"batches": 4, "fields": 0},
  "scripts/real_user_c_smoke.sh": {"batches": 4, "fields": 0},
  "scripts/real_user_cpp_smoke.sh": {"batches": 1, "fields": 0},
  "scripts/real_user_django_smoke.sh": {"batches": 1, "fields": 7},
  "scripts/real_user_dotnet_smoke.sh": {"batches": 12, "fields": 0},
  "scripts/real_user_express_smoke.sh": {"batches": 4, "fields": 0},
  "scripts/real_user_fastapi_smoke.sh": {"batches": 1, "fields": 7},
  "scripts/real_user_fastify_smoke.sh": {"batches": 4, "fields": 0},
  "scripts/real_user_flask_high_load_smoke.sh": {"batches": 1, "fields": 0},
  "scripts/real_user_flask_smoke.sh": {"batches": 3, "fields": 6},
  "scripts/real_user_go_public_module_smoke.sh": {"batches": 2, "fields": 0},
  "scripts/real_user_go_smoke.sh": {"batches": 11, "fields": 0},
  "scripts/real_user_java_jms_smoke.sh": {"batches": 1, "fields": 0},
  "scripts/real_user_java_opentelemetry_smoke.sh": {"batches": 1, "fields": 0},
  "scripts/real_user_java_queue_trace_smoke.sh": {"batches": 1, "fields": 0},
  "scripts/real_user_java_smoke.sh": {"batches": 10, "fields": 0},
  "scripts/real_user_java_spring_kafka_smoke.sh": {"batches": 1, "fields": 0},
  "scripts/real_user_js_smoke.sh": {"batches": 8, "fields": 0},
  "scripts/real_user_kotlin_smoke.sh": {"batches": 5, "fields": 0},
  "scripts/real_user_nestjs_smoke.sh": {"batches": 4, "fields": 0},
  "scripts/real_user_next_smoke.sh": {"batches": 6, "fields": 0},
  "scripts/real_user_node_smoke.sh": {"batches": 6, "fields": 0},
  "scripts/real_user_objc_smoke.sh": {"batches": 3, "fields": 0},
  "scripts/real_user_openupm_public_smoke.sh": {"batches": 7, "fields": 0},
  "scripts/real_user_php_smoke.sh": {"batches": 15, "fields": 0},
  "scripts/real_user_python_smoke.sh": {"batches": 2, "fields": 8},
  "scripts/real_user_react_native_apollo_smoke.sh": {"batches": 2, "fields": 0},
  "scripts/real_user_react_native_smoke.sh": {"batches": 8, "fields": 0},
  "scripts/real_user_react_smoke.sh": {"batches": 6, "fields": 0},
  "scripts/real_user_ruby_smoke.sh": {"batches": 5, "fields": 0},
  "scripts/real_user_rust_smoke.sh": {"batches": 10, "fields": 0},
  "scripts/real_user_spring_boot_smoke.sh": {"batches": 1, "fields": 0},
  "scripts/real_user_svelte_smoke.sh": {"batches": 4, "fields": 0},
  "scripts/real_user_swift_smoke.sh": {"batches": 3, "fields": 0},
  "scripts/real_user_swiftpm_public_smoke.sh": {"batches": 1, "fields": 0},
  "scripts/real_user_unity_smoke.sh": {"batches": 8, "fields": 0},
  "scripts/real_user_vue_smoke.sh": {"batches": 4, "fields": 0}
}`

func TestPackageNativeValidationCalls(t *testing.T) {
	t.Parallel()
	var cases map[string]struct {
		Consumer string `json:"consumer"`
		Batches  int    `json:"batches"`
		Fields   int    `json:"fields"`
	}
	const expectedCallers = 50
	if err := json.Unmarshal([]byte(packageValidationFixture), &cases); err != nil || len(cases) != expectedCallers {
		t.Fatal("invalid package validation fixture")
	}
	for name, item := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			text := repositorySource(t, name)
			if strings.Contains(text, "validate_fixtures.py") || strings.Contains(text, "check_contract") {
				t.Error("package caller retains a superseded validation path")
			}
			if item.Consumer != "" {
				assertPythonConsumerCaller(t, text, item.Consumer, item.Batches, item.Fields)
				return
			}
			invocation := "run_native_verifier"
			if name == "rust/logbrew/tests/run.sh" {
				invocation = nativeProbeInvocation
			} else {
				requireSourceText(t, text, `source "$repo_root/scripts/native_verifier.sh"`)
			}
			assertPackageValidationCounts(t, text, invocation, item.Batches, item.Fields)
		})
	}
}

func assertPackageValidationCounts(t *testing.T, source, invocation string, batches, fields int) {
	t.Helper()
	batch := invocation + ` event-batch-check "$repo_root/spec/event-batch.schema.json"`
	if batches <= 0 || strings.Count(source, batch) != batches {
		t.Error("package caller must preserve every event-batch validation")
	}
	if strings.Count(source, invocation+" package-json ") != fields {
		t.Error("package caller must preserve every field and event check")
	}
}

func assertPythonConsumerCaller(t *testing.T, source, framework string, batches, fields int) {
	t.Helper()
	requireSourceText(t, source,
		`source "$repo_root/scripts/native_verifier.sh"`,
		`run_native_verifier python-consumer `+framework+` "$repo_root" "$tmp_dir/venv/bin/python"`,
	)
	if strings.Contains(source, "package-json ") || strings.Contains(source, "-m unittest ") {
		t.Error("package caller retains parallel consumer checks")
	}
	plan := pythonConsumerExamples(framework, "/fixture")
	checks := 0
	for _, example := range plan {
		checks += len(example.checks)
	}
	if len(plan) < batches || checks < fields {
		t.Error("native consumer lost legacy validation coverage")
	}
}

func requireSourceText(t *testing.T, source string, required ...string) {
	t.Helper()
	for _, text := range required {
		if !strings.Contains(source, text) {
			t.Errorf("required source contract missing: %s", text)
		}
	}
}

func TestCIContractJobBudgetAndFamilies(t *testing.T) {
	t.Parallel()
	contract := workflowJob(t, repositorySource(t, ciWorkflowPath), "contract-checks")
	budget := regexp.MustCompile(`(?m)^ {4}timeout-minutes: (\d+)$`).FindStringSubmatch(contract)
	if len(budget) != 2 {
		t.Fatal("contract job needs a bounded diagnostic timeout")
	}
	minutes, err := strconv.Atoi(budget[1])
	const priorDiagnosticCeilingMinutes = 90
	if err != nil || minutes <= 0 || minutes > priorDiagnosticCeilingMinutes {
		t.Fatal("contract job exceeds its previous diagnostic ceiling")
	}
	for area := range strings.FieldsSeq("release_artifacts rust javascript python go c cpp java " +
		"dotnet unity ruby php kotlin maven") {
		if !strings.Contains(contract, "needs.changed-areas.outputs."+area) {
			t.Errorf("contract job lost the %s gate", area)
		}
	}
}

func repositorySource(t *testing.T, path string) string {
	t.Helper()
	root, err := os.OpenRoot("../..")
	if err != nil {
		t.Fatal(err)
	}
	data, err := root.ReadFile(path)
	if closeErr := root.Close(); err != nil || closeErr != nil {
		t.Fatal("repository source unavailable")
	}
	return string(data)
}

func workflowJob(t *testing.T, workflow, name string) string {
	t.Helper()
	_, job, found := strings.Cut(workflow, "\n  "+name+":\n")
	if !found {
		t.Fatalf("workflow job missing: %s", name)
	}
	if end := regexp.MustCompile(`(?m)^ {2}[a-z][a-z-]*:\n`).FindStringIndex(job); end != nil {
		job = job[:end[0]]
	}
	return job
}
