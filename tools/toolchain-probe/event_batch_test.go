package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const (
	fixturePreviousSession = `"previousId":"previous"`
	fixtureChildIndex      = `"id":1`
	fixtureRootIndex       = `"id":0`
	fixtureMessageRedacted = `"messageState":"redacted"`
	fixtureSourceLine      = `"line":42`
	fixtureUncapturedStack = `"stackFramesState":"not_captured"`
	fixtureCapturedState   = `["provider.status"]`
	fixtureParentIndex     = `"parentId":0`
	fixtureFixFile         = `"file":"src/checkout.go"`
)

const semanticBatchFixture = `{"sdk":{"name":"test","language":"go","version":"1.0.0"},"events":[{
	"id":"issue_001","type":"issue","timestamp":"2026-06-02T10:00:00Z","attributes":{
	"title":"Checkout failed","level":"error","message":"Checkout failed",
	"context":{"schemaVersion":1,"session":{"id":"current","previousId":"previous"}},
	"exception":{"type":"CheckoutError","mechanism":{"type":"manual","handled":true}},
	"stackFrames":[{"filename":"src/checkout.go","line":42,"column":7}],
	"exceptionChain":{"truncated":false,"entries":[
		{"id":0,"relationship":"reported","type":"CheckoutError","messageState":"not_captured",
		 "mechanism":{"type":"manual","handled":true},"stackFramesState":"captured",
		 "stackFrames":[{"filename":"src/checkout.go","line":42,"column":7}]},
		{"id":1,"parentId":0,"relationship":"cause","type":"ProviderError","messageState":"redacted",
		 "stackFramesState":"not_captured"}]},
	"evidence":{"likelyFixArea":{"file":"src/checkout.go","line":42,"column":7},
	 "capturedFields":["provider.status"],"missingFields":["provider.retry"],
	 "redactedFields":["provider.message"],"truncatedFields":["provider.context"]}}}]}`

func canonicalEventSchema(tb testing.TB) *checkedSchema {
	tb.Helper()
	data, readable := readCheckFile(canonicalSchemaPath)
	if !readable {
		tb.Fatal("canonical schema unavailable")
	}
	checker, err := compileCheckSchema(data)
	if err != nil {
		tb.Fatal(err)
	}
	return checker
}

func TestEventBatchRelationshipGaps(t *testing.T) {
	t.Parallel()
	checker := canonicalEventSchema(t)
	for _, item := range []struct{ name, before, after string }{
		{"same-session", fixturePreviousSession, `"previousId":"current"`},
		{"trimmed-session", fixturePreviousSession, `"previousId":" current "`},
		{"root-index", fixtureRootIndex, fixtureChildIndex},
		{"child-index", fixtureChildIndex, `"id":2`},
		{"root-parent", fixtureRootIndex, `"id":0,"parentId":0`},
		{"root-relationship", `"relationship":"reported"`, `"relationship":"cause"`},
		{"child-relationship", `"relationship":"cause"`, `"relationship":"reported"`},
		{"self-parent", fixtureParentIndex, `"parentId":1`},
		{"forward-parent", fixtureParentIndex, `"parentId":2`},
		{"missing-parent", `"parentId":0,`, ``},
		{"decimal-parent", fixtureParentIndex, `"parentId":0.0`},
		{"exponent-parent", fixtureParentIndex, `"parentId":0e0`},
		{"exception-projection", `"exception":{"type":"CheckoutError"`, `"exception":{"type":"OtherError"`},
		{"mechanism-projection", `"handled":true`, `"handled":false`},
		{"stack-projection", fixtureSourceLine, `"line":43`},
		{"frame-decimal", fixtureSourceLine, `"line":42.0`},
		{"frame-exponent", `"column":7`, `"column":7e0`},
		{"path-empty-component", fixtureFixFile, `"file":"src//checkout.go"`},
		{"path-trailing-separator", fixtureFixFile, `"file":"src/checkout.go/"`},
		{"path-windows-absolute", fixtureFixFile, `"file":"\\src\\checkout.go"`},
		{"fix-line-decimal", `"file":"src/checkout.go","line":42`, `"file":"src/checkout.go","line":42.0`},
		{
			"fix-column-exponent", `"file":"src/checkout.go","line":42,"column":7`,
			`"file":"src/checkout.go","line":42,"column":7e0`,
		},
	} {
		t.Run(item.name, func(t *testing.T) {
			t.Parallel()
			data := []byte(strings.Replace(semanticBatchFixture, item.before, item.after, 1))
			if string(data) == semanticBatchFixture {
				t.Fatal("mutation did not change the fixture")
			}
			if valid, err := checker.validate(data); !valid || err != nil {
				t.Fatalf("expected a schema-valid semantic contradiction: valid=%v error=%v", valid, err)
			}
			if valid, err := checker.validateEventBatch(data); valid || err != nil {
				t.Fatalf("contradictory evidence accepted: valid=%v error=%v", valid, err)
			}
		})
	}
}

