package main

import (
	"strings"
	"testing"
)

func TestPublicationWorkflowPinnedControl(t *testing.T) {
	t.Parallel()
	source := repositorySource(t, reconciliationWorkflowPath)
	source = strings.ReplaceAll(source, `python3 "$control_script"`, nativeProbeInvocation+" publication-run")
	for _, mutation := range []struct{ old, replacement string }{
		{"ref: " + workflowControlRef, "ref: main"},
		{
			protectedNativeUses,
			"if: false\n        " + protectedNativeUses,
		},
		{
			nativeProbeInvocation + " publication-run",
			nativeProbeInvocation + " publication-run; " + nativeProbeInvocation + " publication-run",
		},
		{"PUBLICATION_WORKFLOW_SHA: ${{ inputs.publication_workflow_sha }}", "PUBLICATION_WORKFLOW_SHA: unbound"},
	} {
		candidate := strings.ReplaceAll(source, mutation.old, mutation.replacement)
		for _, family := range []string{registryPythonFamily, nugetJobName} {
			if publicationWorkflowNative([]byte(candidate), family) {
				t.Fatalf("publication workflow accepted changed %q", mutation.old)
			}
		}
	}
}
