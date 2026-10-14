package main

import "strings"

const (
	jsMetadataDirectory   = "js"
	jsMetadataManifest    = "package.json"
	jsMetadataScope       = "@logbrew/"
	jsMetadataCore        = jsMetadataScope + "sdk"
	jsMetadataNext        = jsMetadataScope + "next"
	jsMetadataNative      = jsMetadataScope + "react-native"
	jsMetadataTypes       = "types"
	jsMetadataExport      = "exports"
	jsMetadataFiles       = "files"
	jsMetadataRootExport  = "."
	jsMetadataIndex       = "./index.js"
	jsMetadataRelative    = "./"
	jsMetadataCommonTypes = ".d.cts"
	jsMetadataModuleTypes = ".d.ts"
)

type jsMetadataPolicy struct {
	fields  map[string]any
	exports map[string]map[string]string
	files   []string
}

func jsMetadataPackages() map[string]string {
	packages := make(map[string]string)
	for suffix := range strings.FieldsSeq("angular amqplib aws-sqs browser bullmq express fastify js kafkajs " +
		"nestjs next node prisma react react-native svelte vue") {
		name := suffix
		if name == jsMetadataDirectory {
			name = "sdk"
		}
		packages[jsMetadataDirectory+"/logbrew-"+suffix] = jsMetadataScope + name
	}
	return packages
}

func newJSMetadataPolicy(name string) jsMetadataPolicy {
	policy := jsMetadataPolicy{
		fields: map[string]any{
			pythonPublicName: name, releaseMetadataLicenseKey: releaseMetadataLicense, "repository.type": "git",
			"repository.url": "git+" + releaseMetadataRepository + ".git", "engines.node": ">=18",
			"sideEffects": false, "type": "module", "main": "./index.cjs", jsMetadataTypes: "./index.d.ts",
		},
		exports: make(map[string]map[string]string), files: []string{policyRootGuide, "examples"},
	}
	policy.addExport(jsMetadataRootExport, "index", jsMetadataCommonTypes)
	switch name {
	case jsMetadataCore:
		policy.files = append(policy.files, "release-artifacts-common.js", "release-artifacts.js",
			"release-artifacts-upload.js", "release-artifacts-symbolication.js")
		policy.fields["bin.logbrew-release-artifacts"] = "./release-artifacts.js"
		policy.addExport("./vite-release-artifacts", "vite-release-artifacts", jsMetadataCommonTypes)
	case jsMetadataNext:
		policy.addExport("./instrumentation", "instrumentation", jsMetadataCommonTypes)
		policy.addExport("./release-artifacts", "release-artifacts", jsMetadataCommonTypes)
	case jsMetadataNative:
		policy.files = append(policy.files, "index.native.js", "apple-native-diagnostics.js",
			"apple-native-diagnostics.d.ts", "ios/AppleDiagnostics", "ios/GeneratedAppleDiagnostics",
			"scripts/sync-apple-native-sources.mjs")
		policy.addExport("./release-artifacts", "release-artifacts", jsMetadataCommonTypes)
		policy.addExport("./expo", "expo", jsMetadataModuleTypes)
		policy.exports["./apple-native-diagnostics"] = map[string]string{
			"react-native.types":   "./apple-native-diagnostics.d.ts",
			"react-native.default": "./apple-native-diagnostics.js",
		}
		policy.fields["peerDependencies.expo"] = ">=49"
		policy.fields["peerDependenciesMeta.expo.optional"] = true
	case jsMetadataScope + "amqplib":
		policy.fields["peerDependencies.amqplib"] = ">=0.10"
	default:
	}
	return policy
}

func (policy *jsMetadataPolicy) addExport(name, stem, requireTypes string) {
	types := stem + requireTypes
	policy.exports[name] = map[string]string{
		"import.types":   jsMetadataRelative + stem + jsMetadataModuleTypes,
		"import.default": jsMetadataRelative + stem + ".js",
		"require.types":  jsMetadataRelative + types, "require.default": jsMetadataRelative + stem + ".cjs",
	}
	policy.files = append(policy.files, stem+".js", stem+".cjs", stem+jsMetadataModuleTypes)
	if requireTypes != jsMetadataModuleTypes {
		policy.files = append(policy.files, types)
	}
}