func TestEventBatchEvidenceStatePairs(t *testing.T) {
	t.Parallel()
	checker := canonicalEventSchema(t)
	fields := []string{"provider.status", "provider.retry", "provider.message", "provider.context"}
	for first, field := range fields {
		for _, other := range fields[first+1:] {
			t.Run(field+"/"+other, func(t *testing.T) {
				t.Parallel()
				data := []byte(strings.Replace(semanticBatchFixture, other, field, 1))
				if valid, err := checker.validate(data); !valid || err != nil {
					t.Fatal("expected schema-valid overlapping evidence states")
				}
				if valid, err := checker.validateEventBatch(data); valid || err != nil {
					t.Fatal("contradictory evidence states accepted")
				}
			})
		}
	}
}

func TestEventBatchHealthyControl(t *testing.T) {
	t.Parallel()
	checker := canonicalEventSchema(t)
	for _, data := range []string{
		semanticBatchFixture,
		strings.ReplaceAll(semanticBatchFixture, fixtureRootIndex, `"id":0.0`),
		strings.ReplaceAll(semanticBatchFixture, fixtureChildIndex, `"id":1e0`),
		strings.ReplaceAll(semanticBatchFixture, fixtureFixFile, `"file":"src\\checkout.go"`),
	} {
		if valid, err := checker.validateEventBatch([]byte(data)); !valid || err != nil {
			t.Fatalf("valid rich evidence rejected: valid=%v error=%v", valid, err)
		}
	}
	// Object member order must not affect equality of the root projection.
	var document map[string]any
	if err := json.Unmarshal([]byte(semanticBatchFixture), &document); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	if valid, err := checker.validateEventBatch(data); !valid || err != nil {
		t.Fatal("member order changed the projection result")
	}
}

func TestEventBatchProjectionAndSchemaRejections(t *testing.T) {
	t.Parallel()
	checker := canonicalEventSchema(t)
	const frame = `[{"filename":"src/checkout.go","line":42,"column":7}]`
	for _, item := range []struct{ name, before, after string }{
		{"matching-decimal-frames", fixtureSourceLine, `"line":42.0`},
		{
			"nested-decimal-frame", fixtureUncapturedStack,
			`"stackFramesState":"captured","stackFrames":[{"filename":"src/cause.go","line":1.0,"column":1}]`,
		},
		{"uncaptured-root-with-legacy-stack", `"stackFramesState":"captured",` + "\n\t\t " +
			`"stackFrames":` + frame, fixtureUncapturedStack},
		{"missing-exception", `"exception":{"type":"CheckoutError","mechanism":{"type":"manual","handled":true}},`, ``},
		{"unexpected-message", fixtureMessageRedacted, `"messageState":"redacted","message":"hidden"`},
		{"missing-captured-message", fixtureMessageRedacted, `"messageState":"captured"`},
		{"missing-captured-stack", fixtureUncapturedStack, `"stackFramesState":"captured"`},
		{"bool-parent", fixtureParentIndex, `"parentId":false`},
		{"null-parent", fixtureParentIndex, `"parentId":null`},
		{"null-root-parent", fixtureRootIndex, `"id":0,"parentId":null`},
		{"bool-index", fixtureChildIndex, `"id":true`},
		{"fractional-index", fixtureChildIndex, `"id":1.00000000000000001`},
		{"negative-index", fixtureChildIndex, `"id":-1`},
		{"duplicate-state", fixtureCapturedState, `["provider.status","provider.status"]`},
		{"non-array-state", fixtureCapturedState, `{}`},
		{"invalid-state-name", fixtureCapturedState, `["bad field"]`},
		{"empty-state", fixtureCapturedState, `[]`},
		{"empty-session", fixturePreviousSession, `"previousId":""`},
		{"non-string-session", fixturePreviousSession, `"previousId":1`},
		{"absolute-path", fixtureFixFile, `"file":"/src/checkout.go"`},
		{"drive-path", fixtureFixFile, `"file":"C:\\src\\checkout.go"`},
		{"url-path", fixtureFixFile, `"file":"https://example.invalid/checkout.go"`},
		{"parent-path", fixtureFixFile, `"file":"src/../checkout.go"`},
		{"dot-path", fixtureFixFile, `"file":"src/./checkout.go"`},
		{"non-string-path", fixtureFixFile, `"file":42`},
		{"boolean-coordinate", fixtureSourceLine, `"line":true`},
		{"zero-coordinate", fixtureSourceLine, `"line":0`},
		{"large-coordinate", fixtureSourceLine, `"line":2147483648`},
	} {
		t.Run(item.name, func(t *testing.T) {
			t.Parallel()
			data := strings.ReplaceAll(semanticBatchFixture, item.before, item.after)
			if data == semanticBatchFixture {
				t.Fatal("mutation did not change the fixture")
			}
			if valid, err := checker.validateEventBatch([]byte(data)); valid || err != nil {
				t.Fatalf("invalid evidence accepted: valid=%v error=%v", valid, err)
			}
		})
	}
}

