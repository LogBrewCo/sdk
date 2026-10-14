package main

import (
	"reflect"
	"testing"
)

func TestRegistryParseOverrides(t *testing.T) {
	t.Parallel()
	raw := []string{" @logbrew/node = v1.2.3+build ", "co.logbrew.unity=0.2.2"}
	names, versions, valid := registryParseOverrides(registryNPMFamily, raw)
	if !valid || !reflect.DeepEqual(names, []string{jsMetadataScope + "node", registryUnityPackage}) ||
		versions[jsMetadataScope+"node"] != "v1.2.3+build" {
		t.Fatalf("overrides = %v %v %v", names, versions, valid)
	}
	for _, entry := range []string{"", "@logbrew/sdk", "=1", "@logbrew/sdk= ", "@logbrew/prisma=1", "../package=1"} {
		if _, _, valid = registryParseOverrides(registryNPMFamily, []string{entry}); valid {
			t.Fatalf("accepted %q", entry)
		}
	}
	if _, _, valid = registryParseOverrides(registryNPMFamily, []string{"@logbrew/sdk=1", " @logbrew/sdk =2"}); valid {
		t.Fatal("duplicate override accepted")
	}
	if _, _, valid = registryParseOverrides(fixtureUnknown, nil); valid {
		t.Fatal("unknown family accepted")
	}
	if _, _, valid = registryParseOverrides(mavenMetadataFamily, []string{"co.logbrew:logbrew-kotlin=1=2"}); !valid {
		t.Fatal("parser changed predecessor first-equals semantics")
	}
	for _, family := range []string{registryNPMFamily, registryPythonFamily, nugetJobName, mavenMetadataFamily} {
		if _, _, valid = registryParseOverrides(family, nil); !valid {
			t.Fatalf("empty %s override rejected", family)
		}
	}
}
