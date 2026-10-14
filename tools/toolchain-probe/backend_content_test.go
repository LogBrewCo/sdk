package main

import (
	"strings"
	"testing"
)

func TestBackendReportArtifactEvidenceBoundaries(t *testing.T) {
	t.Parallel()
	report := repositorySource(t, backendReportDirectory+"/release-artifact-symbolication-2026-06-13.md")
	for _, required := range []string{
		"React Native-shaped Android mapping/native `.so`", "iOS `.xcarchive/dSYMs`",
		"auth-gated release-artifact upload, lookup, byte retention, " +
			"and one-frame JavaScript symbolication are deployed",
		"real hosted minified/native symbolicated-error proof",
		"native/mobile hosted upload support remain incomplete",
		"explicit JavaScript release-artifact hosted upload opt-in",
	} {
		if !strings.Contains(report, required) {
			t.Fatalf("artifact report lost evidence boundary: %q", required)
		}
	}
	if strings.Contains(report, "no backend release-artifact route/schema/lookup surface") {
		t.Fatal("artifact report reverted verified route availability")
	}
}

func TestBackendReportSupportNetworkBoundary(t *testing.T) {
	t.Parallel()
	report := repositorySource(t, backendReportDirectory+"/support-ticket-routes-2026-06-24.md")
	for _, required := range []string{
		"code-level verified locally but not deploy/live verified", "redacted post-deploy live verifier",
		"does not clear SDK network-call gating", "SDKs must not call `POST /api/support/tickets`",
		"explicit local diagnostics draft",
	} {
		if !strings.Contains(report, required) {
			t.Fatalf("support report lost network boundary: %q", required)
		}
	}
}