func TestEventBatchCommand(t *testing.T) {
	t.Parallel()
	input := filepath.Join(t.TempDir(), "sensitive-marker.json")
	if err := os.WriteFile(input, []byte(semanticBatchFixture), fixtureReceiptMode); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct {
		input    string
		option   string
		code     int
		valid    bool
		inputErr bool
	}{
		{input, "", exitOK, true, false},
		{canonicalValidBatch, "", exitOK, true, false},
		{input, expectInvalidOption, exitFailure, true, false},
		{"../../fixtures/invalid-batch.json", "", exitFailure, false, false},
		{"../../fixtures/invalid-batch.json", expectInvalidOption, exitOK, false, false},
		{"../../fixtures/malformed-batch.json", expectInvalidOption, exitFailure, false, true},
		{"../../fixtures/malformed-batch.json", "", exitFailure, false, true},
		{input + ".missing", "", exitFailure, false, true},
		{input + ".missing", expectInvalidOption, exitFailure, false, true},
	} {
		arguments := []string{canonicalSchemaPath, item.input}
		if item.option != "" {
			arguments = append(arguments, item.option)
		}
		var output, diagnostic bytes.Buffer
		code := checkSchema(eventBatchCheckMode, arguments, &output, &diagnostic)
		if code != item.code || (diagnostic.Len() > 0) != item.inputErr {
			t.Fatalf("wrong command state: code=%d diagnostic=%q", code, diagnostic.String())
		}
		if strings.Contains(output.String()+diagnostic.String(), "sensitive-marker") {
			t.Fatal("command reflected the input path")
		}
		if item.inputErr {
			if output.Len() != 0 {
				t.Fatal("input error produced a validation result")
			}
			continue
		}
		assertEventBatchResult(t, output.Bytes(), map[string]any{
			"scope": "event_batch", "valid": item.valid, "expected_invalid": item.option != "",
		})
	}
}

func assertEventBatchResult(t *testing.T, data []byte, expected map[string]any) {
	t.Helper()
	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil || !reflect.DeepEqual(result, expected) {
		t.Fatal("wrong event-batch result")
	}
}

func TestEventBatchCommandArguments(t *testing.T) {
	t.Parallel()
	input := canonicalValidBatch
	for _, arguments := range [][]string{
		nil,
		{input},
		{canonicalSchemaPath, input, "--json"},
		{canonicalSchemaPath, input, expectInvalidOption, "extra"},
	} {
		if checkSchema(eventBatchCheckMode, arguments, io.Discard, io.Discard) != exitUsage {
			t.Fatal("invalid arguments accepted")
		}
	}
	if checkSchema(schemaCheckMode, []string{canonicalSchemaPath, input, expectInvalidOption},
		io.Discard, io.Discard) != exitUsage {
		t.Fatal("schema-only mode accepted the semantic expectation flag")
	}
	if checkSchema(eventBatchCheckMode, []string{canonicalSchemaPath, input},
		rejectedCheckOutput{}, io.Discard) != exitFailure {
		t.Fatal("failed result write returned success")
	}
}

type rejectedCheckOutput struct{}

func (rejectedCheckOutput) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

func TestNativeValidatorOwnsFixtureContract(t *testing.T) {
	t.Parallel()
	for _, path := range []string{"../../scripts/validate_fixtures.py", "../../tests/test_validate_fixtures.py"} {
		if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("superseded validator or tests remain: %s", path)
		}
	}
}

func FuzzEventBatchJSON(f *testing.F) {
	checker := canonicalEventSchema(f)
	for _, data := range []string{
		semanticBatchFixture, `{"events":[{"type":{},"attributes":{}}]}`,
		`{"events":false}`, `{"events":[{"type":"issue","attributes":{"exceptionChain":{"entries":[null]}}}]}`,
		`{"events":[{"type":"issue","attributes":{"evidence":{"capturedFields":[{}]}}}]}`,
		`{"events":[{"type":"issue","attributes":{"stackFrames":[42]}}]}`,
		fixtureNullJSON, "1e99999", unpairedJSON,
	} {
		f.Add([]byte(data))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		valid, validationError := checker.validateEventBatch(data)
		next, nextError := checker.validateEventBatch(data)
		if valid != next || !errors.Is(validationError, nextError) {
			t.Fatal("event-batch evaluation is not deterministic")
		}
		if valid {
			if schemaValid, schemaError := checker.validate(data); !schemaValid || schemaError != nil {
				t.Fatal("semantic validation bypassed the schema")
			}
		}
	})
}
