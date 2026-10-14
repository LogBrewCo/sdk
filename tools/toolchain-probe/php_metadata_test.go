package main

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"
)

func TestPHPMetadataCommand(t *testing.T) {
	t.Parallel()
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	var output, diagnostic bytes.Buffer
	if runReleaseMetadata([]string{phpMetadataFamily, root}, &output, &diagnostic) != exitOK || diagnostic.Len() != 0 ||
		output.String() != "{\"scope\":\"php_release_metadata\",\"valid\":true}\n" {
		t.Fatal("PHP release metadata command unavailable or receipt invalid")
	}
}

func TestPHPMetadataDeclarations(t *testing.T) {
	t.Parallel()
	for _, name := range []string{phpMetadataPrefix + phpMetadataManifest, phpMetadataManifest} {
		checkPHPMetadataDeclarations(t, name)
	}
}

func checkPHPMetadataDeclarations(t *testing.T, name string) {
	t.Helper()
	data := repositorySource(t, name)
	for _, replacement := range [][2]string{
		{`"name": "logbrew/sdk"`, `"name": false`},
		{`"type": "library"`, `"type": "project"`},
		{`"license": "MIT"`, `"license": false`},
		{`"php": "^8.2"`, `"php": "^8.3"`},
		{`"psr/log": "^3.0"`, `"psr/log": "^2.0"`},
		{`"autoload": {`, `"wrong-autoload": {`},
		{`"psr-4": {`, `"wrong-psr": {`},
		{`"LogBrew\\":`, `"Wrong\\":`},
		{`"description": "Public LogBrew`, `"description": "Unknown`},
	} {
		assertPHPMetadataMutation(t, data, replacement, name)
	}
	if name == phpMetadataManifest {
		for _, replacement := range [][2]string{
			{`"readme":`, `"wrong-readme":`},
			{`"homepage":`, `"wrong-homepage":`},
			{`"issues":`, `"wrong-issues":`},
			{`"source":`, `"wrong-source":`},
			{`"logbrew",`, `"unknown",`},
			{`"php/logbrew-php/src/"`, `"src/"`},
		} {
			assertPHPMetadataMutation(t, data, replacement, name)
		}
	} else {
		assertPHPMetadataMutation(t, data, [2]string{`"src/"`, `"php/logbrew-php/src/"`}, name)
	}
}

func assertPHPMetadataMutation(t *testing.T, data string, replacement [2]string, name string) {
	t.Helper()
	changed := strings.Replace(data, replacement[0], replacement[1], 1)
	_, validJSON := decodeCheckJSON([]byte(changed))
	if changed == data || !validJSON || validPHPMetadata([]byte(changed), name) {
		t.Fatalf("PHP field mutation %s did not apply, broke JSON, or passed validation", replacement[0])
	}
}

func TestPHPMetadataRejectsInvalidInput(t *testing.T) {
	t.Parallel()
	data := repositorySource(t, phpMetadataManifest)
	for _, invalid := range []string{
		"", "null", "[]", "{}", "{", "{\"name\":\"\xff\"}",
		strings.Replace(data, "{", "{\"name\":\"duplicate\",", 1),
		strings.Repeat(" ", pythonManifestLimit+1),
	} {
		for _, name := range []string{phpMetadataPrefix + phpMetadataManifest, phpMetadataManifest} {
			if validPHPMetadata([]byte(invalid), name) {
				t.Fatal("malformed, duplicate, or oversized PHP metadata accepted")
			}
		}
	}
	if validPHPMetadata([]byte(data), "unknown") {
		t.Fatal("unknown PHP manifest selection accepted")
	}
}

func TestPHPMetadataRequiredFiles(t *testing.T) {
	t.Parallel()
	files := map[string]string{
		phpMetadataManifest:                     repositorySource(t, phpMetadataManifest),
		phpMetadataPrefix + phpMetadataManifest: repositorySource(t, phpMetadataPrefix+phpMetadataManifest),
		phpMetadataPrefix + policyRootGuide:     "",
	}
	assertReleaseMetadataFiles(t, phpMetadataFamily, files)
}
