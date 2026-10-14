package main

import (
	"bytes"
	"encoding/json"
	"io"
	"testing"
)

func TestRegistryReceipt(t *testing.T) {
	t.Parallel()
	results := []registryCheckResult{
		{
			family: registryNPMFamily, label: jsMetadataCore, passed: true,
			expected: []string{registryDefaultVersion},
			outcome: registryOutcome{
				reason: "fixture", status: 0, attempts: 1, passed: true,
			},
		},
		{
			family: registryPythonFamily, label: pythonCoreID, passed: false,
			expected: []string{registryDefaultVersion},
			outcome: registryOutcome{
				reason: "fixture", status: 0, attempts: 1, passed: false,
			},
		},
	}
	for _, complete := range []bool{false, true} {
		output := new(bytes.Buffer)
		if writeRegistryReceipt(output, results, len(results), complete) != exitFailure {
			t.Fatal("failed check reported success")
		}
		receipt := new(registryReceipt)
		if err := json.Unmarshal(output.Bytes(), receipt); err != nil {
			t.Fatal(err)
		}
		if receipt.Passed || receipt.Complete != complete || len(receipt.Checks) != len(results) ||
			receipt.Checks[1].Package != pythonCoreID ||
			receipt.Checks[1].ExpectedVersions[0] != registryDefaultVersion {
			t.Fatal("receipt lost outcome")
		}
	}
	results[1].passed = true
	output := new(bytes.Buffer)
	if writeRegistryReceipt(output, results, len(results), true) != exitOK {
		t.Fatal("complete passing checks failed")
	}
	for _, expected := range []int{-1, 0, len(results) + 1} {
		if writeRegistryReceipt(io.Discard, results, expected, true) != exitFailure {
			t.Fatal("mismatched check count accepted")
		}
	}
	if writeRegistryReceipt(registryFailingWriter{}, results, len(results), true) != exitFailure {
		t.Fatal("write error accepted")
	}
}

type registryFailingWriter struct{}

func (registryFailingWriter) Write(_ []byte) (int, error) { return 0, io.ErrClosedPipe }
