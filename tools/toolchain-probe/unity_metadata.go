package main

import (
	"encoding/json"
	"os"
	"reflect"
	"slices"
	"strings"
)

const (
	unityMetadataFamily   = "unity"
	unityMetadataPrefix   = "unity/logbrew-unity/"
	unityMetadataManifest = unityMetadataPrefix + "package.json"
	unityOpenUPMMetadata  = ".github/publishing/openupm-co.logbrew.unity.yml"
)

func checkUnityMetadata(root *os.Root) bool {
	data, readable := readReleaseMetadata(root, unityMetadataManifest)
	listing, listingRead := readReleaseMetadata(root, unityOpenUPMMetadata)
	return readable && listingRead && releaseMetadataFileExists(root, unityMetadataPrefix+policyRootGuide) &&
		validUnityMetadata(data, listing)
}

func validUnityMetadata(data, listing []byte) bool {
	if len(data) > pythonManifestLimit {
		return false
	}
	document, valid := decodeCheckJSON(data)
	manifest, object := document.(map[string]any)
	if !valid || !object || !metadataHasKeyword(manifest["keywords"]) {
		return false
	}
	description, text := manifest["description"].(string)
	expectations := []string{
		`name="co.logbrew.unity"`, `version="0.2.2"`, `displayName="LogBrew Unity SDK"`,
		`unity="2021.3"`, `license="MIT"`, `author.name="LogBrew"`, `repository.type="git"`,
		`repository.url="git+https://github.com/LogBrewCo/sdk.git"`,
	}
	return text && strings.Contains(description, "LogBrew") &&
		checkExpectedFields([]map[string]any{manifest}, expectations, jsonEventFields) &&
		validUnitySamples(manifest["samples"]) && validUnityListing(manifest, decodeFlatMetadata(listing))
}

func validUnitySamples(value any) bool {
	samples, array := value.([]any)
	if !array || len(samples) != 2 {
		return false
	}
	paths := make([]string, 0, len(samples))
	for _, sample := range samples {
		object, valid := sample.(map[string]any)
		path, text := object["path"].(string)
		if !valid || !text {
			return false
		}
		paths = append(paths, path)
	}
	slices.Sort(paths)
	return slices.Equal(paths, []string{"Samples~/ReadmeExample", "Samples~/RealUserSmoke"})
}

func validUnityListing(manifest, listing map[string]any) bool {
	for key, expected := range map[string]any{
		pythonPublicName: manifest[pythonPublicName], "displayName": manifest["displayName"],
		"description": manifest["description"],
		"repoUrl":     releaseMetadataRepository, "trackingMode": "git", "parentRepoUrl": nil,
		"licenseSpdxId": manifest["license"], "licenseName": "MIT License", "hunter": "furkanerday",
		"gitTagPrefix": "co.logbrew.unity/", "gitTagIgnore": "", "minVersion": manifest["version"],
		"image": "https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/" +
			"logbrew-logo-espresso-bg-512.png",
		releaseMetadataReadme: "main:unity/logbrew-unity/README.md",
		"readme_zhCN":         "", "displayName_zhCN": "", "description_zhCN": "", "aliases": []string{},
		"topics": []string{"debugging-and-logging", "integration", "services", "testing", "utilities"},
	} {
		value, exists := listing[key]
		if !exists || !reflect.DeepEqual(value, expected) {
			return false
		}
	}
	created, number := listing["createdAt"].(json.Number)
	milliseconds, err := created.Int64()
	return number && err == nil && milliseconds > 0
}
