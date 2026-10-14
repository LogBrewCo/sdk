package main

import (
	"maps"
	"slices"
	"strings"
)

const (
	nugetProjectLimit     = 512 << 10
	nugetProjectReference = "ProjectReference"
	nugetPackageReference = "PackageReference"
	nugetCoreProject      = "../LogBrew/LogBrew.csproj"
)

type nugetDependencyContract struct {
	dependencies map[string]string
	frameworks   []string
}

// This is the bounded release contract, not a general NuGet range evaluator.
func nugetDependencyRange(raw string) string {
	if validPythonPackageVersion(raw) {
		return "[" + raw + ", )"
	}
	if !strings.HasPrefix(raw, "[") || !strings.HasSuffix(raw, ")") {
		return ""
	}
	lower, upper, found := strings.Cut(raw[1:len(raw)-1], ", ")
	if !found || !validPythonPackageVersion(lower) || (upper != "" && !validPythonPackageVersion(upper)) {
		return ""
	}
	return raw
}

func nugetSourceDependencies(data []byte, packageID, coreRange string) *nugetDependencyContract {
	if len(data) > nugetProjectLimit || (packageID != dotnetMetadataCore && packageID != dotnetMetadataHTTP) {
		return nil
	}
	project := parseMetadataXML(data)
	if project == nil {
		return nil
	}
	contract := &nugetDependencyContract{
		frameworks: nugetSourceFrameworks(project), dependencies: make(map[string]string),
	}
	if contract.frameworks == nil {
		return nil
	}
	var references []string
	for _, group := range project.descendants("ItemGroup") {
		if !contract.addSourceGroup(group, &references) {
			return nil
		}
	}
	if !contract.bindCore(packageID, coreRange, references) || len(contract.dependencies) == 0 {
		return nil
	}
	return contract
}

func (contract *nugetDependencyContract) addSourceGroup(group *metadataXMLNode, references *[]string) bool {
	for _, item := range group.children {
		if item.name == nugetPackageReference || item.name == nugetProjectReference {
			if group.attribute("Condition") != "" || !contract.addSourceReference(item, references) {
				return false
			}
		}
	}
	return true
}

func nugetSourceFrameworks(project *metadataXMLNode) []string {
	targets := project.descendants(dotnetMetadataTargets)
	if len(targets) != 1 || targets[0].value() == "" {
		return nil
	}
	frameworks := strings.Split(targets[0].value(), ";")
	for index, framework := range frameworks {
		if framework == "" || slices.Contains(frameworks[:index], framework) {
			return nil
		}
	}
	return frameworks
}

func (contract *nugetDependencyContract) addSourceReference(item *metadataXMLNode, references *[]string) bool {
	packageID := item.attribute("Include")
	if packageID == "" || item.attribute("Condition") != "" {
		return false
	}
	if item.name == nugetProjectReference {
		*references = append(*references, packageID)
		return true
	}
	version := item.attribute(dotnetMetadataVersion)
	if !validPythonPackageVersion(version) || contract.dependencies[packageID] != "" {
		return false
	}
	contract.dependencies[packageID] = nugetDependencyRange(version)
	return true
}

func (contract *nugetDependencyContract) bindCore(id, coreRange string, references []string) bool {
	if id == dotnetMetadataCore {
		return len(references) == 0
	}
	coreRange = nugetDependencyRange(coreRange)
	if !slices.Equal(references, []string{nugetCoreProject}) || coreRange == "" ||
		contract.dependencies[dotnetMetadataCore] != "" {
		return false
	}
	contract.dependencies[dotnetMetadataCore] = coreRange
	return true
}

func (contract *nugetDependencyContract) matchesGroups(value any) bool {
	groups, valid := value.([]any)
	if !valid || len(groups) != len(contract.frameworks) {
		return false
	}
	seen := make(map[string]bool, len(groups))
	for _, value := range groups {
		group := eventObject(value)
		framework, present := group["targetFramework"].(string)
		if !present {
			return false
		}
		if framework == ".NETStandard2.0" {
			framework = dotnetMetadataStandard
		}
		if seen[framework] || !slices.Contains(contract.frameworks, framework) ||
			!contract.matchesDependencies(group["dependencies"]) {
			return false
		}
		seen[framework] = true
	}
	return true
}

func (contract *nugetDependencyContract) matchesDependencies(value any) bool {
	dependencies, valid := value.([]any)
	if !valid || len(dependencies) != len(contract.dependencies) {
		return false
	}
	actual := make(map[string]string, len(dependencies))
	for _, value := range dependencies {
		dependency := eventObject(value)
		packageID, hasID := dependency["id"].(string)
		raw, hasRange := dependency["range"].(string)
		versionRange := nugetDependencyRange(raw)
		if !hasID || !hasRange || packageID == "" || actual[packageID] != "" || versionRange == "" {
			return false
		}
		actual[packageID] = versionRange
	}
	return maps.Equal(actual, contract.dependencies)
}

func (contract *nugetDependencyContract) matchesNuspec(metadata *metadataXMLNode) bool {
	dependencies := metadata.path("dependencies")
	if dependencies == nil {
		return false
	}
	groups := make([]any, 0, len(dependencies.children))
	for _, group := range dependencies.children {
		if group.name != "group" {
			return false
		}
		items := make([]any, 0, len(group.children))
		for _, item := range group.children {
			if item.name != "dependency" || len(item.children) != 0 {
				return false
			}
			items = append(items, map[string]any{"id": item.attribute("id"), "range": item.attribute("version")})
		}
		groups = append(groups, map[string]any{
			"targetFramework": group.attribute("targetFramework"), "dependencies": items,
		})
	}
	return contract.matchesGroups(groups)
}
