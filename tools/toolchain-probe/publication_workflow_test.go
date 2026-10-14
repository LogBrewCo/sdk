package main

import (
	"strings"
	"testing"
)

func TestPublicationWorkflowNativeBoundary(t *testing.T) {
	t.Parallel()
	source := repositorySource(t, reconciliationWorkflowPath)
	pythonCaller := strings.ReplaceAll(source, nativeProbeInvocation+" publication-run", `python3 "$control_script"`)
	for _, family := range []string{registryPythonFamily, nugetJobName} {
		if publicationWorkflowNative([]byte(pythonCaller), family) {
			t.Fatal("Python publication caller accepted as native")
		}
		candidate := source
		if !publicationWorkflowNative([]byte(candidate), family) {
			t.Fatal("native publication candidate rejected")
		}
		candidate = strings.ReplaceAll(candidate, `--source-sha "$RELEASE_SOURCE_SHA"`, "--source-sha unbound")
		if publicationWorkflowNative([]byte(candidate), family) {
			t.Fatal("unbound publication source accepted")
		}
	}
}
