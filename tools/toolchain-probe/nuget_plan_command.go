package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

const (
	nugetCanonicalizeMode = "canonicalize"
	nugetSelectionFlag    = "--packages-env"
	nugetValidateMode     = "validate"
	nugetPlanCommand      = "nuget-plan"
	nugetRootFlag         = "--root"
	nugetPlanFlag         = "--plan"
)

func runNugetPlan(arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) > 0 && arguments[0] == "dependency-range" {
		return runNugetDependencyRange(arguments[1:], output, diagnostic)
	}
	options := nugetPlanArguments(arguments)
	if options == nil {
		return writeText(diagnostic, "invalid NuGet plan arguments\n", exitUsage)
	}
	command := arguments[0]
	raw := ""
	if options[nugetSelectionFlag] != "" {
		var present bool
		raw, present = os.LookupEnv(options[nugetSelectionFlag])
		if !present || nugetPlanSelection(raw) == nil {
			return writeText(diagnostic, "invalid NuGet package selection\n", exitFailure)
		}
	}
	if command == nugetCanonicalizeMode {
		if raw != "" {
			raw = strings.Join(nugetPlanSelection(raw), ",")
		}
		return writeText(output, raw+"\n", exitOK)
	}
	root, err := os.OpenRoot(options[nugetRootFlag])
	if err != nil {
		return writeText(diagnostic, "invalid NuGet release plan\n", exitFailure)
	}
	text, valid := executeNugetPlan(root, command, options, raw)
	if closeError := root.Close(); !valid || closeError != nil {
		return writeText(diagnostic, "invalid NuGet release plan\n", exitFailure)
	}
	return writeText(output, text, exitOK)
}

func runNugetDependencyRange(arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) != 1 {
		return writeText(diagnostic, "invalid NuGet dependency version\n", exitUsage)
	}
	value := dotnetCompatibleRange(arguments[0])
	if value == "" {
		return writeText(diagnostic, "invalid NuGet dependency version\n", exitUsage)
	}
	return writeText(output, value+"\n", exitOK)
}

func nugetPlanArguments(arguments []string) map[string]string {
	if len(arguments) == 0 {
		return nil
	}
	required := map[string][]string{
		"create": {nugetRootFlag, nugetSelectionFlag, "--output"}, nugetCanonicalizeMode: {nugetSelectionFlag},
		nugetValidateMode: {nugetRootFlag, nugetPlanFlag}, "entries": {nugetRootFlag, nugetPlanFlag, "--format"},
	}[arguments[0]]
	if len(required) == 0 || len(arguments) != 1+len(required)*2 {
		return nil
	}
	options := make(map[string]string, len(required))
	for index := 1; index < len(arguments); index += 2 {
		key, value := arguments[index], arguments[index+1]
		if !slices.Contains(required, key) || options[key] != "" || value == "" {
			return nil
		}
		options[key] = value
	}
	for _, key := range []string{nugetRootFlag, nugetPlanFlag, "--output"} {
		if value := options[key]; value != "" && !filepath.IsAbs(value) {
			return nil
		}
	}
	if format := options["--format"]; format != "" &&
		!slices.Contains([]string{"ids", "versions", "projects", "mode"}, format) {
		return nil
	}
	return options
}

func executeNugetPlan(root *os.Root, command string, options map[string]string, raw string) (string, bool) {
	const accepted = "nuget release plan ok\n"
	if command == "create" {
		plan := nugetPlanAtRoot(root, raw)
		data, err := json.Marshal(plan)
		return accepted, plan != nil && err == nil && writeNugetPlan(options["--output"], append(data, '\n'))
	}
	data, readable := readCheckFile(options[nugetPlanFlag])
	if !readable || !validNugetPlan(root, data) {
		return "", false
	}
	if command == nugetValidateMode {
		return accepted, true
	}
	document, decoded := decodeCheckDocument(data)
	if !decoded {
		return "", false
	}
	return nugetPlanEntryText(eventObject(document), options["--format"])
}

func writeNugetPlan(filename string, data []byte) bool {
	const pathLimit = 4096
	if !filepath.IsAbs(filename) || len(filename) > pathLimit || len(data) > pythonManifestLimit {
		return false
	}
	parent := filepath.Dir(filename)
	if err := os.MkdirAll(parent, pythonBundleDirectoryMode); err != nil {
		return false
	}
	root, err := os.OpenRoot(parent)
	if err != nil {
		return false
	}
	written := writePythonManifestAtRoot(root, filepath.Base(filename), data)
	closeError := root.Close()
	return written && closeError == nil
}

func nugetPlanEntryText(plan map[string]any, format string) (string, bool) {
	if format == "mode" {
		mode, text := plan[nugetPlanMode].(string)
		return mode + "\n", text
	}
	entries, array := plan[nugetPlanSelected].([]any)
	if !array {
		return "", false
	}
	var output strings.Builder
	for _, entry := range entries {
		item := eventObject(entry)
		packageID, hasID := item[nugetPlanPackageID].(string)
		project, hasProject := item[nugetPlanProject].(string)
		version, hasVersion := item[pythonManifestVersion].(string)
		if !hasID || !hasProject || !hasVersion {
			return "", false
		}
		var text string
		switch format {
		case "ids":
			text = packageID + "\n"
		case "versions":
			text = packageID + "=" + version + "\n"
		case "projects":
			text = fmt.Sprintf("%s\t%s\t%s\n", packageID, project, version)
		default:
			return "", false
		}
		if _, err := output.WriteString(text); err != nil {
			return "", false
		}
	}
	return output.String(), true
}
