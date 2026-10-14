package main

import (
	"context"
	"os"
	"os/exec"
	"strings"
)

const (
	registryGoGet = "get"
	registryGoMod = "mod"
)

func registryGoProcess(ctx context.Context, directory string, arguments []string) bool {
	if !registryGoCommandValid(arguments) || ctx.Err() != nil {
		return false
	}
	executable, err := exec.LookPath(areaGo)
	if err != nil {
		return false
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	output := &boundedOutput{cancel: cancel, data: nil, limited: false, limit: outputLimit}
	//nolint:gosec // G204: exact mod-init/get verbs and fixed module prefix validated below; no shell.
	command := exec.CommandContext(ctx, executable, arguments...)
	command.Dir = directory
	command.Stdout, command.Stderr = output, output
	return runManagedProcess(command) == nil && ctx.Err() == nil && !output.limited
}

func registryGoCommandValid(arguments []string) bool {
	if len(arguments) == 3 && arguments[0] == registryGoMod && arguments[1] == registryGoInit &&
		arguments[2] == registryGoConsumerModule {
		return true
	}
	return len(arguments) == registryArgumentPairWidth && arguments[0] == registryGoGet &&
		strings.HasPrefix(arguments[1], goMetadataModule+"@v") && len(arguments[1]) > len(goMetadataModule+"@v")
}

func verifyRegistryGo(ctx context.Context, version string) bool {
	directory, err := os.MkdirTemp("", "logbrew-go-registry-")
	if err != nil {
		return false
	}
	passed := executeRegistryGo(ctx, directory, version, registryGoProcess)
	removalError := os.RemoveAll(directory)
	return passed && removalError == nil
}
