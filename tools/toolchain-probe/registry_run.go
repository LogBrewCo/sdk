package main

import (
	"context"
	"net/http"
	"slices"
)

type registryCheckResult struct {
	expected      []string
	family, label string
	outcome       registryOutcome
	passed        bool
}

func runRegistryChecks(ctx context.Context, client *http.Client, checks []registryPlannedCheck,
	policy registryRetryPolicy,
) ([]registryCheckResult, bool) {
	if client == nil || policy.retries < 0 || policy.delay < 0 {
		return nil, false
	}
	results := make([]registryCheckResult, 0, len(checks))
	for _, check := range checks {
		if ctx.Err() != nil {
			return results, false
		}
		outcome := registryRequestOutcome(ctx, client, check.request, check.expected, policy)
		result := registryCheckResult{
			family: check.request.family, label: check.request.label, passed: outcome.passed,
			outcome: outcome, expected: registrySortedVersions(check.expected),
		}
		results = append(results, result)
	}
	return results, ctx.Err() == nil
}

func registrySortedVersions(versions map[string]bool) []string {
	values := make([]string, 0, len(versions))
	for version := range versions {
		values = append(values, version)
	}
	slices.Sort(values)
	return values
}

func registryResultsPassed(results []registryCheckResult) bool {
	for _, result := range results {
		if !result.passed {
			return false
		}
	}
	return true
}
