package main

import (
	"bytes"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestUnityMetadataCommand(t *testing.T) {
	t.Parallel()
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	var output, diagnostic bytes.Buffer
	if runReleaseMetadata([]string{unityMetadataFamily, root}, &output, &diagnostic) != exitOK ||
		diagnostic.Len() != 0 ||
		output.String() != "{\"scope\":\"unity_release_metadata\",\"valid\":true}\n" {
		t.Fatal("Unity release metadata command unavailable or receipt invalid")
	}
}

func TestUnityMetadataRequiredFiles(t *testing.T) {
	t.Parallel()
	files := map[string]string{
		unityMetadataManifest:                 repositorySource(t, unityMetadataManifest),
		unityOpenUPMMetadata:                  repositorySource(t, unityOpenUPMMetadata),
		unityMetadataPrefix + policyRootGuide: "",
	}
	assertReleaseMetadataFiles(t, unityMetadataFamily, files)
}

func TestUnityMetadataFields(t *testing.T) {
	t.Parallel()
	manifest := repositorySource(t, unityMetadataManifest)
	listing := repositorySource(t, unityOpenUPMMetadata)
	for _, field := range []string{
		pythonPublicName, pythonManifestVersion, "displayName", "description", unityMetadataFamily,
		"license", "author", "repository", "keywords", "samples",
	} {
		key := `"` + field + `":`
		for _, replacement := range []string{`"unknown":`, key + `null,` + key} {
			changed := strings.Replace(manifest, key, replacement, 1)
			if changed == manifest || validUnityMetadata([]byte(changed), []byte(listing)) {
				t.Fatalf("missing or duplicated Unity field accepted: %s", field)
			}
		}
	}
	for _, replacement := range [][2]string{
		{`"0.2.2"`, `"0.2.3"`},
		{`"2021.3"`, `"2022.3"`},
		{`"MIT"`, strconv.FormatBool(false)},
		{`"name": "LogBrew"`, `"name": []`},
		{`"type": "git"`, `"type": null`},
		{`git+https://github.com/LogBrewCo/sdk.git`, `https://example.com/repository`},
		{`"logbrew",`, `{},`},
		{`"Samples~/RealUserSmoke"`, `"Samples~/ReadmeExample"`},
		{`"path": "Samples~/ReadmeExample"`, `"path": false`},
		{`flushing LogBrew event batches.`, `flushing event batches.`},
	} {
		changed := strings.Replace(manifest, replacement[0], replacement[1], 1)
		if changed == manifest || validUnityMetadata([]byte(changed), []byte(listing)) {
			t.Fatalf("invalid Unity field accepted: %s", replacement[0])
		}
	}
}

func TestUnityListingFields(t *testing.T) {
	t.Parallel()
	manifest := []byte(repositorySource(t, unityMetadataManifest))
	listing := repositorySource(t, unityOpenUPMMetadata)
	fields := decodeFlatMetadata([]byte(listing))
	const expectedFields = 20
	if len(fields) != expectedFields {
		t.Fatalf("OpenUPM field inventory changed: %d", len(fields))
	}
	for field := range fields {
		for _, changed := range []string{
			strings.Replace(listing, field+":", "unknown_"+field+":", 1),
			listing + "\n" + field + ": null\n",
			strings.Replace(listing, field+":", field+": 'wrong'\nunknown:", 1),
		} {
			if changed == listing || validUnityMetadata(manifest, []byte(changed)) {
				t.Fatalf("missing, mistyped, or duplicate OpenUPM field accepted: %s", field)
			}
		}
	}
	for _, value := range []string{"0", "-1", fixtureTrueJSON, "'1780778637391'", "9223372036854775808", "1.5"} {
		changed := strings.Replace(listing, "1780778637391", value, 1)
		if validUnityMetadata(manifest, []byte(changed)) {
			t.Fatalf("invalid OpenUPM timestamp accepted: %s", value)
		}
	}
	changed := strings.Replace(listing, "  - integration\n  - services", "  - services\n  - integration", 1)
	if changed == listing || validUnityMetadata(manifest, []byte(changed)) {
		t.Fatal("reordered OpenUPM topics accepted")
	}
}

func TestUnityMetadataBounds(t *testing.T) {
	t.Parallel()
	manifest := []byte(repositorySource(t, unityMetadataManifest))
	listing := []byte(repositorySource(t, unityOpenUPMMetadata))
	for _, invalid := range []string{
		"", fixtureNullJSON, "[]", "{}", "{", "\xff", strings.Repeat(" ", pythonManifestLimit+1),
	} {
		if validUnityMetadata([]byte(invalid), listing) || validUnityMetadata(manifest, []byte(invalid)) {
			t.Fatal("invalid or oversized Unity input accepted")
		}
	}
}
