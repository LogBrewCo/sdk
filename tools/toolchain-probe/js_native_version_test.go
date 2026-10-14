package main

import (
	"context"
	"os"
	"os/exec"
	"testing"
)

func TestJSNativeVersionRejectsInvalidExecutable(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if jsNativeVersion(ctx, "missing-oxlint-fixture") ||
		jsNativeVersion(t.Context(), "missing-oxlint-fixture") {
		t.Fatal("missing or cancelled parser accepted")
	}
	executable, err := os.Executable()
	if err != nil || jsNativeVersion(t.Context(), executable) {
		t.Fatal("unrelated executable accepted as pinned parser")
	}
}

func TestJSNativeVersionInstalled(t *testing.T) {
	t.Parallel()
	if os.Getenv("LOGBREW_TEST_OXLINT") != "1" {
		t.Skip("version integration requires native parser enablement")
	}
	executable, err := exec.LookPath("oxlint")
	if err != nil || !jsNativeVersion(t.Context(), executable) {
		t.Fatal("installed native parser does not match exact version")
	}
}
