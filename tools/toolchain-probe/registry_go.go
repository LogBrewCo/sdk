package main

import (
	"context"
	"slices"
	"strings"
)

const registryGoConsumerModule = "logbrew.registry.verify"

type registryGoRunner func(context.Context, string, []string) bool

func registryNeedsGo(options *registryOptions) bool {
	return slices.Contains(options.selection.targets, areaGo) ||
		(options.includeGo && slices.Contains(options.selection.targets, releaseMetadataAll))
}

func registryGoVersion(version string) string {
	return "v" + strings.TrimPrefix(version, "v")
}

func executeRegistryGo(ctx context.Context, directory, version string, runner registryGoRunner) bool {
	if runner == nil || directory == "" || version == "" || ctx.Err() != nil {
		return false
	}
	if !runner(ctx, directory, []string{"mod", "init", registryGoConsumerModule}) {
		return false
	}
	if ctx.Err() != nil {
		return false
	}
	return runner(ctx, directory, []string{"get", goMetadataModule + "@" + registryGoVersion(version)})
}
