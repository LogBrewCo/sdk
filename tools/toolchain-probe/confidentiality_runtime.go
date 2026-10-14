package main

import (
	"slices"
	"strings"
)

func confidentialityRuntimeScope(name, line, terms string) bool {
	if confidentialityRustScope(name, line, terms) || confidentialityHTTPScope(name, line, terms) {
		return true
	}
	if terms == policyUndoTerm && name == "kotlin/logbrew-kotlin/src/main/kotlin/co/logbrew/sdk/LogBrewCoroutines.kt" {
		return strings.Contains(line, "restoreThreadContext")
	}
	lower := confidentialityLower(line)
	return terms == policyUndoTerm && strings.Contains(lower, "coroutine") && strings.Contains(lower, policyUndoTerm) &&
		slices.Contains([]string{
			"kotlin/logbrew-kotlin/README.md", policyMemoryPath,
		}, name)
}

func confidentialityRustScope(name, line, terms string) bool {
	trimmed := confidentialityTrim(line)
	switch name {
	case policyRootGuide:
		return terms == "hostnames" && strings.HasPrefix(trimmed,
			"and does not probe hostnames, process details, environment variables, local")
	case "rust/logbrew/README.md":
		return confidentialityRustREADME(line, trimmed, terms)
	case "rust/logbrew/src/telemetry_context.rs":
		return confidentialityRustContext(line, trimmed, terms)
	case "rust/logbrew/tests/telemetry_context.rs":
		return terms == "customer" && strings.Contains(line, `"customer.tier"`) ||
			terms == policyHostTerm && trimmed == `"hostname",` ||
			terms == policyUndoTerm && strings.HasPrefix(trimmed,
				"fn synchronous_scopes_restore_on_close_drop_panic_and_threads()")
	case "scripts/check_rust_first_useful_payload.py":
		return terms == policyHostTerm && strings.HasPrefix(trimmed, `for forbidden_key in ["hostname",`)
	default:
		return false
	}
}

func confidentialityRustContext(line, trimmed, terms string) bool {
	if terms == policyUndoTerm {
		return slices.Contains([]string{
			"/// Run one synchronous closure with context and restore the exact previous scope on unwind.",
			"/// Restore this guard's context contribution. Repeated calls are harmless.",
		}, trimmed)
	}
	return terms == policyAuthTerm && confidentialityContains(line, []string{
		"token: u64", "NEXT_CONTEXT_TOKEN", "{ token, context }", "token: Some(token)",
		"token: Option<u64>", "self.token.take()", "active.token == token",
	})
}

func confidentialityRustREADME(line, trimmed, terms string) bool {
	switch terms {
	case "customer":
		return strings.Contains(line, `"customer.tier"`) ||
			strings.HasPrefix(trimmed, "Session and subject IDs must be application-owned opaque identifiers.")
	case "hostnames":
		return strings.HasPrefix(trimmed, "The client adds conservative `rust` runtime")
	case policyUndoTerm:
		return strings.HasPrefix(trimmed, "`activate_telemetry_context` returns a same-thread RAII guard")
	default:
		return false
	}
}

func confidentialityHTTPScope(name, line, terms string) bool {
	if name == "go/logbrew/http_client_trace.go" && terms == policyHostTerm {
		return confidentialityTrim(line) ==
			`host := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(request.URL.Hostname()), "."))`
	}
	if name == "dotnet/logbrew-dotnet/src/LogBrew.HttpClient/LogBrewHttpClientFactoryCorrelation.cs" {
		return terms == policyDNSTerm || terms == "dns|hostname"
	}
	if terms == policyDNSTerm && slices.Contains([]string{
		"dotnet/logbrew-dotnet/src/LogBrew.HttpClient/README.md",
		"dotnet/logbrew-dotnet/src/LogBrew.HttpClient/examples/HttpClientFactoryCorrelation.cs",
		"dotnet/logbrew-dotnet/tests/LogBrew.HttpClient.Tests/Program.cs",
	}, name) {
		return true
	}
	return slices.Contains(strings.Split(terms, "|"), policyDNSTerm) &&
		confidentialityDNSPhase(name, confidentialityLower(line))
}

func confidentialityDNSPhase(name, lower string) bool {
	const started = "dnsstart"
	switch name {
	case "kotlin/logbrew-kotlin-okhttp/src/main/kotlin/co/logbrew/sdk/okhttp/LogBrewOkHttpPhaseTimings.kt",
		"kotlin/logbrew-kotlin-okhttp/tests/LogBrewOkHttpInterceptorTests.kt",
		"go/logbrew/http_client_trace.go", "go/logbrew/trace_correlation_test.go":
		return strings.Contains(lower, policyDNSTerm)
	case "kotlin/logbrew-kotlin-okhttp/README.md":
		return confidentialityContains(lower, []string{
			started, "dnsend", policyDNSRoute, policyDNSConnect, "dns names", "dns host", "okhttp.phase.dnsms",
		})
	case "go/logbrew/README.md":
		return confidentialityContains(lower, []string{
			started, "dnsdone", policyDNSRoute, policyDNSConnect, "dnsms",
		})
	case policyMemoryPath:
		return confidentialityContains(lower, []string{
			started, "dnsend", "dnsdone", policyDNSRoute, policyDNSConnect, "dns names", "dns host", "dnsms",
		})
	default:
		return false
	}
}

