package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func selected(t *testing.T, paths ...string) (map[string]bool, []string, bool) {
	t.Helper()
	areas := map[string]bool{}
	var modules []string
	runAll := false
	for line := range strings.Lines(ciSelection(paths)) {
		key, value, _ := strings.Cut(strings.TrimSuffix(line, "\n"), "=")
		switch key {
		case "run_all":
			runAll = value == "true"
		case "modules":
			modules = strings.Fields(value)
		default:
			areas[key] = value == "true"
		}
	}
	return areas, modules, runAll
}

func onlyAreas(t *testing.T, areas map[string]bool, want ...string) {
	t.Helper()
	for _, area := range ciAreas {
		if areas[area] != slices.Contains(want, area) {
			t.Fatalf("area %s = %v, want only %v", area, areas[area], want)
		}
	}
}

func TestCISelectAreas(t *testing.T) {
	t.Parallel()
	for path, want := range map[string][]string{
		"rust/logbrew/src/lib.rs":                                    {"rust"},
		"rust-toolchain.toml":                                        {"rust"},
		"Cargo.lock":                                                 {"rust"},
		"./js/logbrew-js/src/index.ts":                               {"javascript"},
		" python/logbrew_py/src/logbrew/__init__.py ":                {"python"},
		"tools/toolchain-probe/.go-version":                          {"go"},
		"java/logbrew-java/src/Main.java":                            {"java"},
		"Package.swift":                                              {"swift"},
		"scripts/real_user_swift_build_executable.sh":                {"swift"},
		"scripts/check_go_static.sh":                                 {"go"},
		"scripts/real_user_aws_sqs_smoke.sh":                         {"javascript"},
		"scripts/check_django_payload.py":                            {"python"},
		"scripts/real_user_spring_boot_smoke.sh":                     {"java"},
		"scripts/real_user_maven_central_public_smoke.sh":            {"maven"},
		".github/workflows/publish-packages.yml":                     {"maven"},
		"scripts/real_user_next_release_artifact_smoke.sh":           {"release_artifacts"},
		"js/logbrew-js/release-artifact/upload.js":                   {"javascript", "release_artifacts"},
		"tools/toolchain-probe/native_symbols.go":                    {"go", "release_artifacts"},
		"tools/toolchain-probe/js_artifacts.go":                      {"go", "release_artifacts"},
		"scripts/real_user_native_release_public_smoke.sh":           {"c"},
		"js/logbrew-react-native/README.md":                          {"javascript"},
		"js/logbrew-react-native/src/NativeStore.ts":                 {"javascript", "react_native_native"},
		"js/logbrew-react-native/persistent-delivery.native.js":      {"javascript", "react_native_native"},
		"swift/logbrew-swift/Sources/LogBrewCrash/CrashEngine.swift": {"swift", "javascript", "react_native_native"},
		"go":                       nil,
		"gopher/main.go":           nil,
		"javascript/main.js":       nil,
		"maven/pom.xml":            nil,
		"release_artifacts/a.json": nil,
	} {
		areas, _, _ := selected(t, path)
		onlyAreas(t, areas, want...)
	}
}

func TestCISelectUnitTests(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		paths []string
		want  []string
	}{
		{[]string{"scripts/real_user_maven_central_public_smoke.sh"}, []string{"tests.test_maven_central_public_smoke"}},
		{[]string{"tests/test_release_metadata.py", "tests/test_release_metadata.py"}, []string{"tests.test_release_metadata"}},
		{[]string{"js/logbrew-node/index.js", "scripts/real_user_node_ingest_contract_smoke.sh"},
			[]string{"tests.test_default_ingest_endpoints"}},
		{[]string{".github/workflows/reconcile-public-packages.yml", "scripts/real_user_dotnet_selected_public_nuget_smoke.sh"}, publicReconciliationTests},
	} {
		_, modules, runAll := selected(t, test.paths...)
		want := slices.Compact(slices.Sorted(slices.Values(test.want)))
		if runAll || !slices.Equal(modules, want) {
			t.Fatalf("%v: run_all %v modules %v, want %v", test.paths, runAll, modules, want)
		}
	}
	for _, paths := range [][]string{
		nil, {"js/logbrew-js/src/index.ts"}, {"tests/helper.py"}, {"scripts/new_unknown_helper.py"},
		{"tests/test_a.py", ".github/workflows/new.yml"},
		{"tests/test_a.py", "tests/test_$(curl example.invalid).py"}, {"tests/test_a b.py"}, {"tests/test_a;id.py"},
		{"tests/test_a`id`.py"}, {"\"tests/test_a\\nb.py\""},
	} {
		if _, modules, runAll := selected(t, paths...); !runAll || len(modules) != 0 {
			t.Fatalf("%v: run_all %v modules %v", paths, runAll, modules)
		}
	}
}

