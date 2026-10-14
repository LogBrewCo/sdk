package main

import (
	"testing"
	"time"
)

func TestRegistryNumericArguments(t *testing.T) {
	t.Parallel()
	options := registryNumericArguments(parseRegistryArguments(nil))
	if options == nil || options.timeout != registryDefaultTimeout || options.retry.retries != registryDefaultRetries ||
		options.retry.delay != registryDefaultRetryDelay {
		t.Fatal("numeric defaults changed")
	}
	options = registryNumericArguments(parseRegistryArguments([]string{
		"--timeout=0.25", "--retry-delay=0",
		"--retries=0", "--expect-absent", "--timeout=0.5",
	}))
	if options == nil || options.timeout != time.Second/2 || options.retry.delay != 0 ||
		options.retry.retries != 0 || !options.retry.absent {
		t.Fatal("numeric overrides changed")
	}
	for _, args := range [][]string{
		{"--timeout=NaN"},
		{"--timeout=Inf"},
		{"--timeout=0"},
		{"--timeout=-1"},
		{"--timeout=1e100"},
		{"--timeout=0.00000000001"},
		{"--retry-delay=-1"},
		{"--retry-delay=NaN"},
		{"--retries=-1"},
		{"--retries=1.5"},
		{"--retries=9999999999999999999999999999999"},
	} {
		if registryNumericArguments(parseRegistryArguments(args)) != nil {
			t.Fatalf("accepted %v", args)
		}
	}
	if registryNumericArguments(nil) != nil {
		t.Fatal("nil arguments accepted")
	}
}
