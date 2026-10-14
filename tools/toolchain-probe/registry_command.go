package main

import (
	"context"
	"io"
	"net/http"
	"time"
)

const (
	registryCommand        = "registry-publication"
	registryCommandTimeout = 30 * time.Minute
)

func runRegistryPublication(arguments []string, output, diagnostic io.Writer) int {
	options := prepareRegistryOptions(arguments)
	if options == nil {
		return writeText(diagnostic, "invalid registry publication arguments\n", exitUsage)
	}
	client := newRegistryClient(options.numeric.timeout)
	if client == nil {
		return writeText(diagnostic, "registry client unavailable\n", exitFailure)
	}
	defer client.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), registryCommandTimeout)
	defer cancel()
	return executeRegistryPublication(ctx, client, options, verifyRegistryGo, output)
}

func executeRegistryPublication(ctx context.Context, client *http.Client, options *registryOptions,
	goVerifier func(context.Context, string) bool, output io.Writer,
) int {
	checks, valid := registryPlanChecks(options.selection, options.versions)
	if !valid {
		return exitUsage
	}
	results, complete := runRegistryChecks(ctx, client, checks, options.numeric.retry)
	expected := len(checks)
	if registryNeedsGo(options) {
		expected++
		if ctx.Err() == nil && goVerifier != nil {
			passed := goVerifier(ctx, options.versions.version)
			results = append(results, registryCheckResult{
				family: areaGo, label: goMetadataModule, passed: passed,
				expected: []string{registryGoVersion(options.versions.version)},
				outcome: registryOutcome{
					reason: "go-consumer", status: 0, attempts: 1, passed: passed,
				},
			})
		} else {
			complete = false
		}
	}
	return writeRegistryReceipt(output, results, expected, complete && ctx.Err() == nil)
}