func TestCISelectChangedPathsFollowTheEvent(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		env  map[string]string
		want string
	}{
		{map[string]string{"GITHUB_EVENT_NAME": "pull_request", "GITHUB_BASE_REF": "main"}, "diff --name-only origin/main...HEAD"},
		{map[string]string{"GITHUB_EVENT_BEFORE": "abc", "GITHUB_SHA": "def"}, "diff --name-only abc..def"},
		{map[string]string{"GITHUB_EVENT_BEFORE": "0000"}, "diff-tree --no-commit-id --name-only -r HEAD"},
	} {
		var called string
		paths, err := ciChangedPaths(func(name string) string { return test.env[name] },
			func(arguments ...string) ([]string, error) {
				called = strings.Join(arguments, " ")
				return []string{"go/logbrew/a.go"}, nil
			})
		if err != nil || called != test.want || len(paths) != 1 {
			t.Fatalf("git %q, want %q", called, test.want)
		}
	}
}

func TestCISelectOutputs(t *testing.T) {
	t.Parallel()
	target := filepath.Join(t.TempDir(), "output")
	env := map[string]string{"GITHUB_OUTPUT": target}
	getenv := func(name string) string { return env[name] }
	gitPaths := func(...string) ([]string, error) { return []string{"go/logbrew/a.go", " "}, nil }
	var output, diagnostic bytes.Buffer
	for range 2 {
		if code := checkCISelect([]string{"--github-output"}, getenv, gitPaths, &output, &diagnostic); code != exitOK {
			t.Fatalf("code %d: %s", code, diagnostic.String())
		}
	}
	data, _ := os.ReadFile(target)
	if strings.Count(string(data), "go=true\n") != 2 || output.Len() != 0 {
		t.Fatalf("output %q", data)
	}
	if code := checkCISelect([]string{"go/x.go"}, getenv, gitPaths, &output, &diagnostic); code != exitOK ||
		!strings.Contains(output.String(), "go=true\nc=false\n") {
		t.Fatalf("stdout %q", output.String())
	}
	failing := func(...string) ([]string, error) { return nil, errors.New("exit status 128") }
	for _, test := range []struct {
		arguments []string
		env       map[string]string
		git       func(...string) ([]string, error)
		code      int
	}{
		{[]string{"--paths"}, env, gitPaths, exitUsage},
		{[]string{"--github-output", "go/x.go"}, nil, gitPaths, exitUsage},
		{[]string{"--github-output", "go/x.go"}, map[string]string{"GITHUB_OUTPUT": t.TempDir()}, gitPaths, exitFailure},
		{nil, env, failing, exitFailure},
	} {
		getenv := func(name string) string { return test.env[name] }
		if code := checkCISelect(test.arguments, getenv, test.git, &output, &diagnostic); code != test.code {
			t.Fatalf("%v: code %d, want %d", test.arguments, code, test.code)
		}
	}
}

func TestRunGitListsChangedPaths(t *testing.T) {
	t.Parallel()
	if lines, err := runGit("version"); err != nil || len(lines) != 1 || !strings.HasPrefix(lines[0], "git version ") {
		t.Fatalf("lines %v error %v", lines, err)
	}
	if _, err := runGit("not-a-git-command"); err == nil {
		t.Fatal("unknown git command succeeded")
	}
}

// The CI workflow gates language jobs on the selection, so its output names
// must match what this mode writes.
func TestCIWorkflowUsesTheSelection(t *testing.T) {
	t.Parallel()
	data, err := os.ReadFile("../../.github/workflows/ci.yml")
	if err != nil {
		t.Fatal(err)
	}
	workflow := string(data)
	contract := strings.SplitN(strings.SplitN(workflow, "\n  contract-checks:\n", 2)[1], "\n  dotnet-durability:\n", 2)[0]
	for _, want := range []string{
		"name: Detect changed SDK areas", "\"${LOGBREW_TOOLCHAIN_PROBE_BIN:?}\" ci-select --github-output",
		"unit_test_run_all: ${{ steps.select.outputs.run_all }}",
		"unit_test_modules: ${{ steps.select.outputs.modules }}", "Run focused unit tests", "Run full unit tests",
		"name: Set up Go\n        uses: actions/setup-go@", "go-version-file: tools/toolchain-probe/.go-version",
		"Run React Native native persistence checks", ":logbrew:assembleRelease -PnewArchEnabled=false",
		"Run Maven Central public install smoke",
	} {
		if !strings.Contains(workflow, want) {
			t.Fatalf("workflow lacks %q", want)
		}
	}
	for _, area := range ciAreas {
		if !strings.Contains(workflow, area+": ${{ steps.select.outputs."+area+" }}") ||
			!strings.Contains(workflow, "needs.changed-areas.outputs."+area+" == 'true'") {
			t.Fatalf("workflow does not gate on %s", area)
		}
		if area != "react_native_native" && area != "swift" && area != "objc" &&
			!strings.Contains(contract, "needs.changed-areas.outputs."+area) {
			t.Fatalf("contract checks do not gate on %s", area)
		}
	}
	focused := strings.SplitN(strings.SplitN(contract, "name: Run focused unit tests", 2)[1], "- name:", 2)[0]
	if !strings.Contains(focused, "UNIT_TEST_MODULES: ${{ needs.changed-areas.outputs.unit_test_modules }}") ||
		strings.Count(focused, "${{") != 2 || !strings.Contains(focused, `"$UNIT_TEST_MODULES"`) {
		t.Fatalf("focused unit tests must pass modules through the environment:\n%s", focused)
	}
	if !strings.Contains(contract, "timeout-minutes: 90") || strings.Contains(workflow, "hashFiles(") {
		t.Fatal("contract checks budget or repository-presence gate changed")
	}
}
