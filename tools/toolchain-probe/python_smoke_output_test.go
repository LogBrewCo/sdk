package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPythonPublicSmokeFailureDiagnostics(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "failure.json")
	t.Setenv("LOGBREW_PYTHON_DIAGNOSTICS", filename)
	run := pythonSmokeRun{
		checker: nil, wheels: nil, layouts: nil, commandElapsed: []int64{10},
		directory: "", uv: "", pip: "", python: "",
		options:   pythonSmokeOptions{versions: nil, manifest: "", artifacts: "", receipt: false},
		installer: pythonConsumerOutput{stdout: nil, stderr: nil, valid: false},
		last: pythonConsumerOutput{
			stdout: bytes.Repeat([]byte("x"), pythonConsumerLimit), stderr: nil, valid: false,
		},
		bindingElapsed: time.Millisecond, runtimeElapsed: time.Millisecond,
	}
	if !run.writeDiagnostics("installed runtime evidence", pythonConsumerTimeout, true) {
		t.Fatal("private failure receipt unavailable")
	}
	info, err := os.Stat(filename)
	if err != nil || info.Mode().Perm() != fixtureReceiptMode {
		t.Fatal("failure receipt is not owner-only")
	}
	data, readable := readCheckFile(filename)
	if !readable || !checkPackageDocument(data, jsonFields, []string{
		`scope="python_consumer_execution"`, `stage="installed runtime evidence"`, "untrusted_output=true",
		`installer={"stdout":"","stderr":"","truncated":false}`,
		"truncated=true", "deadline_exceeded=true", "elapsed_ms=20000",
		"command_elapsed_ms=[10]", "runtime_elapsed_ms=1", "binding_elapsed_ms=1",
	}) {
		t.Fatal("failure receipt lost timing, stage, or output-truncation evidence")
	}
	value, decoded := decodeCheckDocument(data)
	stdout, isString := eventObject(value)["stdout"].(string)
	if !decoded || !isString || len(stdout) != 64<<10 {
		t.Fatal("private failure output did not obey its fixed bound")
	}
	t.Setenv("LOGBREW_PYTHON_DIAGNOSTICS", filepath.Join(t.TempDir(), "missing", "failure.json"))
	if run.writeDiagnostics("failed", 0, false) {
		t.Fatal("unavailable diagnostic destination reported as written")
	}
}

func TestPythonPublicSmokeReceiptContract(t *testing.T) {
	t.Parallel()
	run := pythonSmokeRun{
		checker: nil, wheels: nil, layouts: nil, commandElapsed: nil, directory: "", uv: "", pip: "", python: "",
		options:   pythonSmokeOptions{versions: nil, manifest: "", artifacts: "", receipt: true},
		installer: pythonConsumerOutput{stdout: nil, stderr: nil, valid: true},
		last:      pythonConsumerOutput{stdout: nil, stderr: nil, valid: true}, bindingElapsed: 0, runtimeElapsed: 0,
	}
	for _, spec := range pythonReleaseCatalog() {
		run.wheels = append(run.wheels, pythonSmokeWheel{
			id: spec.id, version: pythonSmokeFixtureCore, filename: "",
			receipt: pythonArchiveReceipt{
				Scope: "", SHA256: strings.Repeat("a", 64), ContentSHA256: "", Files: 0, Valid: true,
			},
		})
	}
	var output bytes.Buffer
	if run.writeReceipt(&output) != exitOK {
		t.Fatal("receipt write failed")
	}
	var receipt map[string]json.RawMessage
	if err := json.Unmarshal(output.Bytes(), &receipt); err != nil || len(receipt) != 3 ||
		!checkPackageDocument(output.Bytes(), jsonFields, []string{"schema_version=1", `status="passed"`}) {
		t.Fatal("receipt mode changed the established three-field contract")
	}
	value, decoded := decodeCheckDocument(output.Bytes())
	artifacts, array := eventObject(value)["artifacts"].([]any)
	if !decoded || !array || len(artifacts) != 4 {
		t.Fatal("receipt artifact count changed")
	}
	for index, id := range strings.Fields("logbrew-sdk logbrew-fastapi logbrew-flask logbrew-django") {
		entry := eventObject(artifacts[index])
		if entry["id"] != "pypi:"+id || entry["digest"] != "sha256:"+strings.Repeat("a", 64) {
			t.Fatal("receipt identity, order, or digest changed")
		}
	}
	if run.writeReceipt(rejectedCheckOutput{}) != exitFailure {
		t.Fatal("failed receipt output reported success")
	}
}
