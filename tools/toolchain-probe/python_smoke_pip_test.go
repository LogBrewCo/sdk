package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

const (
	pipMismatchFixture = "pip-mismatch"
	pipIsolationChecks = 9
	pipCheckFixture    = "check"
)

func TestPythonPipFixtureDoesNotEchoAmbientValues(t *testing.T) {
	t.Parallel()
	const marker = "private-fixture-value"
	result := runPythonConsumerEnvironment(t.Context(), os.Args[0], t.TempDir(),
		[]string{pythonIsolatedFlag, pipCheckFixture}, []string{"LOGBREW_TEST_VALUE=" + marker})
	if !result.valid || bytes.Contains(result.stdout, []byte(marker)) || bytes.Contains(result.stderr, []byte(marker)) {
		t.Fatal("installer fixture echoed a private environment value")
	}
}

func runPythonPipFixture() int {
	if os.Args[1] == versionFlag {
		return writeText(os.Stdout, "uv 0.12.9 (fixture)\n", exitOK)
	}
	if len(os.Args) == 3 && os.Args[2] == versionFlag {
		version := "26.2.1"
		if filepath.Base(os.Args[0]) == pipMismatchFixture {
			version = "25.1.1"
		}
		return writeText(os.Stdout, "pip "+version+" from /fixture (python 3.13)\n", exitOK)
	}
	environment := make(map[string]bool)
	for name, expected := range map[string]string{
		"PYTHONNOUSERSITE": "1", "PYTHONSAFEPATH": "1", "PYTHONDONTWRITEBYTECODE": "1",
		"PIP_CONFIG_FILE": os.DevNull, "UV_CONCURRENT_DOWNLOADS": "8", "UV_HTTP_TIMEOUT": "5", "UV_HTTP_RETRIES": "0",
		"PIP_INDEX_URL": "", "PYTHONPATH": "",
	} {
		environment[name] = os.Getenv(name) == expected
	}
	data := map[string]any{"arguments": os.Args[1:], "environment": environment}
	if err := json.NewEncoder(os.Stdout).Encode(data); err != nil {
		return exitFailure
	}
	return exitOK
}

func TestPythonPublicSmokePipTargetAndIsolation(t *testing.T) {
	t.Setenv("PIP_INDEX_URL", "https://invalid.example.test/simple")
	t.Setenv("PYTHONPATH", "/untrusted-fixture")
	t.Setenv("UV_CONCURRENT_DOWNLOADS", "99")
	var run pythonSmokeRun
	run.directory, run.pip, run.python = t.TempDir(), os.Args[0], "/fixture/venv/bin/python"
	result := run.callPip(t.Context(), []string{pipCheckFixture})
	var receipt struct {
		Environment map[string]bool `json:"environment"`
		Arguments   []string        `json:"arguments"`
	}
	if !result.valid || json.Unmarshal(result.stdout, &receipt) != nil ||
		!slices.Equal(receipt.Arguments, []string{"--isolated", "--python", run.python, pipCheckFixture}) {
		t.Fatal("pip did not receive the exact isolated target and operation")
	}
	if len(receipt.Environment) != pipIsolationChecks {
		t.Fatal("target pip omitted an isolation check")
	}
	for name, valid := range receipt.Environment {
		if !valid {
			t.Errorf("target pip lost its isolation setting: %s", name)
		}
	}
}

func TestPythonPublicSmokeRejectsPipVersionMismatch(t *testing.T) {
	t.Parallel()
	var run pythonSmokeRun
	run.directory, run.uv, run.pip = t.TempDir(), os.Args[0], os.Args[0]
	if !run.verifyInstallerVersions(t.Context()) {
		t.Fatal("pinned installers were rejected")
	}
	run.pip = filepath.Join(run.directory, pipMismatchFixture)
	if err := os.Symlink(os.Args[0], run.pip); err != nil {
		t.Fatal(err)
	}
	if run.verifyInstallerVersions(t.Context()) {
		t.Fatal("an unpinned pip controller was accepted")
	}
	run.pip = filepath.Join(run.directory, "missing-pip")
	if run.verifyInstallerVersions(t.Context()) {
		t.Fatal("an unavailable pip controller was accepted")
	}
}
