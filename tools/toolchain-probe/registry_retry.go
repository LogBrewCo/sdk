package main

import (
	"context"
	"net/http"
	"time"
)

type registryRetryPolicy struct {
	retries int
	delay   time.Duration
	absent  bool
}

func verifyRegistryRequest(ctx context.Context, client *http.Client, plan registryRequest,
	expected map[string]bool, policy registryRetryPolicy,
) bool {
	return registryRequestOutcome(ctx, client, plan, expected, policy).passed
}

type registryOutcome struct {
	reason           string
	status, attempts int
	passed           bool
}

func registryRequestOutcome(ctx context.Context, client *http.Client, plan registryRequest,
	expected map[string]bool, policy registryRetryPolicy,
) registryOutcome {
	outcome := registryOutcome{reason: "invalid-policy", status: 0, attempts: 0, passed: false}
	if policy.retries < 0 || policy.delay < 0 || len(expected) == 0 {
		return outcome
	}
	for attempt := 0; ; attempt++ {
		if ctx.Err() != nil {
			outcome.reason = "cancelled"
			return outcome
		}
		result := fetchRegistryResponse(ctx, client, plan)
		outcome.reason, outcome.status, outcome.attempts = result.reason, result.status, attempt+1
		if policy.absent {
			outcome.passed = registryAbsentResult(result.status, result.readable, result.versions, expected)
			return outcome
		}
		if result.readable && registryVersionsIntersect(result.versions, expected) {
			outcome.passed = true
			return outcome
		}
		outcome.reason = registryMismatchReason(result)
		if attempt >= policy.retries {
			return outcome
		}
		if !waitRegistryRetry(ctx, policy.delay) {
			outcome.reason = "cancelled"
			return outcome
		}
	}
}

func waitRegistryRetry(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return ctx.Err() == nil
	}
}

func registryMismatchReason(result registryResponse) string {
	if result.readable {
		return "version-not-found"
	}
	return result.reason
}
