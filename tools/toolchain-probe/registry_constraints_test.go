package main

import (
	"strings"
	"testing"
)

func TestRegistryOptionConstraints(t *testing.T) {
	t.Parallel()
	for _, args := range [][]string{
		nil,
		strings.Fields(`--target=nuget --expect-absent`),
		strings.Fields(`--target=maven --expect-absent --maven-plan=/tmp/plan.json --maven-plan-scope=selected`),
		strings.Fields(`--target=maven --maven-plan=/tmp/plan.json --maven-plan-scope=dependencies`),
	} {
		if !registryOptionsValid(assembleRegistryOptions(parseRegistryArguments(args))) {
			t.Fatalf("rejected %v", args)
		}
	}
	for _, args := range [][]string{
		strings.Fields(`--target=pypi --npm-package=@logbrew/sdk`),
		strings.Fields(`--target=pypi --require-npm-provenance`),
		strings.Fields(`--target=npm --pypi-version=logbrew-sdk=1`),
		strings.Fields(`--target=npm --nuget-version=LogBrew=1`),
		strings.Fields(`--target=npm --maven-artifact=logbrew-kotlin`),
		strings.Fields(`--target=all --expect-absent`),
		strings.Fields(`--target=nuget --target=nuget --expect-absent`),
		strings.Fields(`--target=maven --expect-absent`),
		strings.Fields(`--target=maven --maven-plan=/tmp/plan.json`),
		strings.Fields(`--target=maven --maven-plan-scope=selected`),
		strings.Fields(`--target=maven --maven-plan=/tmp/plan.json --maven-plan-scope=invalid`),
		strings.Fields(`--target=maven --maven-plan=/tmp/plan.json --maven-plan-scope=selected ` +
			`--maven-artifact=logbrew-kotlin`),
		strings.Fields(`--target=all --require-released-package-set`),
	} {
		if registryOptionsValid(assembleRegistryOptions(parseRegistryArguments(args))) {
			t.Fatalf("accepted %v", args)
		}
	}
	if registryOptionsValid(nil) {
		t.Fatal("nil options accepted")
	}
}
