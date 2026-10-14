//go:build darwin || linux

package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	nativeLauncherDirectoryMode = 0o700
	nativeLauncherFileMode      = 0o600
	nativeLauncherFailure       = 7
	nativeLauncherPin           = ".go-version"
	nativeLauncherProvided      = "provided"
	nativeLauncherModule        = "tools/toolchain-probe"
)

const nativeLauncherGo = `#!/bin/sh
printf '%s\n' "$*" >> "$NATIVE_TEST_CALLS"
test "$GOENV:$GOWORK:$GOTOOLCHAIN:$GOFLAGS:$GOPROXY:$GOSUMDB" = 'off:off:local:-mod=readonly:off:off' || exit 9
if [ "$1" = version ]; then
  printf 'go version go%s fixture\n' "$NATIVE_TEST_VERSION"
  exit 0
fi
test "$#" = 3 && test "$1:$2:$3" = 'run:.:clock' || exit 10
test "$PWD" = "$NATIVE_TEST_ROOT/tools/toolchain-probe" || exit 11
printf 'local-clock\n'
`

type nativeLauncherFixture struct {
	root    string
	version string
}

type nativeLauncherResult struct {
	err        error
	output     string
	diagnostic string
}

func writeNativeLauncherFile(t *testing.T, directory, name, data string, mode os.FileMode) {
	t.Helper()
	root, err := os.OpenRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := root.Close(); err != nil {
			t.Error(err)
		}
	}()
	if err := root.MkdirAll(filepath.Dir(name), nativeLauncherDirectoryMode); err != nil {
		t.Fatal(err)
	}
	if err := root.WriteFile(name, []byte(data), mode); err != nil {
		t.Fatal(err)
	}
}

func newNativeLauncherFixture(t *testing.T) nativeLauncherFixture {
	t.Helper()
	root := t.TempDir()
	launcher, err := os.ReadFile("../../scripts/native_verifier.sh")
	if err != nil {
		t.Fatal(err)
	}
	pin, err := os.ReadFile(nativeLauncherPin)
	if err != nil {
		t.Fatal(err)
	}
	writeNativeLauncherFile(t, root, "scripts/native_verifier.sh", string(launcher), nativeLauncherFileMode)
	writeNativeLauncherFile(t, root, filepath.Join(nativeLauncherModule, nativeLauncherPin),
		string(pin), nativeLauncherFileMode)
	for _, name := range []string{"go.mod", "go.sum"} {
		writeNativeLauncherFile(t, root, filepath.Join(nativeLauncherModule, name),
			"fixture\n", nativeLauncherFileMode)
	}
	writeNativeLauncherFile(t, root, "bin/go", nativeLauncherGo, nativeLauncherDirectoryMode)
	return nativeLauncherFixture{root: root, version: strings.TrimSpace(string(pin))}
}

func runNativeLauncher(t *testing.T, fixture nativeLauncherFixture, binary string) nativeLauncherResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "/bin/bash", "-c",
		`repo_root="$NATIVE_TEST_ROOT"; source "$repo_root/scripts/native_verifier.sh"; run_native_verifier clock`)
	command.Env = []string{
		"PATH=" + filepath.Join(fixture.root, "bin") + ":/usr/bin:/bin",
		"LOGBREW_TOOLCHAIN_PROBE_BIN=" + binary,
		"NATIVE_TEST_ROOT=" + fixture.root,
		"NATIVE_TEST_VERSION=" + fixture.version,
		"NATIVE_TEST_CALLS=" + filepath.Join(fixture.root, "calls"),
		"GOENV=unexpected", "GOWORK=unexpected", "GOTOOLCHAIN=auto",
		"GOFLAGS=-mod=mod", "GOPROXY=https://example.invalid", "GOSUMDB=unexpected",
	}
	var output, diagnostic bytes.Buffer
	command.Stdout, command.Stderr = &output, &diagnostic
	stop, err := configureProcess(command)
	if err != nil {
		t.Fatal(err)
	}
	command.Cancel, command.WaitDelay = stop, pipeWait
	err = command.Run()
	if stopError := stop(); stopError != nil && !errors.Is(stopError, os.ErrProcessDone) {
		t.Fatal(stopError)
	}
	return nativeLauncherResult{err: err, output: output.String(), diagnostic: diagnostic.String()}
}

func requireNativeLauncherCalls(t *testing.T, fixture nativeLauncherFixture, expected string) {
	t.Helper()
	calls, err := os.ReadFile(filepath.Join(fixture.root, "calls"))
	if expected == "" && errors.Is(err, os.ErrNotExist) {
		return
	}
	if err != nil || string(calls) != expected {
		t.Fatalf("compiler calls = %q, error = %v; expected %q", calls, err, expected)
	}
}

