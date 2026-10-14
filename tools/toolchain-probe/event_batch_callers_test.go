package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func nativeCallerScripts(tb testing.TB) []string {
	tb.Helper()
	paths, err := filepath.Glob("../../scripts/*.sh")
	if err != nil {
		tb.Fatal(err)
	}
	var callers []string
	for _, path := range paths {
		data, readable := readCheckFile(path)
		if !readable {
			tb.Fatal("native caller is unreadable")
		}
		source := string(data)
		invocation := strings.Index(source, "run_native_verifier ")
		if invocation < 0 {
			continue
		}
		launcher := strings.Index(source, `source "$repo_root/scripts/native_verifier.sh"`)
		if launcher < 0 || launcher > invocation {
			tb.Fatalf("native caller does not load its launcher before use: %s", path)
		}
		callers = append(callers, "scripts/"+filepath.Base(path))
	}
	if len(callers) == 0 {
		tb.Fatal("native caller inventory is incomplete")
	}
	return callers
}

func nativeWorkflowJobs(source string) []string {
	var jobs []string
	start := -1
	lines := strings.Split(source, "\n")
	for index, line := range lines {
		if strings.HasPrefix(line, "  ") && !strings.HasPrefix(line, "   ") && strings.HasSuffix(line, ":") {
			if start >= 0 {
				jobs = append(jobs, strings.Join(lines[start:index], "\n"))
			}
			start = index
		}
	}
	if start >= 0 {
		jobs = append(jobs, strings.Join(lines[start:], "\n"))
	}
	return jobs
}

func TestNativeValidatorCallerProvisioning(t *testing.T) {
	t.Parallel()
	callers := nativeCallerScripts(t)
	for _, name := range []string{"ci.yml", "publish-packages.yml", "release-readiness.yml"} {
		data, readable := readCheckFile("../../.github/workflows/" + name)
		if !readable {
			t.Fatal("native workflow is unreadable")
		}
		for _, job := range nativeWorkflowJobs(string(data)) {
			first := nativeWorkflowFirstCaller(job, callers)
			if first < 0 {
				continue
			}
			action := strings.Index(job, "uses: ./tools/toolchain-probe")
			protectedAction := strings.Index(job, "uses: ./.release-control/tools/toolchain-probe")
			if action < 0 && protectedAction < 0 || action > first || protectedAction > first {
				t.Fatalf("native workflow caller lacks prior bootstrap in %s: %s", name, strings.Split(job, "\n")[0])
			}
		}
	}
}

func nativeWorkflowFirstCaller(job string, callers []string) int {
	first := strings.Index(job, "event-batch-check ")
	for _, caller := range callers {
		if index := strings.Index(job, "bash "+caller); index >= 0 && (first < 0 || index < first) {
			first = index
		}
	}
	return first
}

func TestNativeValidatorPreservesProtectedSwiftControl(t *testing.T) {
	t.Parallel()
	data, err := os.ReadFile("../../.github/workflows/publish-packages.yml")
	if err != nil {
		t.Fatal(err)
	}
	for _, job := range nativeWorkflowJobs(string(data)) {
		const protectedCaller = `bash "$GITHUB_WORKSPACE/.release-control/scripts/real_user_swiftpm_public_smoke.sh"`
		if !strings.Contains(job, protectedCaller) {
			continue
		}
		for _, required := range []string{
			"ref: ${{ github.workflow_sha }}", "persist-credentials: false",
			"scripts/native_verifier.sh", "tools/toolchain-probe/action.yml",
			"spec/event-batch.schema.json", "uses: ./.release-control/tools/toolchain-probe",
			`git -C "$control_root" diff --quiet HEAD`,
		} {
			if !strings.Contains(job, required) {
				t.Fatalf("protected Swift control lost %s", required)
			}
		}
		return
	}
	t.Fatal("protected Swift verifier caller is missing")
}
