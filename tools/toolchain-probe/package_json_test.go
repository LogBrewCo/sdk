package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	checkSpanKind     = "span"
	wantOK            = "ok=true"
	wantFailure       = "status=500"
	wantEventName     = `attributes.name="expected"`
	wantNull          = "value=null"
	wantOne           = "value=1"
	unitCheckDocument = `{"value":1}`
	wantReplacement   = `value="�"`
	emptyCheckObject  = `{}`
	unpairedJSON      = `{"value":"\ud800"}`
)

type packageJSONCase struct {
	name, mode, document string
	expectations         []string
	valid                bool
}

func FuzzPackageJSON(f *testing.F) {
	for _, seed := range []string{
		unitCheckDocument, unpairedJSON, `prefix {"outer":{"value":1}}`, `{"events":[]}`,
	} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		for _, mode := range []string{jsonFields, jsonEventFields, jsonTrailingFields, jsonEventKinds} {
			first := checkPackageDocument(data, mode, []string{wantOne})
			if next := checkPackageDocument(data, mode, []string{wantOne}); first != next {
				t.Fatal("JSON validation is not deterministic")
			}
		}
	})
}

func TestPackageJSONContracts(t *testing.T) {
	t.Parallel()
	runPackageJSONCases(t, []packageJSONCase{
		{
			"compact kinds",
			jsonEventKinds,
			`{"events":[{"type":"span"},{"type":"issue"}]}`,
			[]string{checkSpanKind, fixtureIssueKind},
			true,
		},
		{"pretty kinds", jsonEventKinds, "{\n  \"events\": [{\"type\": \"span\"}]\n}", []string{checkSpanKind}, true},
		{
			"exact fields",
			jsonFields,
			`{"ok":true,"status":200,"path":"/health"}`,
			[]string{wantOK, "status=200", `path="/health"`},
			true,
		},
		{
			"event fields",
			jsonEventFields,
			`{"events":[
				{"attributes":{"name":"sqlite SELECT inventory"}},
				{"attributes":{"name":"memory-cache GET inventory"}}]}`,
			[]string{`attributes.name="sqlite SELECT inventory"`, `attributes.name="memory-cache GET inventory"`},
			true,
		},
		{
			"log prefix",
			jsonTrailingFields,
			"request failed {not-json}\n{\n\"status\":500,\"events\":4," +
				"\"nested\":{\"status\":200},\"message\":\"brace { inside a string\"\n}",
			[]string{wantFailure, "events=4"},
			true,
		},
	})
}

func TestPackageJSONFieldAndStreamShapes(t *testing.T) {
	t.Parallel()
	runPackageJSONCases(t, []packageJSONCase{
		{"invalid JSON", jsonEventKinds, "sensitive-marker", []string{checkSpanKind}, false},
		{
			"nonfinite", jsonEventKinds, `{"events":[{"type":"span"}],"value":NaN}`,
			[]string{checkSpanKind},
			false,
		},
		{"no events", jsonEventKinds, emptyCheckObject, []string{checkSpanKind}, false},
		{"nonarray events", jsonEventKinds, `{"events":"span"}`, []string{checkSpanKind}, false},
		{"nonstring kind", jsonEventKinds, `{"events":[{"type":1}]}`, []string{checkSpanKind}, false},
		{"missing kind", jsonEventKinds, `{"events":[{"type":"issue"}]}`, []string{checkSpanKind}, false},
		{"missing field", jsonFields, `{"status":200}`, []string{wantOK}, false},
		{"wrong field", jsonFields, `{"ok":false}`, []string{wantOK}, false},
		{"integer not bool", jsonFields, `{"ok":1}`, []string{wantOK}, false},
		{"bool not integer", jsonFields, `{"status":true}`, []string{"status=1"}, false},
		{"missing event array", jsonEventFields, emptyCheckObject, []string{wantEventName}, false},
		{"wrong event array", jsonEventFields, `{"events":"not-a-list"}`, []string{wantEventName}, false},
		{
			"wrong event value",
			jsonEventFields,
			`{"events":[{"attributes":{"name":"other"}}]}`,
			[]string{wantEventName},
			false,
		},
		{
			"wrong event type",
			jsonEventFields,
			`{"events":[{"attributes":{"name":1}}]}`,
			[]string{`attributes.name="1"`},
			false,
		},
		{
			"literal not nested key",
			jsonEventFields,
			`{"events":[{"attributes.name":"expected"}]}`,
			[]string{wantEventName},
			false,
		},
	})
}