func TestNativeLauncherUsesPinnedOfflineCompiler(t *testing.T) {
	t.Parallel()
	fixture := newNativeLauncherFixture(t)
	result := runNativeLauncher(t, fixture, "")
	if result.err != nil || result.output != "local-clock\n" || result.diagnostic != "" {
		t.Fatalf("local execution: %+v", result)
	}
	requireNativeLauncherCalls(t, fixture, "version\nrun . clock\n")
}

func TestNativeLauncherUsesProvidedBinary(t *testing.T) {
	t.Parallel()
	fixture := newNativeLauncherFixture(t)
	binary := filepath.Join(fixture.root, nativeLauncherProvided)
	writeNativeLauncherFile(t, fixture.root, nativeLauncherProvided,
		"#!/bin/sh\nprintf 'provided:%s\\n' \"$*\"\nexit 7\n",
		nativeLauncherDirectoryMode)
	result := runNativeLauncher(t, fixture, binary)
	var exitError *exec.ExitError
	if !errors.As(result.err, &exitError) || exitError.ExitCode() != nativeLauncherFailure ||
		result.output != "provided:clock\n" || result.diagnostic != "" {
		t.Fatalf("provided binary result: %+v", result)
	}
	requireNativeLauncherCalls(t, fixture, "")
}

func TestNativeLauncherRejectsInvalidBinary(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{
		"relative-path", "missing-binary", "directory-binary", "linked-binary", "non-executable",
	} {
		t.Run(kind, func(t *testing.T) {
			t.Parallel()
			fixture := newNativeLauncherFixture(t)
			binary := invalidNativeLauncherBinary(t, fixture.root, kind)
			result := runNativeLauncher(t, fixture, binary)
			if result.err == nil || result.output != "" ||
				result.diagnostic != "native SDK verifier path is invalid\n" {
				t.Fatalf("invalid binary accepted: %+v", result)
			}
			requireNativeLauncherCalls(t, fixture, "")
		})
	}
}

func invalidNativeLauncherBinary(t *testing.T, root, kind string) string {
	t.Helper()
	file := filepath.Join(root, nativeLauncherProvided)
	switch kind {
	case "relative-path":
		return "./provided"
	case "directory-binary":
		return root
	case "linked-binary":
		if err := os.Symlink(filepath.Join(root, "bin", "go"), file); err != nil {
			t.Fatal(err)
		}
	case "non-executable":
		writeNativeLauncherFile(t, root, nativeLauncherProvided, "#!/bin/sh\nexit 0\n", nativeLauncherFileMode)
	case "missing-binary":
	default:
		t.Fatal("unknown invalid binary fixture")
	}
	return file
}

func TestNativeLauncherRejectsUnavailableSource(t *testing.T) {
	t.Parallel()
	for _, name := range []string{nativeLauncherPin, "go.mod"} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			fixture := newNativeLauncherFixture(t)
			if err := os.Remove(filepath.Join(fixture.root, nativeLauncherModule, name)); err != nil {
				t.Fatal(err)
			}
			result := runNativeLauncher(t, fixture, "")
			if result.err == nil || result.output != "" ||
				result.diagnostic != "native SDK verifier source is incomplete\n" {
				t.Fatalf("missing source accepted: %+v", result)
			}
			requireNativeLauncherCalls(t, fixture, "")
		})
	}
}

func TestNativeLauncherAllowsModuleWithoutDependencies(t *testing.T) {
	t.Parallel()
	fixture := newNativeLauncherFixture(t)
	if err := os.Remove(filepath.Join(fixture.root, nativeLauncherModule, "go.sum")); err != nil {
		t.Fatal(err)
	}
	result := runNativeLauncher(t, fixture, "")
	if result.err != nil || result.output != "local-clock\n" || result.diagnostic != "" {
		t.Fatalf("standard-library module rejected: %+v", result)
	}
	requireNativeLauncherCalls(t, fixture, "version\nrun . clock\n")
}

func TestNativeLauncherRejectsCompilerMismatch(t *testing.T) {
	t.Parallel()
	fixture := newNativeLauncherFixture(t)
	expected := fixture.version
	fixture.version = "0.0.0"
	result := runNativeLauncher(t, fixture, "")
	if result.err == nil || result.output != "" ||
		result.diagnostic != "native SDK verifier requires Go "+expected+"\n" {
		t.Fatalf("compiler mismatch accepted: %+v", result)
	}
	requireNativeLauncherCalls(t, fixture, "version\n")
}

func TestNativeLauncherRejectsMalformedPin(t *testing.T) {
	t.Parallel()
	fixture := newNativeLauncherFixture(t)
	writeNativeLauncherFile(t, fixture.root, filepath.Join(nativeLauncherModule, nativeLauncherPin),
		"1.27.1 auto\n", nativeLauncherFileMode)
	result := runNativeLauncher(t, fixture, "")
	if result.err == nil || result.output != "" ||
		result.diagnostic != "native SDK verifier compiler pin is invalid\n" {
		t.Fatalf("malformed pin accepted: %+v", result)
	}
	requireNativeLauncherCalls(t, fixture, "")
}
