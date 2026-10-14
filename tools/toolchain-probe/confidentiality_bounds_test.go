package main

import (
	"os"
	"strings"
	"testing"
)

func TestConfidentialityScanLimits(t *testing.T) {
	t.Parallel()
	for _, test := range []struct{ name, body, code string }{
		{"line bytes", strings.Repeat("x", confidentialityLineLimit+1), "line_limit"},
		{"line count", strings.Repeat("\n", confidentialityLineCountLimit+1), "line_limit"},
		{
			"findings", strings.Repeat(confidentialityFixtureTerm+"\n", confidentialityFindingLimit+1),
			"finding_limit",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			root := confidentialityFixture(t, map[string]string{confidentialityFixturePath: test.body})
			report := scanConfidentiality(t.Context(), root)
			if report.Status != confidentialityUnavailable || report.FailureCode != test.code ||
				report.FilesTotal != 1 || report.FilesScanned != 0 || report.BytesScanned != 0 {
				t.Fatalf("limit was not reported as incomplete: %+v", report)
			}
			if test.name == "findings" && len(report.Findings) != confidentialityFindingLimit {
				t.Fatal("bounded findings were lost")
			}
		})
	}
}

func TestConfidentialityScanEncoding(t *testing.T) {
	t.Parallel()
	body := "pass" + string([]byte{0xff}) + "word"
	for _, name := range []string{confidentialityFixturePath, policyRootGuide} {
		root := confidentialityFixture(t, map[string]string{name: body})
		report := scanConfidentiality(t.Context(), root)
		if name == policyRootGuide {
			if report.Status != confidentialityUnavailable || report.FailureCode != "readme_encoding_invalid" {
				t.Fatal("malformed README did not fail closed")
			}
		} else if report.Status != confidentialityFailed || report.FilesScanned != 1 ||
			len(report.Findings) != 1 || report.Findings[0].Rule != confidentialityContentRule {
			t.Fatal("non-README decoding no longer matches ignored invalid bytes")
		}
	}
}

func TestConfidentialityScanFileByteLimit(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	root, err := os.OpenRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	file, err := root.OpenFile("oversized.txt", os.O_CREATE|os.O_EXCL|os.O_RDWR, fixtureReceiptMode)
	if err != nil {
		t.Fatal(err)
	}
	truncateError := file.Truncate(maximumOutputFile + 1)
	closeError := file.Close()
	rootError := root.Close()
	if truncateError != nil || closeError != nil || rootError != nil {
		t.Fatalf("fixture failed: %v %v %v", truncateError, closeError, rootError)
	}
	report := scanConfidentiality(t.Context(), directory)
	if report.Status != confidentialityUnavailable || report.FailureCode != "file_read_or_size_limit" ||
		report.FilesScanned != 0 {
		t.Fatalf("oversized file did not fail closed: %+v", report)
	}
}

func TestConfidentialityScanPlanningEvidence(t *testing.T) {
	t.Parallel()
	root := confidentialityFixture(t, map[string]string{
		confidentialityPlanFixture: "task state", "CLAUDE.md": "guide",
		confidentialityResearchDir + "/transport.md": "source notes",
	})
	report := scanConfidentiality(t.Context(), root)
	if report.Status != confidentialityFailed || len(report.Findings) != 3 {
		t.Fatalf("planning paths did not fail: %+v", report)
	}
	for _, finding := range report.Findings {
		if finding.Rule != confidentialityPlanningRule || finding.Line != 0 {
			t.Fatalf("planning finding has an invented source location: %+v", finding)
		}
	}
}

func TestConfidentialityLineSequenceStops(t *testing.T) {
	t.Parallel()
	lines := 0
	for range confidentialityLineSeq("first\r\nsecond\nthird") {
		lines++
		break
	}
	if lines != 1 {
		t.Fatal("line iterator ignored cancellation by its consumer")
	}
}

func TestConfidentialityRemainingByteBudget(t *testing.T) {
	t.Parallel()
	const body = "public SDK"
	directory := confidentialityFixture(t, map[string]string{confidentialityFixturePath: body})
	root, err := os.OpenRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if closeError := root.Close(); closeError != nil {
			t.Fatal(closeError)
		}
	}()
	for _, remaining := range []int64{int64(len(body)), int64(len(body) - 1), 0} {
		report := scanConfidentiality(t.Context(), confidentialityFixture(t, nil))
		report.BytesScanned = confidentialityByteLimit - remaining
		before := report.BytesScanned
		code := report.scanFile(t.Context(), root, newConfidentialityPolicy(), confidentialityFixturePath)
		if remaining == int64(len(body)) {
			if code != "" || report.BytesScanned != confidentialityByteLimit || report.FilesScanned != 1 {
				t.Fatal("exact aggregate budget rejected a complete file")
			}
		} else if code != "file_read_or_size_limit" || report.BytesScanned != before || report.FilesScanned != 0 {
			t.Fatal("aggregate exhaustion counted an unread file or exceeded its bound")
		}
	}
}