func TestPackageJSONMissingAndTrailingValues(t *testing.T) {
	t.Parallel()
	runPackageJSONCases(t, []packageJSONCase{
		{"no trailing object", jsonTrailingFields, "sensitive-marker without JSON", []string{wantFailure}, false},
		{
			"trailing text",
			jsonTrailingFields,
			"sensitive-marker\n{\"status\":500} trailing-data",
			[]string{wantFailure},
			false,
		},
		{
			"incomplete outer object",
			jsonTrailingFields,
			"sensitive-marker\n{\"outer\":\n{\"status\":500}",
			[]string{wantFailure},
			false,
		},
		{
			"wrong trailing type", jsonTrailingFields, "sensitive-marker\n{\"status\":\"500\"}",
			[]string{wantFailure},
			false,
		},
		{"empty expectation", jsonFields, emptyCheckObject, nil, false},
		{"empty key", jsonFields, `{"":1}`, []string{"=1"}, false},
		{"malformed expected", jsonFields, unitCheckDocument, []string{"value=invalid"}, false},
		{"null field", jsonFields, `{"value":null}`, []string{wantNull}, true},
		{"missing not null", jsonFields, emptyCheckObject, []string{wantNull}, false},
		{"empty kind", jsonEventKinds, `{"events":[{"type":""}]}`, []string{""}, false},
		{"nonobject event", jsonEventFields, `{"events":[null]}`, []string{wantNull}, false},
		{
			"empty path component",
			jsonEventFields,
			`{"events":[{"attributes":{"name":"expected"}}]}`,
			[]string{`attributes..name="expected"`},
			false,
		},
	})
}

func TestPackageJSONDuplicateKeys(t *testing.T) {
	t.Parallel()
	runPackageJSONCases(t, []packageJSONCase{
		{"duplicate root", jsonFields, `{"value":0,"value":1}`, []string{wantOne}, false},
		{"escaped duplicate", jsonFields, `{"value":0,"val\u0075e":1}`, []string{wantOne}, false},
		{"duplicate nested", jsonFields, `{"value":{"ok":false,"ok":true}}`, []string{`value={"ok":true}`}, false},
		{"duplicate expectation", jsonFields, `{"value":{"ok":true}}`, []string{`value={"ok":false,"ok":true}`}, false},
	})
}

