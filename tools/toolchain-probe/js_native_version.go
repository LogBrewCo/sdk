package main

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

const (
	jsOxlintVersion  = "Version: 1.86.0"
	jsVersionTimeout = 5 * time.Second
)

func jsNativeVersion(ctx context.Context, executable string) bool {
	ctx, cancel := context.WithTimeout(ctx, jsVersionTimeout)
	defer cancel()
	output := &boundedOutput{cancel: cancel, data: nil, limited: false, limit: outputLimit}
	//nolint:gosec // G204: resolved native executable and fixed version flag; no shell.
	command := exec.CommandContext(ctx, executable, "--version")
	command.Stdout, command.Stderr = output, output
	return runManagedProcess(command) == nil && ctx.Err() == nil && !output.limited &&
		strings.TrimSpace(string(output.data)) == jsOxlintVersion
}
