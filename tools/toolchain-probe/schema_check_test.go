package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

const (
	canonicalSchemaPath = "../../spec/event-batch.schema.json"
	canonicalValidBatch = "../../fixtures/valid-batch.json"
	validBatchFixture   = "valid-batch.json"
	longDescriptionSize = 1025
	overflowIntegerSize = 400
)

func TestSchemaCanonicalContract(t *testing.T) {
	t.Parallel()
	checker := canonicalEventSchema(t)
	for _, name := range []string{validBatchFixture, "invalid-batch.json", "malformed-batch.json"} {
		data, readable := readCheckFile(filepath.Join("..", "..", "fixtures", name))
		if !readable {
			t.Fatal("fixture unavailable")
		}
		valid, validationError := checker.validate(data)
		var expectedError error
		if name == "malformed-batch.json" {
			expectedError = errCheckInput
		}
		if valid != (name == validBatchFixture) || !errors.Is(validationError, expectedError) {
			t.Fatalf("fixture %s: valid=%v, error=%v", name, valid, validationError)
		}
	}
}

func TestSchemaDescriptionAndFormats(t *testing.T) {
	t.Parallel()
	checker := canonicalEventSchema(t)
	const batch = `{"sdk":{"name":"test","language":"go","version":"1.0.0"},"events":[{
		"type":"metric","id":"metric_001","timestamp":"2026-06-02T10:00:00Z","attributes":{
		"name":"request.duration","kind":"histogram","value":1.25,"unit":"ms","temporality":"delta",
		"description":DESCRIPTION}}]}`
	for _, item := range []struct {
		failure     error
		description string
		valid       bool
	}{
		{nil, `"Request duration"`, true},
		{nil, `"İstek süresi 😀"`, true},
		{nil, `""`, false},
		{nil, fixtureBlankJSON, false},
		{nil, `"line\nfeed"`, false},
		{nil, `"control\u0085"`, false},
		{nil, `"separator\u2028"`, false},
		{nil, `"paragraph\u2029"`, false},
		{errCheckInput, `"surrogate\ud800"`, false},
		{nil, strconv.Quote(strings.Repeat("x", longDescriptionSize)), false},
	} {
		data := []byte(strings.Replace(batch, "DESCRIPTION", item.description, 1))
		valid, validationError := checker.validate(data)
		if valid != item.valid || !errors.Is(validationError, item.failure) {
			t.Fatalf("description: valid=%v, want %v, error=%v", valid, item.valid, validationError)
		}
	}
	data := strings.Replace(batch, "DESCRIPTION", `"duration"`, 1)
	for _, timestamp := range []string{"not-a-date", "2026-02-30T10:00:00Z", "2026-06-02T10:00:00"} {
		invalid := strings.Replace(data, "2026-06-02T10:00:00Z", timestamp, 1)
		if valid, validationError := checker.validate([]byte(invalid)); valid || validationError != nil {
			t.Fatal("invalid or timezone-free date-time accepted")
		}
	}
}

func FuzzSchemaJSON(f *testing.F) {
	checker, err := compileCheckSchema([]byte(fixtureTrueJSON))
	if err != nil {
		f.Fatal(err)
	}
	for _, data := range []string{unpairedJSON, `{"x":0,"x":1}`, "1e-999", "0e1000000", "[1,true,null]"} {
		f.Add([]byte(data))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		first, firstError := checker.validate(data)
		next, nextError := checker.validate(data)
		if first != next || !errors.Is(firstError, nextError) {
			t.Fatal("schema input parsing is not deterministic")
		}
	})
}

func TestSchemaOfflineAndInvalidConfiguration(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "external.json")
	if err := os.WriteFile(path, []byte(fixtureTrueJSON), fixtureReceiptMode); err != nil {
		t.Fatal(err)
	}
	for _, schema := range []string{
		`{"$ref":"file://` + filepath.ToSlash(path) + `"}`,
		`{"$ref":"https://example.invalid/external.json"}`,
		`{"$schema":"https://example.invalid/meta.json"}`,
		`{"type":"unknown"}`, `{"type":"string","type":"number"}`, `{"pattern":"["}`,
		`{"pattern":"` + strings.Repeat("x", schemaPatternLimit+1) + `"}`, fixtureNullJSON, "true false",
	} {
		if _, err := compileCheckSchema([]byte(schema)); !errors.Is(err, errCheckSchema) {
			t.Fatal("invalid schema or external reference accepted")
		}
	}
}

