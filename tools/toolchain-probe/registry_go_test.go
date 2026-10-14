package main

import (
	"context"
	"reflect"
	"strings"
	"testing"
)

const registryGoFixtureDirectory = "consumer"

func TestRegistryGoCommands(t *testing.T) {
	t.Parallel()
	for _, version := range []string{"0.3.8", "v0.3.8"} {
		calls := make([][]string, 0)
		runner := func(_ context.Context, directory string, args []string) bool {
			if directory != registryGoFixtureDirectory {
				t.Fatal("command escaped consumer directory")
			}
			calls = append(calls, args)
			return true
		}
		if !executeRegistryGo(context.Background(), registryGoFixtureDirectory, version, runner) {
			t.Fatal("Go consumer rejected")
		}
		expected := [][]string{{"mod", "init", registryGoConsumerModule}, {"get", goMetadataModule + "@v0.3.8"}}
		if !reflect.DeepEqual(calls, expected) {
			t.Fatalf("commands = %v", calls)
		}
	}
}

func TestRegistryGoFailureStops(t *testing.T) {
	t.Parallel()
	calls := 0
	runner := func(_ context.Context, _ string, _ []string) bool { calls++; return false }
	passed := executeRegistryGo(context.Background(), registryGoFixtureDirectory, registryDefaultVersion, runner)
	if passed || calls != 1 {
		t.Fatal("failed init did not stop get")
	}
	ctx, cancel := context.WithCancel(context.Background())
	calls = 0
	runner = func(_ context.Context, _ string, _ []string) bool { calls++; cancel(); return true }
	if executeRegistryGo(ctx, registryGoFixtureDirectory, registryDefaultVersion, runner) || calls != 1 {
		t.Fatal("cancellation did not stop get")
	}
	if executeRegistryGo(context.Background(), t.TempDir(), registryDefaultVersion, nil) {
		t.Fatal("nil runner accepted")
	}
}

func TestRegistryGoTarget(t *testing.T) {
	t.Parallel()
	options := assembleRegistryOptions(parseRegistryArguments([]string{"--target=go"}))
	if options == nil || !registryNeedsGo(options) {
		t.Fatal("explicit Go target ignored")
	}
	options = assembleRegistryOptions(parseRegistryArguments(strings.Fields(`--target=npm --include-go`)))
	if options == nil || registryNeedsGo(options) {
		t.Fatal("include Go expanded explicit npm target")
	}
	options = assembleRegistryOptions(parseRegistryArguments([]string{"--include-go"}))
	if options == nil || !registryNeedsGo(options) {
		t.Fatal("include Go ignored for all target")
	}
}
