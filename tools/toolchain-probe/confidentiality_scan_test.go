package main

import (
	"context"
	"encoding/json"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestConfidentialityScanEvidence(t *testing.T) {
	t.Parallel()
	root := confidentialityFixture(t, map[string]string{
		"empty.txt":                "",
		confidentialityFixturePath: "first\r\n" + confidentialityFixtureTerm + "\u2028third\n",
		confidentialityGuide:       "Read " + confidentialityHomeRoot + "example/project.\n" + confidentialityFixtureTerm,
		policyRootGuide:            "public integration\nrun tests\n",
	})
	report := scanConfidentiality(t.Context(), root)
	expected := []confidentialityFinding{
		{Path: confidentialityGuide, Line: 1, Rule: confidentialityGuideRule},
		{Path: confidentialityGuide, Line: 2, Rule: confidentialityContentRule},
		{Path: policyRootGuide, Line: 2, Rule: confidentialityReadmeRule},
		{Path: confidentialityFixturePath, Line: 2, Rule: confidentialityContentRule},
	}
	if report.Status != confidentialityFailed || report.FailureCode != "" ||
		report.SchemaVersion != 1 || report.FilesTotal != 4 || report.FilesScanned != 4 ||
		report.BytesScanned <= 0 || !slices.Equal(report.Findings, expected) {
		t.Fatalf("incorrect scan receipt: %+v", report)
	}
	data, err := json.Marshal(report)
	if err != nil || strings.Contains(string(data), confidentialityFixtureTerm) ||
		strings.Contains(string(data), confidentialityHomeRoot+"example/project") {
		t.Fatal("receipt echoed source content")
	}
}

func TestConfidentialityScanPublicGuides(t *testing.T) {
	t.Parallel()
	const expectedFiles = 6
	root := confidentialityFixture(t, map[string]string{
		confidentialityGuide:        "Run focused package checks.",
		confidentialityPackageGuide: "Use current package types.",
		confidentialityNestedGuide:  "Read the sibling guide.",
		"CONTRIBUTING.md":           "Read " + confidentialityHomeRoot + "example/project.",
		"assets/brand/carrier.svg":  confidentialityFixtureTerm,
		"empty.txt":                 "",
	})
	report := scanConfidentiality(t.Context(), root)
	if report.Status != confidentialityPassed || report.FilesTotal != expectedFiles ||
		report.FilesScanned != expectedFiles || report.FailureCode != "" || len(report.Findings) != 0 {
		t.Fatalf("public fixture rejected: %+v", report)
	}
}

func TestConfidentialityScanIgnoredGuides(t *testing.T) {
	t.Parallel()
	root := confidentialityFixture(t, map[string]string{
		confidentialityIgnoreFile:  "AGENTS.override.md\nplans/\nignored.txt\n",
		"AGENTS.override.md":       confidentialityFixtureTerm,
		confidentialityPlanFixture: confidentialityFixtureTerm,
		confidentialityIgnoredPath: confidentialityFixtureTerm,
		confidentialityGuide:       "Use focused package checks.",
	})
	fixtureGit(t, root, confidentialityGitInit)
	report := scanConfidentiality(t.Context(), root)
	if report.Status != confidentialityPassed || len(report.Findings) != 0 ||
		report.FilesScanned != 2 || report.FilesTotal != 2 {
		t.Fatalf("ignored local guidance changed scope: %+v", report)
	}
}

func TestConfidentialityScanRejectsGuideContent(t *testing.T) {
	t.Parallel()
	files := map[string]string{
		confidentialityGuide: confidentialityFixtureTerm, confidentialityPackageGuide: confidentialityFixtureTerm,
		confidentialityNestedGuide: confidentialityFixtureTerm,
	}
	root := confidentialityFixture(t, files)
	fixtureGit(t, root, confidentialityGitInit)
	report := scanConfidentiality(t.Context(), root)
	if report.Status != confidentialityFailed || report.FailureCode != "" || len(report.Findings) != len(files) {
		t.Fatal("tracked root and nested guides must retain content checks")
	}
	for _, finding := range report.Findings {
		_, exists := files[finding.Path]
		if !exists || finding.Line != 1 || finding.Rule != confidentialityContentRule {
			t.Fatalf("unexpected guide finding: %+v", finding)
		}
	}
}

func TestConfidentialityScanFailures(t *testing.T) {
	t.Parallel()
	root := confidentialityFixture(t, map[string]string{})
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	for _, report := range []confidentialityReport{
		scanConfidentiality(t.Context(), filepath.Join(root, "absent-root")),
		scanConfidentiality(cancelled, root),
	} {
		if report.Status != confidentialityUnavailable || report.FailureCode == "" {
			t.Fatalf("unavailable input was accepted: %+v", report)
		}
	}
}

func TestConfidentialityPolicySourceScope(t *testing.T) {
	t.Parallel()
	exempt := []string{
		"tools/toolchain-probe/confidentiality_exact.go",
		"tools/toolchain-probe/confidentiality_fragments.go",
		"tools/toolchain-probe/confidentiality_policy.go",
		"tools/toolchain-probe/confidentiality_runtime.go",
		"tools/toolchain-probe/confidentiality_support.go",
		"tools/toolchain-probe/confidentiality_text.go",
	}
	checked := []string{
		"tools/toolchain-probe/confidentiality_policy_test.go",
		"tools/toolchain-probe/confidentiality_other.go",
		"nested/confidentiality_policy.go",
	}
	files := make(map[string]string)
	for _, name := range slices.Concat(exempt, checked) {
		files[name] = confidentialityFixtureTerm
	}
	root := confidentialityFixture(t, files)
	report := scanConfidentiality(t.Context(), root)
	if report.Status != confidentialityFailed || report.FilesTotal != len(files) ||
		report.FilesScanned != len(checked) || !slices.Equal(report.PolicySourcesExcluded, exempt) ||
		len(report.Findings) != len(checked) {
		t.Fatalf("self-reference scope or coverage is incorrect: %+v", report)
	}
	for _, finding := range report.Findings {
		if !slices.Contains(checked, finding.Path) || finding.Rule != confidentialityContentRule {
			t.Fatal("a neighboring file was exempted")
		}
	}
}
