package main

import (
	"maps"
	"reflect"
	"strings"
)

type pythonMetadataPolicy struct {
	optional             map[string][]string
	version, description string
	dependencies         []string
}

func pythonMetadataPolicies() map[string]pythonMetadataPolicy {
	const core = "logbrew-sdk>=0.1.12,<0.2.0"
	return map[string]pythonMetadataPolicy{
		pythonDjangoID: {nil, "0.1.6", "Django integration", []string{"Django>=4.2.30,<6", core}},
		pythonFlaskID:  {nil, "0.1.5", "Flask integration", []string{"Flask>=3.1", core}},
		pythonFastAPIID: {
			map[string][]string{"celery": {"logbrew-sdk[celery]>=0.1.12,<0.2.0"}},
			"0.1.10", "FastAPI integration",
			[]string{"fastapi>=0.111.1", core},
		},
		pythonCoreID: {
			map[string][]string{
				pythonExtraARQ: {"arq>=0.28,<1"}, "celery": {"celery>=5,<6"},
				pythonExtraDramatiq: {"dramatiq>=2.2.1,<3"},
				"persistence":       {"cryptography>=49,<50"}, "rq": {"rq>=2,<3"},
			},
			"0.1.16", "Public LogBrew Python SDK",
			[]string{"certifi>=2026.7.22", "truststore>=0.10.4,<1", "typing-extensions>=4.1; python_version < '3.11'"},
		},
	}
}

func validPythonMetadata(data []byte, packageID string) bool {
	policy, supported := pythonMetadataPolicies()[packageID]
	project := decodeReleaseMetadata(data, "project")
	if !supported || project == nil {
		return false
	}
	for key, expected := range map[string]string{
		pythonPublicName: packageID, pythonManifestVersion: policy.version,
		releaseMetadataLicenseKey: releaseMetadataLicense,
		releaseMetadataReadme:     "README.md", "requires-python": ">=3.10",
	} {
		if project[key] != expected {
			return false
		}
	}
	description, isText := project["description"].(string)
	return isText && strings.Contains(description, policy.description) && validPythonMetadataAttribution(project) &&
		pythonMetadataSet(project["dependencies"], policy.dependencies) &&
		validPythonMetadataExtras(project["optional-dependencies"], policy.optional)
}

func validPythonMetadataAttribution(project map[string]any) bool {
	authors, authorArray := project["authors"].([]any)
	foundAuthor := false
	for _, author := range authors {
		foundAuthor = foundAuthor || reflect.DeepEqual(author, map[string]any{"name": "LogBrew"})
	}
	urls, urlTable := project["urls"].(map[string]any)
	return metadataHasKeyword(project["keywords"]) && authorArray && foundAuthor &&
		(project["urls"] == nil || urlTable &&
			(len(urls) == 0 || urls["Repository"] == releaseMetadataRepository))
}

func pythonMetadataSet(value any, expected []string) bool {
	items, array := value.([]any)
	actualSet, expectedSet := make(map[string]bool), make(map[string]bool)
	if !array {
		return false
	}
	for _, item := range items {
		text, valid := item.(string)
		if !valid {
			return false
		}
		actualSet[text] = true
	}
	for _, item := range expected {
		expectedSet[item] = true
	}
	return maps.Equal(actualSet, expectedSet)
}

func validPythonMetadataExtras(value any, expected map[string][]string) bool {
	if expected == nil {
		return true
	}
	actual, object := value.(map[string]any)
	if !object || len(actual) != len(expected) {
		return false
	}
	for name, dependencies := range expected {
		if !pythonMetadataSet(actual[name], dependencies) {
			return false
		}
	}
	return true
}