func confidentialityNativeScope(name, line, terms string) bool {
	if slices.Contains([]string{"", "backup", policyCleanTerm, "backup|cleanup"}, terms) &&
		slices.Contains([]string{
			"objc/logbrew-objc/README.md", "objc/logbrew-objc/src/LBWDurableDeliveryStore.m",
			"objc/logbrew-objc/tests/test_durable_delivery.m",
			"objc/logbrew-objc/tests/test_durable_delivery_recovery.m",
			"swift/logbrew-swift/README.md", "swift/logbrew-swift/Sources/LogBrew/DurableDeliveryStoreRecovery.swift",
			"swift/logbrew-swift/Tests/LogBrewTests/DurableDeliveryPublicContractTests.swift",
			"js/logbrew-react-native/ios/GeneratedAppleDiagnostics/LogBrew/DurableDeliveryStoreRecovery.swift",
		}, name) {
		return true
	}
	return confidentialityNativeSymbol(name, line, terms) || confidentialityDurableScope(name, line, terms)
}

func confidentialityNativeSymbol(name, line, terms string) bool {
	if terms == policyCleanTerm && strings.Contains(line, "reportCleanupPolicy") && slices.Contains([]string{
		"swift/logbrew-swift/Sources/LogBrewCrash/CrashEngine.swift",
		"js/logbrew-react-native/ios/GeneratedAppleDiagnostics/LogBrewCrash/CrashEngine.swift",
	}, name) {
		return true
	}
	if terms == "password" {
		return name == "js/logbrew-react-native/apple-native-diagnostics.js" &&
			strings.Contains(line, "parsed.password") ||
			name == "js/logbrew-react-native/ios/AppleDiagnostics/LBRNAppleNativeDiagnostics.swift" &&
				strings.Contains(line, "components.password == nil")
	}
	if terms != "backup" {
		return false
	}
	symbol := confidentialityArchiveSymbol(name)
	return symbol != "" && strings.Contains(line, symbol) &&
		confidentialityTerms(strings.ReplaceAll(line, symbol, "")) == ""
}

func confidentialityArchiveSymbol(name string) string {
	switch name {
	case "swift/logbrew-swift/Sources/LogBrewCrash/CrashStorageDirectory.swift",
		"js/logbrew-react-native/ios/GeneratedAppleDiagnostics/LogBrewCrash/CrashStorageDirectory.swift",
		"swift/logbrew-swift/Tests/LogBrewCrashTests/NativeHangIncidentStoreTests.swift":
		return policyAppleExcluded
	case "js/logbrew-react-native/android/src/main/java/co/logbrew/reactnative/FatalStoreModuleImpl.java":
		return "getNoBackupFilesDir"
	case "js/logbrew-react-native/ios/LBRNFatalStoreModule.mm":
		return "NSURLIsExcludedFromBackupKey"
	default:
		return ""
	}
}

func confidentialityDurableScope(name, line, terms string) bool {
	switch name {
	case ciWorkflowPath:
		return terms == "strategy" && confidentialityTrim(line) == "strategy:"
	case "dotnet/logbrew-dotnet/README.md":
		return terms == "secret" && line ==
			"Only one process may own a store. Recovery fails closed for missing or wrong keys, "+
				"corruption, unknown files, unsafe ownership, links, or replacement. Supply one primary "+
				"key and a bounded list of previous keys to rotate records during recovery; new records "+
				"always use the primary key. Key IDs identify keys but are not secret and must contain "+
				"only stable letters, numbers, `.`, `_`, or `-`."
	case "dotnet/logbrew-dotnet/src/LogBrew/DurableEventStore.cs":
		return terms == policyCleanTerm && strings.Contains(line, "CleanupAcknowledged")
	case "dotnet/logbrew-dotnet/tests/LogBrew.Tests/DurableDeliveryContractTests.cs":
		return terms == policyCleanTerm && confidentialityContains(line, []string{
			"AcknowledgedPrefixCleanupResumesAfterExit", "acknowledgement marker was not durable before cleanup",
			"acknowledged prefix reappeared after cleanup restart", "acknowledgement cleanup restart shutdown failed",
		})
	default:
		return false
	}
}