func TestPackageJSONNumbersAndText(t *testing.T) {
	t.Parallel()
	runPackageJSONCases(t, []packageJSONCase{
		{"large integer exact", jsonFields, `{"value":9007199254740993}`, []string{"value=9007199254740993"}, true},
		{"large integer distinct", jsonFields, `{"value":9007199254740993}`, []string{"value=9007199254740992"}, false},
		{"float equivalent", jsonFields, `{"value":1e0}`, []string{"value=1.00"}, true},
		{"decimal precision", jsonFields, `{"value":1.00000000000000001}`, []string{"value=1.0"}, false},
		{
			"decimal exponent equivalent", jsonFields, `{"value":100000000000000001e-17}`,
			[]string{"value=1.00000000000000001"},
			true,
		},
		{
			"float integer precision", jsonFields, `{"value":9007199254740993.0}`,
			[]string{"value=9007199254740992.0"},
			false,
		},
		{"float underflow", jsonFields, `{"value":1e-999}`, []string{"value=0.0"}, false},
		{"negative float zero", jsonFields, `{"value":-0.0}`, []string{"value=0e1000000"}, true},
		{"float not integer", jsonFields, `{"value":1.0}`, []string{wantOne}, false},
		{"negative zero", jsonFields, `{"value":-0}`, []string{"value=0"}, true},
		{"float overflow", jsonFields, `{"value":1e999}`, []string{"value=1e999"}, false},
		{
			"escaped quote",
			jsonTrailingFields,
			"log {closed}\n" + `{"value":"escaped \" { brace"}`,
			[]string{`value="escaped \" { brace"`},
			true,
		},
		{"unterminated prefix", jsonTrailingFields, `log "unterminated {"value":1}`, []string{wantOne}, false},
		{"mismatched prefix", jsonTrailingFields, `log [} {"value":1}`, []string{wantOne}, false},
		{"array suffix", jsonTrailingFields, `log [{"value":1}]`, []string{wantOne}, false},
		{"extra document", jsonFields, `{"value":1} {"value":1}`, []string{wantOne}, false},
		{"invalid UTF8", jsonFields, "{\"value\":\"\xff\"}", []string{wantReplacement}, false},
		{"surrogate not replacement", jsonFields, unpairedJSON, []string{wantReplacement}, false},
		{"low surrogate", jsonFields, `{"value":"\udc00"}`, []string{wantReplacement}, false},
		{"surrogate pair", jsonFields, `{"value":"\ud83d\ude00"}`, []string{`value="😀"`}, true},
		{"literal escape", jsonFields, `{"value":"\\ud800"}`, []string{`value="\\ud800"`}, true},
		{"unknown mode", fixtureUnknown, unitCheckDocument, []string{wantOne}, false},
	})
}

func runPackageJSONCases(t *testing.T, cases []packageJSONCase) {
	t.Helper()
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			t.Parallel()
			if got := checkPackageDocument([]byte(item.document), item.mode, item.expectations); got != item.valid {
				t.Fatalf("valid=%v, want %v", got, item.valid)
			}
		})
	}
}

func TestPackageJSONFileLimit(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "oversized.json")
	// Reviewed 2026-09-05: only this test's private directory receives the sparse fixture.
	//nolint:gosec // G304: the filename is fixed and the directory is owned by testing.T.
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	err = file.Truncate(maximumOutputFile + 1)
	closeError := file.Close()
	if err != nil || closeError != nil {
		t.Fatalf("fixture: truncate=%v close=%v", err, closeError)
	}
	var diagnostic bytes.Buffer
	if checkPackageJSON([]string{jsonFields, wantOK, path}, &diagnostic) != exitFailure {
		t.Fatal("oversized input accepted")
	}
}

func TestPackageJSONFileAndDiagnostics(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "document.json")
	if err := os.WriteFile(path, []byte(`{"ok":true}`), fixtureReceiptMode); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct {
		arguments []string
		code      int
	}{
		{[]string{jsonFields, wantOK, path}, exitOK},
		{[]string{jsonFields, "ok=false", path}, exitFailure},
		{[]string{jsonFields, wantOK, path + ".missing"}, exitFailure},
		{[]string{jsonFields, wantOK, filepath.Dir(path)}, exitFailure},
		{[]string{jsonFields}, exitUsage},
	} {
		var diagnostic bytes.Buffer
		if got := checkPackageJSON(item.arguments, &diagnostic); got != item.code {
			t.Fatalf("exit=%d, want %d", got, item.code)
		}
		if strings.Contains(diagnostic.String(), path) || strings.Contains(diagnostic.String(), fixtureTrueJSON) {
			t.Fatal("diagnostic reflected input")
		}
	}
	if err := os.WriteFile(path, []byte("sensitive-marker"), fixtureReceiptMode); err != nil {
		t.Fatal(err)
	}
	var diagnostic bytes.Buffer
	if checkPackageJSON([]string{jsonFields, wantOK, path}, &diagnostic) != exitFailure ||
		strings.Contains(diagnostic.String(), "sensitive-marker") {
		t.Fatal("invalid input did not fail without reflection")
	}
}
