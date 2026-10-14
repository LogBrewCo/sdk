package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestRegistryPackageCatalog(t *testing.T) {
	t.Parallel()
	cases := map[string][]string{
		registryNPMFamily: strings.Fields(`@logbrew/amqplib @logbrew/angular @logbrew/aws-sqs @logbrew/browser
			@logbrew/bullmq @logbrew/express @logbrew/fastify @logbrew/kafkajs @logbrew/nestjs
			@logbrew/next @logbrew/node @logbrew/react @logbrew/react-native @logbrew/sdk
			@logbrew/svelte @logbrew/vue`),
		registryPythonFamily: {pythonCoreID}, registryRubyFamily: {pythonCoreID},
		nugetJobName: {
			dotnetMetadataCore, registryAspNetPackage, registryEFPackage, registryHangfirePackage,
			dotnetMetadataHTTP, registryRedisPackage, registryOTelPackage,
		},
		registryPackagistFamily: {registryPackagistPackage}, registryCratesFamily: {releaseMetadataKeyword},
		mavenMetadataFamily:   {pythonCoreID, "logbrew-kotlin", "logbrew-kotlin-okhttp"},
		registryOpenUPMFamily: {registryUnityPackage}, fixtureUnknown: nil,
	}
	for family, expected := range cases {
		if got := registryPackageCatalog(family); !reflect.DeepEqual(got, expected) {
			t.Errorf("%s catalog = %v, want %v", family, got, expected)
		}
	}
}

func TestRegistryPackageCatalogIsolation(t *testing.T) {
	t.Parallel()
	for _, family := range []string{
		registryNPMFamily, registryPythonFamily, registryRubyFamily, nugetJobName,
		registryPackagistFamily, registryCratesFamily, mavenMetadataFamily, registryOpenUPMFamily,
	} {
		first := registryPackageCatalog(family)
		first[0] = "mutated-registry-default"
		if registryPackageCatalog(family)[0] == first[0] {
			t.Errorf("%s shares mutable defaults", family)
		}
	}
}
