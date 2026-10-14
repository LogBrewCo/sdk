package main

import (
	"io"
	"maps"
	"slices"
	"strconv"
	"strings"
)

const (
	mavenPublicSmoke = "scripts/real_user_maven_central_public_smoke.sh"
	unitModulePrefix = "tests.test_"
	receiptTargets   = "release_artifact_receipt_modes release_metadata"
	workflowTargets  = "js_installed_artifact_workflow_gates"
	pythonSuffix     = ".py"
)

func unitPathTargets() map[string]string {
	return map[string]string{
		ciWorkflowPath: workflowTargets +
			" go_workflow_cache_path release_artifact_smoke_gates",
		readinessWorkflowPath:                                     workflowTargets,
		publishWorkflowPath:                                       "release_metadata swiftpm_public_smoke",
		".github/workflows/reconcile-public-packages.yml":         receiptTargets,
		mavenPublicSmoke:                                          "maven_central_public_smoke",
		"scripts/real_user_swiftpm_public_smoke.sh":               "swiftpm_public_smoke",
		"scripts/real_user_native_release_public_smoke.sh":        "native_release_public_smoke",
		releaseMetadataScript:                                     "release_metadata",
		"scripts/real_user_node_ingest_contract_smoke.sh":         "default_ingest_endpoints",
		"scripts/real_user_react_native_smoke.sh":                 "react_native_global_errors",
		"scripts/real_user_react_native_bundle_smoke.sh":          "react_native_mobile_core",
		"scripts/real_user_go_persistence_smoke.sh":               "go_persistence_smoke",
		"scripts/real_user_dotnet_selected_public_nuget_smoke.sh": receiptTargets,
	}
}

func selectUnitTargets(paths []string) []string {
	modules := make(map[string]bool)
	explicit := unitPathTargets()
	for _, path := range paths {
		path = strings.TrimPrefix(strings.TrimSpace(path), "./")
		if targets, exists := explicit[path]; exists {
			for target := range strings.FieldsSeq(targets) {
				modules[unitModulePrefix+target] = true
			}
			continue
		}
		if strings.HasPrefix(path, "tests/test_") && strings.HasSuffix(path, pythonSuffix) {
			module := strings.ReplaceAll(strings.TrimSuffix(path, pythonSuffix), "/", ".")
			if !validUnitModule(module) {
				return nil
			}
			modules[module] = true
			continue
		}
		if requiresFullUnitDiscovery(path) {
			return nil
		}
	}
	return slices.Sorted(maps.Keys(modules))
}

func requiresFullUnitDiscovery(path string) bool {
	return strings.HasPrefix(path, ".github/workflows/") ||
		strings.HasPrefix(path, "tests/") && strings.HasSuffix(path, pythonSuffix) ||
		strings.HasPrefix(path, "scripts/") &&
			(strings.HasSuffix(path, pythonSuffix) || strings.HasSuffix(path, ".sh"))
}

func validUnitModule(module string) bool {
	for part := range strings.SplitSeq(module, ".") {
		if part == "" {
			return false
		}
		for index, char := range part {
			if char != '_' && (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') &&
				(index == 0 || char < '0' || char > '9') {
				return false
			}
		}
	}
	return true
}

func writeUnitTargets(output io.Writer, paths []string) int {
	modules := selectUnitTargets(paths)
	return writeText(output, "run_all="+strconv.FormatBool(len(modules) == 0)+
		"\nmodules="+strings.Join(modules, " ")+"\n", exitOK)
}
