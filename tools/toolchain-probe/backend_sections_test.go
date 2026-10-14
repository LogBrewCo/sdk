package main

import "testing"

func TestBackendReportSectionBoundaries(t *testing.T) {
	t.Parallel()
	document := "# Report\n## Status\nPending\n### Detail\nNested detail\n## Priority\nP1\n# Other\nExcluded\n"
	sections := backendReportSections(document)
	if sections["Status"] != "Pending\n### Detail\nNested detail" || sections["Priority"] != "P1" {
		t.Fatalf("report sections = %v", sections)
	}
}

func TestBackendReportSectionOverwriteAndWhitespace(t *testing.T) {
	t.Parallel()
	document := "##\u00a0Status\t\nEarlier\n## Status\nLater\n## Priority\n\t\n"
	sections := backendReportSections(document)
	priority, present := sections["Priority"]
	if sections["Status"] != "Later" || !present || priority != "" {
		t.Fatalf("duplicate or empty report sections = %v", sections)
	}
}
