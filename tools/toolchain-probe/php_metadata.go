package main

import (
	"os"
	"strconv"
	"strings"
)

const (
	phpMetadataFamily   = "php"
	phpMetadataManifest = "composer.json"
	phpMetadataPrefix   = "php/logbrew-php/"
)

func checkPHPMetadata(root *os.Root) bool {
	if !releaseMetadataFileExists(root, phpMetadataPrefix+policyRootGuide) {
		return false
	}
	for _, name := range []string{phpMetadataManifest, phpMetadataPrefix + phpMetadataManifest} {
		data, readable := readReleaseMetadata(root, name)
		if !readable || !validPHPMetadata(data, name) {
			return false
		}
	}
	return true
}

func validPHPMetadata(data []byte, manifestPath string) bool {
	if len(data) > pythonManifestLimit ||
		(manifestPath != phpMetadataManifest && manifestPath != phpMetadataPrefix+phpMetadataManifest) {
		return false
	}
	document, valid := decodeCheckJSON(data)
	manifest, object := document.(map[string]any)
	if !valid || !object {
		return false
	}
	expectations := []string{
		`name="logbrew/sdk"`, `type="library"`, `license="MIT"`, `require.php="^8.2"`, `require.psr/log="^3.0"`,
	}
	autoload := "src/"
	if manifestPath == phpMetadataManifest {
		autoload = phpMetadataPrefix + autoload
		if !metadataHasKeyword(manifest["keywords"]) {
			return false
		}
		expectations = append(expectations,
			`readme="php/logbrew-php/README.md"`,
			`homepage="https://github.com/LogBrewCo/sdk/tree/main/php/logbrew-php"`,
			`support.issues="https://github.com/LogBrewCo/sdk/issues"`,
			`support.source="https://github.com/LogBrewCo/sdk/tree/main/php/logbrew-php"`,
		)
	}
	expectations = append(expectations, `autoload.psr-4.LogBrew\=`+strconv.Quote(autoload))
	description, text := manifest["description"].(string)
	return text && strings.Contains(description, "LogBrew") &&
		checkExpectedFields([]map[string]any{manifest}, expectations, jsonEventFields)
}
