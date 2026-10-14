package main

import (
	"context"
	"os/exec"
	"path/filepath"
	"time"
)

const jsSyntaxTimeout = 30 * time.Second

func jsSyntaxProcess(directory string, names []string) bool {
	executable, err := exec.LookPath("oxlint")
	if err != nil {
		return jsSyntaxBootstrapProcess(directory, names)
	}
	return jsSyntaxProcessWithExecutable(directory, names, executable)
}

func jsSyntaxProcessWithExecutable(directory string, names []string, executable string) bool {
	if len(names) == 0 || len(names) > markdownFileLimit {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), jsSyntaxTimeout)
	defer cancel()
	if !jsNativeVersion(ctx, executable) {
		return false
	}
	output := &boundedOutput{cancel: cancel, data: nil, limited: false, limit: outputLimit}
	fixed := []string{
		"--config", filepath.Join(directory, "tools", "toolchain-probe", "js_syntax.json"),
		"--threads", "2", "--deny-warnings", "--no-ignore", "--disable-nested-config", "--",
	}
	arguments := make([]string, 0, len(fixed)+len(names))
	arguments = append(arguments, fixed...)
	arguments = append(arguments, names...)
	//nolint:gosec // G204: native parser, fixed flags and root-confined inventoried paths; no shell.
	command := exec.CommandContext(ctx, executable, arguments...)
	command.Dir = directory
	command.Stdout, command.Stderr = output, output
	return runManagedProcess(command) == nil && ctx.Err() == nil && !output.limited
}
