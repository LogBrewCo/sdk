package main

import (
	"io"
	"os"
	"os/exec"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

const ciSelectMode = "ci-select"

// A changed test file name becomes a module name only when it is a plain
// dotted identifier; any other name runs every unit test instead.
var unitTestModule = regexp.MustCompile(`^[A-Za-z0-9_.]+$`)

var (
	// CI areas in output order; each gates a set of language or smoke jobs.
	ciAreas = []string{
		"release_artifacts", "react_native_native", "rust", "javascript", "python", "go", "c", "cpp",
		"java", "dotnet", "unity", "ruby", "php", "swift", "objc", "kotlin", "maven",
	}
	// Areas whose top-level directory and real_user_<area>_ / check_<area>_ scripts select them.
	ciSourceAreas = []string{
		"rust", "python", "go", "c", "cpp", "java", "dotnet", "unity", "ruby", "php", "swift", "objc", "kotlin",
	}
	ciScriptPrefixes = map[string][]string{
		"javascript": {
			"real_user_js_", "real_user_browser_", "real_user_node_", "real_user_prisma_", "real_user_bullmq_",
			"real_user_kafkajs_", "real_user_amqplib_", "real_user_aws_sqs_", "real_user_express_",
			"real_user_fastify_", "real_user_nestjs_", "real_user_angular_", "real_user_vue_", "real_user_svelte_",
			"real_user_react_", "check_js_",
		},
		"python": {
			"check_fastapi_", "check_flask_", "check_django_", "real_user_fastapi_", "real_user_flask_",
			"real_user_django_",
		},
		"c":     {"real_user_native_release_public_"},
		"java":  {"real_user_spring_"},
		"maven": {"real_user_maven_", "build_maven_", "check_maven_"},
	}
	reactNativeNativePrefixes = []string{
		"js/logbrew-react-native/android/", "js/logbrew-react-native/ios/", "js/logbrew-react-native/src/",
		"swift/logbrew-swift/Sources/LogBrew",
	}
	reactNativeNativeFiles = []string{
		"js/logbrew-react-native/index.native.js", "js/logbrew-react-native/index.native.d.ts",
		"js/logbrew-react-native/persistent-delivery.native.js",
		"js/logbrew-react-native/test/run-native-store-tests.sh",
	}
	publicReconciliationTests = []string{
		"tests.test_nuget_release_receipt_provenance", "tests.test_publication_run", "tests.test_python_public_pypi_smoke",
		"tests.test_release_artifact_receipt_modes", "tests.test_release_metadata",
	}
	nugetReceiptTests = []string{
		"tests.test_nuget_release_receipt_provenance", "tests.test_release_artifact_receipt_modes",
		"tests.test_release_metadata",
	}
	releaseCatalogTests = []string{"tests.test_affected_family_release_prep"}
	// Python unit test modules that a change to one of these paths selects.
	ciPathTests = map[string][]string{
		".github/workflows/ci.yml": {
			"tests.test_github_release_safety_gates", "tests.test_go_workflow_cache_path",
			"tests.test_js_installed_artifact_workflow_gates", "tests.test_release_artifact_smoke_gates",
		},
		".github/workflows/release-readiness.yml": {
			"tests.test_github_release_safety_gates", "tests.test_js_installed_artifact_workflow_gates",
		},
		".github/workflows/publish-packages.yml": {
			"tests.test_publication_run",
			"tests.test_release_metadata", "tests.test_swiftpm_public_smoke",
		},
		".github/workflows/reconcile-public-packages.yml":         publicReconciliationTests,
		"scripts/real_user_maven_central_public_smoke.sh":         {"tests.test_maven_central_public_smoke"},
		"scripts/real_user_swiftpm_public_smoke.sh":               {"tests.test_swiftpm_public_smoke"},
		"scripts/real_user_native_release_public_smoke.sh":        {"tests.test_native_release_public_smoke"},
		"scripts/check_nuget_release_receipt_provenance.py":       nugetReceiptTests,
		"scripts/check_publication_run.py":                        {"tests.test_publication_run"},
		"scripts/release_catalog.py":                              releaseCatalogTests,
		"tools/toolchain-probe/release-catalog.toml":              releaseCatalogTests,
		"scripts/real_user_node_ingest_contract_smoke.sh":         {"tests.test_default_ingest_endpoints"},
		"scripts/real_user_react_native_smoke.sh":                 {"tests.test_react_native_global_errors"},
		"scripts/real_user_react_native_bundle_smoke.sh":          {"tests.test_react_native_mobile_core"},
		"scripts/real_user_go_persistence_smoke.sh":               {"tests.test_go_persistence_smoke"},
		"scripts/real_user_dotnet_selected_public_nuget_smoke.sh": nugetReceiptTests,
	}
)

// checkCISelect prints which CI areas and Python unit test modules a change
// selects, from the given paths or from the commit range GitHub describes.
func checkCISelect(arguments []string, getenv func(string) string, git func(...string) ([]string, error),
	output, diagnostic io.Writer,
) int {
	githubOutput := false
	var paths []string
	for _, argument := range arguments {
		switch {
		case argument == "--github-output":
			githubOutput = true
		case strings.HasPrefix(argument, "-"):
			return writeText(diagnostic, "usage: ci-select [--github-output] [changed-path...]\n", exitUsage)
		default:
			paths = append(paths, argument)
		}
	}
	if len(paths) == 0 {
		changed, err := ciChangedPaths(getenv, git)
		if err != nil {
			return writeText(diagnostic, "changed paths unavailable: "+err.Error()+"\n", exitFailure)
		}
		paths = changed
	}
	report := ciSelection(paths)
	if !githubOutput {
		return writeText(output, report, exitOK)
	}
	target := getenv("GITHUB_OUTPUT")
	if target == "" {
		return writeText(diagnostic, "GITHUB_OUTPUT is required with --github-output\n", exitUsage)
	}
	file, err := os.OpenFile(target, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return writeText(diagnostic, "GITHUB_OUTPUT is not writable\n", exitFailure)
	}
	code := writeText(file, report, exitOK)
	if file.Close() != nil {
		return exitFailure
	}
	return code
}

func ciChangedPaths(getenv func(string) string, git func(...string) ([]string, error)) ([]string, error) {
	before, sha := getenv("GITHUB_EVENT_BEFORE"), getenv("GITHUB_SHA")
	if sha == "" {
		sha = "HEAD"
	}
	if base := getenv("GITHUB_BASE_REF"); getenv("GITHUB_EVENT_NAME") == "pull_request" && base != "" {
		return git("diff", "--name-only", "origin/"+base+"...HEAD")
	}
	if strings.Trim(before, "0") != "" {
		return git("diff", "--name-only", before+".."+sha)
	}
	return git("diff-tree", "--no-commit-id", "--name-only", "-r", sha)
}

func runGit(arguments ...string) ([]string, error) {
	data, err := exec.Command("git", arguments...).Output()
	if err != nil {
		return nil, err
	}
	var lines []string
	for line := range strings.Lines(string(data)) {
		if line = strings.TrimSpace(line); line != "" {
			lines = append(lines, line)
		}
	}
	return lines, nil
}

func ciSelection(paths []string) string {
	enabled := map[string]bool{}
	var normalized []string
	for _, raw := range paths {
		if path := strings.TrimPrefix(strings.TrimSpace(raw), "./"); path != "" {
			normalized = append(normalized, path)
			ciPathAreas(path, enabled)
		}
	}
	var report strings.Builder
	for _, area := range ciAreas {
		report.WriteString(area + "=" + strconv.FormatBool(enabled[area]) + "\n")
	}
	modules, runAll := ciUnitTests(normalized)
	report.WriteString("run_all=" + strconv.FormatBool(runAll) + "\n")
	report.WriteString("modules=" + strings.Join(modules, " ") + "\n")
	return report.String()
}

func ciPathAreas(path string, enabled map[string]bool) {
	if name, script := strings.CutPrefix(path, "scripts/"); script {
		enabled["release_artifacts"] = enabled["release_artifacts"] || strings.Contains(name, "release_artifact")
		for _, area := range ciSourceAreas {
			if strings.HasPrefix(name, "real_user_"+area+"_") || strings.HasPrefix(name, "check_"+area+"_") {
				enabled[area] = true
			}
		}
		for area, prefixes := range ciScriptPrefixes {
			if slices.ContainsFunc(prefixes, func(prefix string) bool { return strings.HasPrefix(name, prefix) }) {
				enabled[area] = true
			}
		}
	}
	if strings.HasPrefix(path, "tools/toolchain-probe/native_") || strings.HasPrefix(path, "tools/toolchain-probe/js_") {
		enabled["release_artifacts"] = true
	}
	if directory, _, nested := strings.Cut(path, "/"); nested && slices.Contains(ciSourceAreas, directory) {
		enabled[directory] = true
	}
	if path == "Cargo.toml" || path == "Cargo.lock" || path == "rust-toolchain.toml" {
		enabled["rust"] = true
	}
	if strings.HasPrefix(path, "js/") {
		enabled["javascript"] = true
		if strings.Contains(path, "release-artifact") || strings.Contains(path, "release_artifact") {
			enabled["release_artifacts"] = true
		}
	}
	if slices.Contains(reactNativeNativeFiles, path) ||
		slices.ContainsFunc(reactNativeNativePrefixes, func(prefix string) bool { return strings.HasPrefix(path, prefix) }) {
		enabled["javascript"], enabled["react_native_native"] = true, true
	}
	if strings.HasPrefix(path, "tools/toolchain-probe/") {
		enabled["go"] = true
	}
	if path == "Package.swift" {
		enabled["swift"] = true
	}
	if path == ".github/workflows/publish-packages.yml" {
		enabled["maven"] = true
	}
}

// ciUnitTests returns the focused modules, or runAll when a change has no
// known focused owner.
func ciUnitTests(paths []string) (modules []string, runAll bool) {
	for _, path := range paths {
		if strings.HasPrefix(path, "tests/test_") && strings.HasSuffix(path, ".py") {
			module := strings.ReplaceAll(strings.TrimSuffix(path, ".py"), "/", ".")
			if !unitTestModule.MatchString(module) {
				return nil, true
			}
			modules = append(modules, module)
			continue
		}
		if targets, known := ciPathTests[path]; known {
			modules = append(modules, targets...)
			continue
		}
		if (strings.HasPrefix(path, "tests/") && strings.HasSuffix(path, ".py")) ||
			(strings.HasPrefix(path, "scripts/") && (strings.HasSuffix(path, ".py") || strings.HasSuffix(path, ".sh"))) ||
			strings.HasPrefix(path, ".github/workflows/") {
			return nil, true
		}
	}
	if len(modules) == 0 {
		return nil, true
	}
	slices.Sort(modules)
	return slices.Compact(modules), false
}
