package main

import (
	"context"
	"testing"
	"time"
)

func TestPythonPublicRuntimePairOverlapsAndJoins(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	entered := make(chan pythonRuntimeMode, 2)
	release := make(chan struct{})
	finished := make(chan pythonConsumerOutput, 1)
	go func() {
		finished <- runPythonRuntimePair(ctx, func(ctx context.Context, mode pythonRuntimeMode) pythonConsumerOutput {
			entered <- mode
			select {
			case <-release:
				return pythonConsumerOutput{stdout: nil, stderr: nil, valid: true}
			case <-ctx.Done():
				return pythonConsumerOutput{stdout: nil, stderr: nil, valid: false}
			}
		})
	}()
	seen := make(map[pythonRuntimeMode]bool)
	for range 2 {
		select {
		case mode := <-entered:
			seen[mode] = true
		case <-ctx.Done():
			t.Fatal("normal and optimized processes did not overlap")
		}
	}
	close(release)
	result := <-finished
	if len(seen) != 2 || !result.valid {
		t.Fatal("both distinct runtime modes must finish before returning")
	}
}

func TestPythonPublicRuntimePairCancelsAndJoinsFailure(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	stopped := false
	result := runPythonRuntimePair(ctx, func(ctx context.Context, mode pythonRuntimeMode) pythonConsumerOutput {
		if mode == pythonRuntimeNormal {
			<-ctx.Done()
			stopped = true
			return pythonConsumerOutput{stdout: nil, stderr: []byte("cancelled sibling"), valid: false}
		}
		return pythonConsumerOutput{stdout: nil, stderr: []byte("original runtime failure"), valid: false}
	})
	if ctx.Err() != nil || !stopped || result.valid || string(result.stderr) != "original runtime failure" {
		t.Fatal("failed process must cancel and join its sibling without waiting for the outer deadline")
	}
}
