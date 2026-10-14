package main

import "slices"

const (
	objcMetadataFamily    = "objc"
	swiftMetadataPrefix   = "swift/logbrew-swift/"
	swiftMetadataManifest = "Package.swift"
)

func objcMetadataPolicy() sourceMetadataPolicy {
	common := []string{
		"LBWHTTPTransport", "metricWithID", "startAutomaticDeliveryWithTransport", "enableDurableDeliveryWithOptions",
	}
	return sourceMetadataPolicy{
		prefix:   "objc/logbrew-objc/",
		patterns: nil,
		files: []string{
			"src/LBWTelemetryContext.h", "src/LBWTelemetryContext.m",
			"src/LBWInvestigationEvidence.h", "src/LBWInvestigationEvidence.m",
			"src/LBWDeliveryEngine.h", "src/LBWDeliveryEngine.m", "src/LBWDeliveryEnginePrivate.h",
			"src/LBWDeliveryEngineDurable.m", "src/LBWDurableDeliveryStore.h", "src/LBWDurableDeliveryStore.m",
			"src/LBWHTTPTransport.m", metadataMakefile, metadataExampleMakefile, "examples/readme_example.m",
			"examples/real_user_smoke.m", "tests/test_logbrew.m", "tests/test_durable_delivery.m",
			"tests/test_durable_delivery_recovery.m", "tests/test_rich_telemetry.m",
		},
		text: map[string][]string{
			"src/LogBrew.m": {`LogBrewObjectiveCVersion = @"0.2.3"`},
			"include/LogBrew.h": slices.Concat(common, []string{
				"LogBrewObjectiveCVersion", "LBWHTTPTransportDefaultEndpoint", "LBWClient", "LBWRecordingTransport",
				"LBWErrorStableCodeKey", "LBWTelemetry", "LBWTelemetryScope", "LBWIssueDiagnostics",
				"addBreadcrumb", "clearBreadcrumbs", "captureProductActionWithID", "captureNetworkMilestoneWithID",
				"LBWAutomaticDeliveryOptions", "LBWDurableDeliveryOptions", "LBWDeliveryHealth",
				"purgeDurableDeliveryWithError", "recoverAutomaticDeliveryWithError", "shutdownOwnedTransportWithError",
			}),
			policyRootGuide: slices.Concat(common, []string{
				"Shared Telemetry Context", "Issue Diagnostics", "Span Evidence", "Public Objective-C SDK",
				metadataConfigurationExample, metadataMetricsHeading, metadataCardinalityGuidance, "Sending To LogBrew",
				"flushWithTransport",
				"copyable source", "Durable Delivery (Opt-In)", "deliveryHealth",
			}),
		},
	}
}

func swiftMetadataPolicy() sourceMetadataPolicy {
	common := []string{
		`name: "logbrew-swift"`, ".macOS(.v13)", ".iOS(.v15)", `.library(name: "LogBrew", targets: ["LogBrew"])`,
	}
	policy := sourceMetadataPolicy{
		prefix:   "",
		patterns: nil,
		files: []string{
			"Sources/LogBrew/DurableDeliveryStore.swift", "Sources/LogBrew/DurableDeliveryStoreRecovery.swift",
			"Sources/LogBrew/DeliveryEngine.swift", "Sources/LogBrew/DeliveryEngineDurable.swift",
			"Sources/LogBrew/DeliveryEngineAutomatic.swift", "Sources/LogBrew/DeliveryEngineQueue.swift",
			"Sources/LogBrew/DeliveryLifecycle.swift", "Tests/LogBrewTests/AutomaticDeliveryTests.swift",
			"Tests/LogBrewTests/AutomaticDeliveryLifecycleTests.swift",
			"Tests/LogBrewTests/AutomaticDeliveryTestSupport.swift",
			"Tests/LogBrewTests/DurableDeliveryPublicContractTests.swift",
			"Tests/LogBrewTests/DurableDeliveryFailureTests.swift",
			"Tests/LogBrewTests/DurableDeliveryRecoveryTests.swift",
		},
		text: map[string][]string{
			swiftMetadataPrefix + policyRootGuide: {
				"startAutomaticDelivery", "AutomaticDeliveryOptions", "Durable Delivery (Opt-In)",
				"DurableDeliveryOptions", "enableDurableDelivery", "purgeDurableDelivery", "deliveryHealth",
			},
			swiftMetadataPrefix + swiftMetadataManifest: slices.Concat(common, []string{
				`.executable(name: "ReadmeExample", targets: ["ReadmeExample"])`,
				`.executable(name: "RealUserSmoke", targets: ["RealUserSmoke"])`,
				`.target(name: "LogBrew")`, `.testTarget(name: "LogBrewTests", dependencies: ["LogBrew"])`,
			}),
			swiftMetadataManifest: slices.Concat(common, []string{
				`.library(name: "LogBrewCrash", targets: ["LogBrewCrash"])`,
				`path: "swift/logbrew-swift/Sources/LogBrew"`, `path: "swift/logbrew-swift/Sources/LogBrewCrash"`,
				`path: "swift/logbrew-swift/Tests/LogBrewTests"`, `path: "swift/logbrew-swift/Tests/LogBrewCrashTests"`,
			}),
		},
	}
	for index, name := range policy.files {
		policy.files[index] = swiftMetadataPrefix + name
	}
	return policy
}