func TestSchemaJSONBoundaries(t *testing.T) {
	t.Parallel()
	checker, err := compileCheckSchema([]byte(fixtureTrueJSON))
	if err != nil {
		t.Fatal(err)
	}
	for _, data := range []string{
		`{"x":1,"x":2}`, `{"x":1,"\u0078":2}`, unpairedJSON, `"` + "\xff" + `"`,
		"NaN", "1e999999", "1e-999999", strings.Repeat("9", overflowIntegerSize), "0 1",
		strings.Repeat("[", maximumJSONDepth+2) + "0" + strings.Repeat("]", maximumJSONDepth+2),
	} {
		valid, validationError := checker.validate([]byte(data))
		if valid || !errors.Is(validationError, errCheckInput) {
			t.Fatal("invalid, ambiguous, or unbounded JSON accepted")
		}
	}
	for _, data := range []string{"0e1000000", "9007199254740993", "1.00000000000000001", `"\ud83d\ude00"`} {
		if valid, validationError := checker.validate([]byte(data)); !valid || validationError != nil {
			t.Fatalf("bounded exact JSON rejected: %v", validationError)
		}
	}
	exact, err := compileCheckSchema([]byte(`{"const":1.00000000000000001}`))
	if err != nil {
		t.Fatal(err)
	}
	if valid, validationError := exact.validate([]byte("1.0")); valid || validationError != nil {
		t.Fatal("rounded decimal matched the exact schema constant")
	}
}

func TestSchemaRegexErrorsFailClosed(t *testing.T) {
	t.Parallel()
	input, err := json.Marshal(strings.Repeat("a", 5000) + "!")
	if err != nil {
		t.Fatal(err)
	}
	for _, schema := range []string{
		`{"pattern":"^(a+)+$"}`, `{"not":{"pattern":"^(a+)+$"}}`,
		`{"if":{"pattern":"^(a+)+$"},"then":false,"else":true}`,
	} {
		checker, compileError := compileCheckSchema([]byte(schema))
		if compileError != nil {
			t.Fatal(compileError)
		}
		if valid, validationError := checker.validate(input); valid || !errors.Is(validationError, errCheckRegex) {
			t.Fatal("regex timeout was not reported as an evaluation failure")
		}
		valid, validationError := checker.validate([]byte(`"a"`))
		if valid || !errors.Is(validationError, errCheckRegex) {
			t.Fatal("checker resumed after an incomplete evaluation")
		}
	}
}

func TestSchemaCommandDiagnostics(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "sensitive-marker.json")
	if err := os.WriteFile(path, []byte(`"sensitive-marker"`), fixtureReceiptMode); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct {
		result    string
		arguments []string
		code      int
	}{
		{"", nil, exitUsage},
		{"", []string{path, path}, exitFailure},
		{"", []string{canonicalSchemaPath, path + ".missing"}, exitFailure},
		{`{"scope":"json_schema","valid":false}` + "\n", []string{canonicalSchemaPath, path}, exitFailure},
		{
			`{"scope":"json_schema","valid":true}` + "\n",
			[]string{canonicalSchemaPath, canonicalValidBatch},
			exitOK,
		},
	} {
		var output, diagnostic bytes.Buffer
		code := checkSchema(schemaCheckMode, item.arguments, &output, &diagnostic)
		if code != item.code || output.String() != item.result {
			t.Fatalf("code=%d want=%d output=%q", code, item.code, output.String())
		}
		if strings.Contains(diagnostic.String(), "sensitive-marker") || strings.Contains(diagnostic.String(), path) {
			t.Fatal("schema diagnostic reflected an input value or path")
		}
	}
}
