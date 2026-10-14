package main

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"
)

func TestSourceMetadataCommands(t *testing.T) {
	t.Parallel()
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	for _, family := range []string{"c", "cpp", "objc", "swift", "root", "go", "ruby"} {
		var output, diagnostic bytes.Buffer
		if runReleaseMetadata([]string{family, root}, &output, &diagnostic) != exitOK || diagnostic.Len() != 0 ||
			output.String() != `{"scope":"`+family+`_release_metadata","valid":true}`+"\n" {
			t.Errorf("%s metadata command unavailable or receipt invalid", family)
		}
	}
}

func TestSourceMetadataRequiredFiles(t *testing.T) {
	t.Parallel()
	for family, policy := range sourceMetadataPolicies() {
		files := make(map[string]string)
		for _, name := range policy.files {
			files[policy.prefix+name] = ""
		}
		for name := range policy.text {
			files[policy.prefix+name] = repositorySource(t, policy.prefix+name)
		}
		for name := range policy.patterns {
			files[policy.prefix+name] = repositorySource(t, policy.prefix+name)
		}
		assertReleaseMetadataFiles(t, family, files)
	}
}

func TestSourceMetadataDeclarations(t *testing.T) {
	t.Parallel()
	for _, policy := range sourceMetadataPolicies() {
		for name, required := range policy.text {
			data := repositorySource(t, policy.prefix+name)
			assertMetadataPhrases(t, data, required)
		}
	}
}

func TestMetadataTextBounds(t *testing.T) {
	t.Parallel()
	const phrase = "required"
	for _, invalid := range []string{"", phrase + "\xff", strings.Repeat(" ", pythonManifestLimit) + phrase} {
		if validMetadataText([]byte(invalid), []string{phrase}) {
			t.Fatal("empty, malformed, or oversized metadata text accepted")
		}
	}
}

func assertMetadataPhrases(t *testing.T, data string, required []string) {
	t.Helper()
	for _, phrase := range required {
		changed := strings.ReplaceAll(data, phrase, "")
		if changed == data || validMetadataText([]byte(changed), required) {
			t.Fatalf("metadata mutation %s did not apply or was accepted", phrase)
		}
	}
}

func TestSourceMetadataPolicyInventory(t *testing.T) {
	t.Parallel()
	const (
		cHeaderRequirements    = 14
		cppHeaderRequirements  = 31
		cGuideRequirements     = 12
		cppGuideRequirements   = 32
		sourceOnlyFiles        = 11
		objcHeaderRequirements = 22
		objcGuideRequirements  = 16
		objcSourceFiles        = 19
		swiftSourceFiles       = 13
		swiftGuideRequirements = 7
	)
	for _, test := range []struct {
		counts map[string]int
		policy sourceMetadataPolicy
		files  int
	}{
		{map[string]int{
			"include/logbrew.h": cHeaderRequirements, policyRootGuide: cGuideRequirements,
		}, cMetadataPolicy(), sourceOnlyFiles},
		{map[string]int{
			"include/logbrew.hpp": cppHeaderRequirements, policyRootGuide: cppGuideRequirements,
			"examples/trace_correlation.cpp": 3,
		}, cppMetadataPolicy(), sourceOnlyFiles},
		{map[string]int{
			"include/LogBrew.h": objcHeaderRequirements, policyRootGuide: objcGuideRequirements, "src/LogBrew.m": 1,
		}, objcMetadataPolicy(), objcSourceFiles},
		{map[string]int{
			swiftMetadataManifest: 9, swiftMetadataPrefix + swiftMetadataManifest: 8,
			swiftMetadataPrefix + policyRootGuide: swiftGuideRequirements,
		}, swiftMetadataPolicy(), swiftSourceFiles},
		{map[string]int{"LICENSE": 1}, sourceMetadataPolicies()[rootMetadataFamily], 1},
	} {
		if len(test.policy.files) != test.files || len(test.policy.text) != len(test.counts) {
			t.Fatal("required source metadata file inventory changed")
		}
		for name, count := range test.counts {
			phrases := test.policy.text[name]
			unique := make(map[string]bool)
			for _, phrase := range phrases {
				unique[phrase] = true
			}
			if len(phrases) != count || len(unique) != count || unique[""] {
				t.Fatalf("%s declaration inventory changed or contains empty/duplicate requirements", name)
			}
		}
	}
}
