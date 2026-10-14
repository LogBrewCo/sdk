package main

import (
	"reflect"
	"testing"
)

func TestRegistryArguments(t *testing.T) {
	const targetFlag = "--target"
	t.Parallel()
	args := parseRegistryArguments([]string{
		targetFlag, registryNPMFamily, "--target=pypi",
		"--npm-version", "@logbrew/sdk=1.2.9", "--include-unity-npm",
	})
	if args == nil || !reflect.DeepEqual(args.values["target"], []string{registryNPMFamily, registryPythonFamily}) ||
		!args.switches["include-unity-npm"] || args.values["npm-version"][0] != "@logbrew/sdk=1.2.9" {
		t.Fatal("typed arguments lost value or order")
	}
	for _, raw := range [][]string{
		{"--registry-unknown"},
		{"target", registryNPMFamily},
		{targetFlag},
		{"--target="},
		{targetFlag, "--expect-absent"},
		{"--expect-absent=true"},
		{"--timeout", ""},
		{"--"},
	} {
		if parseRegistryArguments(raw) != nil {
			t.Fatalf("accepted malformed arguments %v", raw)
		}
	}
	if parseRegistryArguments(nil) == nil {
		t.Fatal("empty arguments rejected before defaults")
	}
}
