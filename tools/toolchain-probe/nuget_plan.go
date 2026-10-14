package main

import (
	"encoding/json"
	"os"
	"path"
	"reflect"
	"strings"
)

const (
	nugetPlanSelectionLimit = 1024
	nugetPlanSelected       = "selected"
	nugetPlanMode           = "selectionMode"
	nugetPlanPackageID      = "packageId"
	nugetPlanProject        = "projectPath"
	nugetPlanVersionOutput  = "versionOutput"
)

func nugetPlanSelection(raw string) []string {
	if len(raw) > nugetPlanSelectionLimit || strings.ContainsAny(raw, "\r\n") {
		return nil
	}
	requested := nugetRequestedPackages(raw)
	if requested == nil {
		return nil
	}
	selected := make([]string, 0, len(dotnetMetadataPackages()))
	for _, pkg := range dotnetMetadataPackages() {
		if raw == "" || requested[pkg.id] {
			selected = append(selected, pkg.id)
		}
	}
	if raw != "" && len(selected) != len(requested) {
		return nil
	}
	return selected
}

func nugetRequestedPackages(raw string) map[string]bool {
	requested := make(map[string]bool)
	if raw != "" {
		for value := range strings.SplitSeq(raw, ",") {
			id := strings.TrimSpace(value)
			if id == "" || requested[id] {
				return nil
			}
			requested[id] = true
		}
		if !releasableNugetSet(requested) {
			return nil
		}
	}
	return requested
}

func releasableNugetSet(selected map[string]bool) bool {
	return len(selected) == 2 && selected[dotnetMetadataCore] && selected[dotnetMetadataHTTP] ||
		len(selected) == 1 && !selected[dotnetMetadataCore] && !selected[dotnetMetadataHTTP]
}

func nugetPlanAtRoot(root *os.Root, raw string) map[string]any {
	ids := nugetPlanSelection(raw)
	if len(ids) == 0 {
		return nil
	}
	entries := make([]any, 0, len(ids))
	for _, packageID := range ids {
		project := path.Join(dotnetMetadataSource, packageID, packageID+dotnetMetadataProject)
		data, readable := readReleaseMetadata(root, project)
		version := dotnetProjectProperties(data).value(dotnetMetadataVersion)
		if !readable || !validPythonPackageVersion(version) {
			return nil
		}
		entries = append(entries, map[string]any{
			nugetPlanPackageID: packageID, nugetPlanProject: project, pythonManifestVersion: version,
			nugetPlanVersionOutput: nugetVersionOutput(packageID),
		})
	}
	mode := nugetPlanSelected
	if raw == "" {
		mode = "all"
	}
	return map[string]any{"schemaVersion": json.Number("1"), nugetPlanMode: mode, nugetPlanSelected: entries}
}

func nugetVersionOutput(packageID string) string {
	aliases := map[string]string{
		dotnetMetadataCore: "core", "LogBrew.EntityFrameworkCore": "efcore",
		"LogBrew.StackExchangeRedis": "redis", "LogBrew.OpenTelemetry": "otel",
	}
	name, found := aliases[packageID]
	if !found {
		name = strings.ToLower(strings.TrimPrefix(packageID, "LogBrew."))
	}
	return name + "_version"
}

func validNugetPlan(root *os.Root, data []byte) bool {
	if len(data) > pythonManifestLimit {
		return false
	}
	document, decoded := decodeCheckDocument(data)
	plan := eventObject(document)
	entries, array := plan[nugetPlanSelected].([]any)
	if !decoded || !array || len(entries) == 0 || len(entries) > len(dotnetMetadataPackages()) {
		return false
	}
	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		id, text := eventObject(entry)[nugetPlanPackageID].(string)
		if !text {
			return false
		}
		ids = append(ids, id)
	}
	raw := strings.Join(ids, ",")
	if plan[nugetPlanMode] == "all" {
		raw = ""
	}
	expected := nugetPlanAtRoot(root, raw)
	return expected != nil && reflect.DeepEqual(plan, expected)
}
