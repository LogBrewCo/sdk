package main

import (
	"io"
	"strings"
	"testing"
)

func TestPublicationRunReceipt(t *testing.T) {
	t.Parallel()
	identity := publicationHTTPIdentity()
	for _, passed := range []bool{true, false} {
		var output strings.Builder
		code := writePublicationRunReceipt(&output, &publicationRunResult{identity: identity, passed: passed})
		if (code == exitOK) != passed || !strings.Contains(output.String(), `"run_id":42`) ||
			strings.Contains(output.String(), "authorization") {
			t.Fatal("publication receipt lost identity, result or confidentiality")
		}
	}
	result := publicationRunResult{identity: identity, passed: true}
	if writePublicationRunReceipt(rejectedCheckOutput{}, &result) != exitFailure {
		t.Fatal("failed publication receipt write passed")
	}
	if runPublicationRun(nil, io.Discard, io.Discard) != exitUsage {
		t.Fatal("missing publication options accepted")
	}
}
