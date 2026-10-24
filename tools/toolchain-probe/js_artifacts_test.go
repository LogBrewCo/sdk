package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	jsSource = "console.log(1);\n//# sourceMappingURL=app.js.map\n"
	jsMap    = `{"version":3,"sources":["src/app.ts"],"names":["boot"],"mappings":"AAAAA"}`
)

func runJS(arguments ...string) (int, map[string]any, string) {
	var output, diagnostic bytes.Buffer
	code := checkReleaseArtifacts(arguments, nil, &output, &diagnostic)
	var document map[string]any
	_ = json.Unmarshal(output.Bytes(), &document)
	if document == nil && output.Len() > 0 {
		return code, map[string]any{"text": output.String()}, diagnostic.String()
	}
	return code, document, diagnostic.String()
}

func jsBuild(t *testing.T, files map[string]string) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	writeArtifacts(t, filepath.Join(root, "dist"), files)
	return filepath.Join(root, "dist")
}

func jsField(value any, path ...any) any {
	for _, key := range path {
		switch key := key.(type) {
		case string:
			value = value.(map[string]any)[key]
		case int:
			value = value.([]any)[key]
		}
	}
	return value
}

func TestJSArtifactArguments(t *testing.T) {
	for _, arguments := range [][]string{
		{"js-prepare"}, {"js-prepare", "--build-dir", "x", "extra"}, {"js-prepare", "--build-dir", "x", "--unknown"},
		{"js-manifest", "--build-dir", "x"}, {"js-symbolicate", "--manifest", "m"}, {"js-fake-intake"},
	} {
		if code, _, diagnostic := runJS(arguments...); code != exitUsage || !strings.HasPrefix(diagnostic, "usage: ") {
			t.Fatalf("%v: %d %q", arguments, code, diagnostic)
		}
	}
	if code, document, _ := runJS("js-prepare", "-h"); code != exitOK || !strings.Contains(document["text"].(string), "--build-dir") {
		t.Fatal(code, document)
	}
}

func TestJSPrepareWritesMatchingDebugIDs(t *testing.T) {
	directory := jsBuild(t, map[string]string{"app.js": jsSource, "app.js.map": jsMap,
		"main.jsbundle": "bundle()\r\n", "main.jsbundle.map": jsMap, "notes.txt": "x", "skip.js.map": jsMap})
	code, plan, _ := runJS("js-prepare", "--build-dir", directory)
	debugID := jsField(plan, "artifacts", 0, "debugId").(string)
	if code != exitOK || plan["writeApplied"] != false || len(debugID) != 36 || debugID[14] != '5' ||
		jsField(plan, "artifacts", 1, "path") != "main.jsbundle" ||
		jsField(plan, "artifacts", 1, "validation", "warnings", 0) != "sourceMappingURL comment missing; checked sibling .map fallback" {
		t.Fatal(code, plan)
	}
	code, written, _ := runJS("js-prepare", "--build-dir", directory, "--write")
	if code != exitOK || written["writeApplied"] != true || jsField(written, "artifacts", 0, "debugId") != debugID {
		t.Fatal(code, written)
	}
	if source := readText(t, filepath.Join(directory, "app.js")); source !=
		"console.log(1);\n//# debugId="+debugID+"\n//# sourceMappingURL=app.js.map\n" {
		t.Fatal(source)
	}
	if source := readText(t, filepath.Join(directory, "main.jsbundle")); !strings.HasPrefix(source, "bundle()\n//# debugId=") {
		t.Fatal(source)
	}
	if text := readText(t, filepath.Join(directory, "app.js.map")); !strings.Contains(text, `"debug_id": "`+debugID+`"`) {
		t.Fatal(text)
	}
	if code, again, _ := runJS("js-prepare", "--build-dir", directory); code != exitOK ||
		len(jsField(again, "artifacts", 0, "changes").([]any)) != 0 {
		t.Fatal(code, again)
	}
}

func TestJSPreparePrivacyUpdates(t *testing.T) {
	directory := jsBuild(t, nil)
	source := `{"version":3,"sources":["` + directory + `/src/a.ts","` + directory + `","C:\\other\\b.ts",7],` +
		`"sourcesContent":["original"],"mappings":"AAAA","debugId":"map-id"}`
	writeArtifacts(t, directory, map[string]string{"app.js": "a()\n//# debugId=map-id\n", "app.js.map": source,
		"b.js": "b()", "b.js.map": `{"version":3,"sources":["x.ts"],"mappings":"AAAA","debug_id":"b-id"}`})
	code, plan, _ := runJS("js-prepare", "--build-dir", directory, "--write", "--strip-sources-content",
		"--strip-source-prefix", directory+"/", "--strip-source-prefix", "//double")
	if code != exitOK || jsField(plan, "artifacts", 0, "changes", 1) != "sourceMap.sources" ||
		jsField(plan, "artifacts", 1, "changes", 0) != "minifiedSource.debugId" ||
		strings.Join(stringValues(plan["stripSourcePrefixes"]), ",") != directory+",//double,/double" {
		t.Fatal(code, plan)
	}
	var written map[string]any
	_ = json.Unmarshal([]byte(readText(t, filepath.Join(directory, "app.js.map"))), &written)
	if strings.Join(stringValues(written["sources"]), ",") != `src/a.ts,dist,C:\other\b.ts` || written["sourcesContent"] != nil ||
		written["debug_id"] != nil {
		t.Fatal(written)
	}
}

func stringValues(value any) []string {
	values := []string{}
	for _, item := range value.([]any) {
		if text, isString := item.(string); isString {
			values = append(values, text)
		}
	}
	return values
}

func TestJSPrepareBlockedArtifacts(t *testing.T) {
	directory := jsBuild(t, map[string]string{
		"empty.js": "", "empty.js.map": "",
		"inline.js":   "//# sourceMappingURL=data:application/json;base64,e30=",
		"external.js": "//# sourceMappingURL=https://cdn.example/x.map", "outside.js": "//# sourceMappingURL=../../x.map",
		"missing.js": "//# sourceMappingURL=/missing.map", "mismatch.js": "//# debugId=a\n//# sourceMappingURL=m.map",
		"m.map": `{"debug_id":"b"}`, "invalid.js": "//# sourceMappingURL=i.map", "i.map": "{",
		"list.js": "//# sourceMappingURL=l.map", "l.map": "[]", "nomap.js": "x()",
		"surrogate.js": "//# sourceMappingURL=s.map", "s.map": `{"x":"\ud800"}`,
		"link.js": "//# sourceMappingURL=link.map", "link.map": symlinkPrefix + "../../x.map",
	})
	code, plan, _ := runJS("js-prepare", "--build-dir", directory)
	errors := strings.Join(stringValues(jsField(plan, "validation", "errors")), "\n")
	for _, expected := range []string{
		"empty.js: minified source file is empty", "empty.js: source map file is empty: empty.js.map",
		"inline.js: inline source maps are not accepted", "external.js: external sourceMappingURL cannot be validated",
		"outside.js: sourceMappingURL resolves outside the build directory", "missing.js: source map file is missing: missing.map",
		"mismatch.js: minified source debugId does not match", "invalid.js: source map is not valid JSON",
		"list.js: source map must be a JSON object", "nomap.js: source map file is missing",
		"surrogate.js: source map is not valid JSON",
		"link.js: sourceMappingURL resolves outside the build directory",
	} {
		if !strings.Contains(errors, expected) {
			t.Fatal(expected, errors)
		}
	}
	if code != exitFailure || plan["writeApplied"] != false {
		t.Fatal(code)
	}
}

func TestJSPrepareFailures(t *testing.T) {
	empty := jsBuild(t, map[string]string{"x.txt": ""})
	unicode := jsBuild(t, map[string]string{"app.js": jsSource, "app.js.map": "\xff"})
	address := jsBuild(t, map[string]string{"app.js": "//# sourceMappingURL=http://[x/a.map"})
	normalized := jsBuild(t, map[string]string{"app.js": "//# sourceMappingURL=http://\uff03x/a.map"})
	directory := jsBuild(t, map[string]string{"app.js": "//# sourceMappingURL=/"})
	huge := jsBuild(t, map[string]string{"app.js": jsSource, "app.js.map": `{"sources":[],"x":1e400}`})
	for _, test := range []struct {
		arguments []string
		code      int
		message   string
	}{
		{[]string{"--build-dir", "  "}, exitUsage, "debug-id preparation failed: build directory is required\n"},
		{[]string{"--build-dir", empty + "/none"}, exitUsage, "debug-id preparation failed: build directory does not exist: " + empty + "/none\n"},
		{[]string{"--build-dir", unicode}, exitUsage,
			"debug-id preparation failed: source map is not UTF-8: " + unicode + "/app.js.map\n"},
		{[]string{"--build-dir", address}, exitUsage, "debug-id preparation failed: Invalid IPv6 URL\n"},
		{[]string{"--build-dir", normalized}, exitUsage,
			"debug-id preparation failed: netloc '\uff03x' contains invalid characters under NFKC normalization\n"},
		{[]string{"--build-dir", directory}, exitFailure, "[Errno 21] Is a directory: '" + directory + "'\n"},
		{[]string{"--build-dir", huge}, exitUsage, "debug-id preparation failed: float out of range\n"},
	} {
		code, _, diagnostic := runJS(append([]string{"js-prepare"}, test.arguments...)...)
		if code != test.code || diagnostic != test.message {
			t.Fatalf("%v: %d %q", test.arguments, code, diagnostic)
		}
	}
	if code, plan, _ := runJS("js-prepare", "--build-dir", empty); code != exitFailure ||
		jsField(plan, "validation", "errors", 0) != "no JavaScript release artifact files found in build directory" {
		t.Fatal(code, plan)
	}
	unreadable := jsBuild(t, map[string]string{"app.js": jsSource, "app.js.map": jsMap})
	if err := os.Chmod(filepath.Join(unreadable, "app.js"), 0o200); err != nil {
		t.Fatal(err)
	}
	if code, _, diagnostic := runJS("js-prepare", "--build-dir", unreadable); code != exitFailure ||
		!strings.HasPrefix(diagnostic, "[Errno 13] Permission denied: '") {
		t.Fatal(code, diagnostic)
	}
}

func TestJSPrepareWriteFailures(t *testing.T) {
	for _, name := range []string{"app.js", "app.js.map"} {
		directory := jsBuild(t, map[string]string{"app.js": jsSource, "app.js.map": jsMap})
		if err := os.Chmod(filepath.Join(directory, name), 0o400); err != nil {
			t.Fatal(err)
		}
		if code, _, diagnostic := runJS("js-prepare", "--build-dir", directory, "--write"); code != exitFailure ||
			diagnostic != "[Errno 13] Permission denied: '"+filepath.Join(directory, name)+"'\n" {
			t.Fatal(name, code, diagnostic)
		}
	}
	// a.js is also the source map of b.js; writing its debug ID breaks that map.
	shared := `{"version":3,"sources":["x"],"mappings":"AAAA","note":"//# sourceMappingURL=c.map "}`
	directory := jsBuild(t, map[string]string{"a.js": shared, "c.map": jsMap, "b.js": "//# sourceMappingURL=a.js"})
	if code, _, diagnostic := runJS("js-prepare", "--build-dir", directory, "--write"); code != exitUsage ||
		diagnostic != "debug-id preparation failed: b.js: source map became unreadable before write\n" {
		t.Fatal(code, diagnostic)
	}
}

func jsManifestArguments(directory string, extra ...string) []string {
	return append([]string{"js-manifest", "--build-dir", directory, "--release", " 1.0 ", "--environment", "production",
		"--service", "web", "--minified-path-prefix", "https://cdn.example/assets?cache=x#y"}, extra...)
}

func TestJSManifest(t *testing.T) {
	directory := jsBuild(t, map[string]string{"app.js": "//# debugId=js-id\n" + jsSource,
		"app.js.map": `{"version":3,"sources":["a"],"mappings":"AAAA","sourcesContent":["s"],"debugId":"js-id"}`,
		"sub/b.mjs":  "b()", "sub/b.mjs.map": `{"version":null,"sources":"a","mappings":""}`,
		"sub/c.js": "//# debugId=x", "sub/c.js.map": `{"version":3,"sources":["a"],"mappings":"A","debug_id":"y"}`})
	code, manifest, _ := runJS(jsManifestArguments(directory, "--repository-url", " https://git.example/r ", "--commit-sha", "abc")...)
	errors := strings.Join(stringValues(jsField(manifest, "validation", "errors")), "\n")
	if code != exitFailure || manifest["release"] != "1.0" || manifest["minifiedPathPrefix"] != "https://cdn.example/assets" ||
		jsField(manifest, "git", "repositoryUrl") != "https://git.example/r" ||
		jsField(manifest, "artifacts", 0, "minifiedSource", "minifiedUrl") != "https://cdn.example/assets/app.js" ||
		jsField(manifest, "artifacts", 0, "sourceMap", "debugId") != "js-id" ||
		jsField(manifest, "artifacts", 1, "sourceMap", "sourceCount") != 0.0 ||
		!strings.Contains(errors, "app.js: source map contains sourcesContent; rerun") ||
		!strings.Contains(errors, "sub/b.mjs: source map version is required") ||
		!strings.Contains(errors, "sub/b.mjs: source map sources must be a non-empty array") ||
		!strings.Contains(errors, "sub/b.mjs: source map mappings must be a non-empty string") ||
		!strings.Contains(errors, "sub/c.js: minified source debugId does not match source map debugId") {
		t.Fatal(code, manifest)
	}
	code, manifest, _ = runJS(jsManifestArguments(directory, "--allow-sources-content")...)
	if code != exitFailure || jsField(manifest, "artifacts", 0, "validation", "status") != "ready" ||
		jsField(manifest, "artifacts", 0, "validation", "warnings", 0) !=
			"source map contains sourcesContent; ensure app policy permits source upload" ||
		jsField(manifest, "artifacts", 1, "validation", "warnings", 1) !=
			"no debugId found; backend matching must rely on release/environment/service and minified path" {
		t.Fatal(code, manifest)
	}
	missing := jsBuild(t, map[string]string{"app.js": "x"})
	if code, manifest, _ := runJS(jsManifestArguments(missing)...); code != exitFailure ||
		jsField(manifest, "artifacts", 0, "sourceMap") != nil {
		t.Fatal(code, manifest)
	}
	for _, test := range []struct{ argument, message string }{
		{"--release=", "manifest validation failed: release is required\n"},
		{"--minified-path-prefix= ", "manifest validation failed: minified path prefix is required\n"},
		{"--minified-path-prefix=http://[x", "manifest validation failed: Invalid IPv6 URL\n"},
		{"--build-dir=" + missing + "/none", "manifest validation failed: build directory does not exist: " + missing + "/none\n"},
	} {
		if code, _, diagnostic := runJS(jsManifestArguments(missing, test.argument)...); code != exitUsage || diagnostic != test.message {
			t.Fatal(test.argument, code, diagnostic)
		}
	}
	unicode := jsBuild(t, map[string]string{"app.js": jsSource, "app.js.map": "\xff"})
	if code, _, diagnostic := runJS(jsManifestArguments(unicode)...); code != exitUsage ||
		diagnostic != "manifest validation failed: source map is not UTF-8: "+unicode+"/app.js.map\n" {
		t.Fatal(code, diagnostic)
	}
}

func TestJSURLPrefixes(t *testing.T) {
	for _, test := range []struct{ prefix, url string }{
		{"https://cdn.example", "https://cdn.example/a/b.js"}, {"https://cdn.example//x/../y/./", "https://cdn.example//y/a/b.js"},
		{"app:///", "app:///a/b.js"}, {"app://", "app:///a/b.js"}, {"APP:///x", "APP:///x/a/b.js"}, {"/static/", "/static/a/b.js"},
		{"static?x", "static/a/b.js"}, {"/", "a/b.js"}, {"app:///.", "app:///a/b.js"},
	} {
		if url := joinURLOrPath(test.prefix, "a/b.js"); url != test.url {
			t.Fatal(test.prefix, url)
		}
	}
	if url := joinURLOrPath("https://h", `\x.js`); url != "https://h/x.js" {
		t.Fatal(url)
	}
}

func jsSymbolicateArguments(directory, manifest, frame string) []string {
	return []string{"js-symbolicate", "--build-dir", directory, "--manifest", manifest, "--stack-frame", frame}
}

func TestJSSymbolicate(t *testing.T) {
	directory := jsBuild(t, map[string]string{"app.js": "//# debugId=id\n" + jsSource,
		"app.js.map": `{"version":3,"sources":["src/a.ts"],"names":["boot"],"mappings":"AAAAA,EAAA;AAAA","debug_id":"id"}`})
	manifestPath := filepath.Join(filepath.Dir(directory), "manifest.json")
	var output bytes.Buffer
	checkReleaseArtifacts(jsManifestArguments(directory)[0:1], nil, &output, &output)
	output.Reset()
	checkReleaseArtifacts(jsManifestArguments(directory), nil, &output, &output)
	writeArtifacts(t, filepath.Dir(directory), map[string]string{"manifest.json": output.String()})
	for _, frame := range []string{"at boot (https://cdn.example/assets/app.js:1:1)", "app.js:1:1", directory + "/app.js:1:2",
		"file://" + directory + "/app.js?x:1:1"} {
		code, report, _ := runJS(jsSymbolicateArguments(directory, manifestPath, frame)...)
		if code != exitOK || report["status"] != "resolved" || jsField(report, "original", "source") != "src/a.ts" ||
			jsField(report, "generated", "line") != 1.0 {
			t.Fatal(frame, code, report)
		}
	}
	code, report, _ := runJS(jsSymbolicateArguments(directory, manifestPath, "at boot (app.js:1:3)")...)
	if code != exitOK || jsField(report, "generated", "function") != "boot" || jsField(report, "original", "name") != nil ||
		jsField(report, "original", "column") != 1.0 {
		t.Fatal(code, report)
	}
	if code, report, _ := runJS(jsSymbolicateArguments(directory, manifestPath, "app.js:1:9_9")...); code != exitOK ||
		jsField(report, "generated", "column") != 99.0 {
		t.Fatal(code, report)
	}
}

func TestJSSymbolicateFailures(t *testing.T) {
	directory := jsBuild(t, map[string]string{"app.js": jsSource, "app.js.map": jsMap})
	root := filepath.Dir(directory)
	ready := func(artifact string) string {
		return `{"artifactType":"javascript_source_map_manifest","validation":{"status":"ready"},"artifacts":[` + artifact + `]}`
	}
	artifact := func(sourceMap string) string {
		return `{"validation":{"status":"ready"},"debugId":"id","minifiedSource":{"path":"app.js"},"sourceMap":` + sourceMap + `}`
	}
	maps := map[string]string{
		"content.map": `{"sourcesContent":[]}`, "debug.map": `{"debugId":"other"}`, "sources.map": `{"sources":[]}`,
		"mappings.map": `{"sources":["a"]}`, "vlq.map": `{"sources":["a"],"mappings":"!"}`,
		"open.map": `{"sources":["a"],"mappings":"g"}`, "fields.map": `{"sources":["a"],"mappings":"AA"}`,
		"short.map": `{"sources":["a"],"mappings":"A"}`, "empty.map": `{"sources":["a"],"mappings":";A"}`, "index.map": `{"sources":["a"],"mappings":"ACAA"}`,
		"value.map": `{"sources":[" "],"mappings":"AAAA"}`, "file.map": `{"sources":["file:///a"],"mappings":"AAAA"}`,
		"windows.map": `{"sources":["C:\\a"],"mappings":"AAAA"}`, "url.map": `{"sources":["http://[x"],"mappings":"AAAA"}`,
		"bad.map": "[", "list.map": "[]",
	}
	writeArtifacts(t, directory, maps)
	cases := map[string]string{
		"{":  "manifest is not valid JSON",
		"[]": "manifest must be a JSON object",
		"{}": "only javascript_source_map_manifest symbolication proof is supported",
		`{"artifactType":"javascript_source_map_manifest"}`: "manifest validation status must be ready",
		ready(""):   "manifest must contain at least one JavaScript source-map artifact",
		ready("1"):  "artifact entries must be JSON objects",
		ready("{}"): "all artifact validation statuses must be ready",
		ready(`{"validation":{"status":"ready"}}`): "no manifest artifact matches the minified stack frame filename",
		ready(artifact("null")):                    "matched artifact is missing source map metadata",
		ready(artifact(`{"path":"/etc/hosts"}`)):   "source map path resolves outside the build directory",
		ready(artifact(`{"path":"none.map"}`)):     "[Errno 2] No such file or directory: '" + directory + "/none.map'",
	}
	for name, message := range map[string]string{
		"content.map": "source map still contains sourcesContent; strip it before symbolication proof",
		"debug.map":   "matched artifact debug ID does not match source map debug ID",
		"sources.map": "source map sources must be a non-empty array", "mappings.map": "source map mappings must be a non-empty string",
		"vlq.map":     "source map mappings contain an invalid base64 VLQ character",
		"open.map":    "source map mappings contain an unterminated base64 VLQ value",
		"fields.map":  "source map segment must contain 1, 4, or 5 VLQ fields",
		"short.map":   "no original source mapping found for generated frame",
		"empty.map":   "no original source mapping found for generated frame",
		"index.map":   "source map segment references an invalid source index",
		"value.map":   "source map segment references an invalid source value",
		"file.map":    "source map source path must be stripped before symbolication proof",
		"windows.map": "source map source path must be stripped before symbolication proof", "url.map": "Invalid IPv6 URL",
		"bad.map":  "manifest is not valid JSON",
		"list.map": "manifest must be a JSON object",
	} {
		cases[ready(artifact(`{"path":"`+name+`"}`))] = message
	}
	for manifest, message := range cases {
		writeArtifacts(t, root, map[string]string{"manifest.json": manifest})
		code, report, _ := runJS(jsSymbolicateArguments(directory, filepath.Join(root, "manifest.json"), "app.js:1:1")...)
		if code != exitFailure || jsField(report, "validation", "errors", 0) != message {
			t.Fatal(manifest, code, report)
		}
	}
	writeArtifacts(t, root, map[string]string{"good.json": ready(artifact(`{"path":"app.js.map"}`)), "bad.json": "\xff",
		"other.json":  ready(`{"validation":{"status":"ready"},"minifiedSource":1},` + artifact(`{"path":"app.js.map"}`)),
		"number.json": ready(`{"validation":{"status":"ready"},"minifiedSource":{"path":5},"sourceMap":{"path":"app.js.map"}}`)})
	if code, report, _ := runJS(jsSymbolicateArguments(directory, filepath.Join(root, "number.json"), "5:1:1")...); code != exitOK ||
		jsField(report, "generated", "path") != 5.0 {
		t.Fatal(code, report)
	}
	for _, test := range []struct{ manifest, directory, frame, message string }{
		{"none.json", directory, "a:1:1", "[Errno 2] No such file or directory: '" + root + "/none.json'"},
		{"bad.json", directory, "a:1:1", "manifest is not UTF-8: " + root + "/bad.json"},
		{"good.json", root + "/none", "a:1:1", "build directory does not exist: " + root + "/none"},
		{"good.json", directory, "app.js:1", "stack frame must end with :line:column"},
		{"good.json", directory, "app.js:x:1", "stack frame line and column must be integers"},
		{"good.json", directory, "app.js:0:1", "stack frame line and column must be one-based positive integers"},
		{"good.json", directory, "app.js:2:1", "generated line is outside source map mappings"},
		{"other.json", directory, "/elsewhere.js:1:1", "no manifest artifact matches the minified stack frame filename"},
	} {
		code, report, _ := runJS(jsSymbolicateArguments(test.directory, filepath.Join(root, test.manifest), test.frame)...)
		if code != exitFailure || jsField(report, "validation", "errors", 0) != test.message {
			t.Fatal(test, code, report)
		}
	}
	if text := pyIntText("-0_0"); text != "0" {
		t.Fatal(text)
	}
	if text := pyIntText(" -１2 "); text != "-12" {
		t.Fatal(text)
	}
}

func TestJSFakeIntake(t *testing.T) {
	root := t.TempDir()
	portFile, stateFile := filepath.Join(root, "port"), filepath.Join(root, "state.json")
	done := make(chan int)
	go func() {
		_, _, _ = runJS("js-fake-intake", "--port-file", portFile, "--state-file", stateFile, "--expected-bearer", "token",
			"--source-sentinel", "SENTINEL", "--query-placeholder", "cache=x", "--hash-fragment", "frag")
		close(done)
	}()
	for !pyExists(portFile) || readText(t, portFile) == "" {
		time.Sleep(10 * time.Millisecond)
	}
	statuses := []int{}
	for _, test := range []struct{ route, token string }{{"/retry-success?q=1", "token"}, {"/retry-success", "x"},
		{"/retry-success", "token"}, {"/other", "token"}} {
		request, _ := http.NewRequest(http.MethodPost, "http://127.0.0.1:"+readText(t, portFile)+test.route,
			strings.NewReader(`javascript_source_map_manifest name="source_map_0" `+root))
		request.Header.Set("Authorization", "Bearer "+test.token)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		statuses = append(statuses, response.StatusCode)
	}
	if err := os.Remove(portFile); err != nil {
		t.Fatal(err)
	}
	<-done
	var state map[string]any
	_ = json.Unmarshal([]byte(readText(t, stateFile)), &state)
	event := jsField(state, "events", 0).(map[string]any)
	if strings.Trim(strings.Join(strings.Fields(strings.Trim(strings.ReplaceAll(strings.Join([]string{
		http.StatusText(statuses[0]), http.StatusText(statuses[1]), http.StatusText(statuses[2]), http.StatusText(statuses[3])},
		","), " ", ""), ",")), ""), " ") != "ServiceUnavailable,Unauthorized,Accepted,NotFound" ||
		event["path"] != "/retry-success" || event["containsManifest"] != true || event["containsTempPath"] != true ||
		event["containsSourceMapPart"] != true || event["containsMinifiedPart"] != false || event["authorized"] != true {
		t.Fatal(statuses, state)
	}
	if code, _, diagnostic := runJS("js-fake-intake", "--port-file", root+"/none/port", "--state-file", "state.json",
		"--expected-bearer", "t", "--source-sentinel", "s", "--query-placeholder", "q", "--hash-fragment", "h"); code != exitFailure ||
		!strings.Contains(diagnostic, "no such file or directory") {
		t.Fatal(code, diagnostic)
	}
}

func TestPyRealpath(t *testing.T) {
	root := jsBuild(t, map[string]string{"real/x/file": "", "loop1": symlinkPrefix + "loop2",
		"loop2": symlinkPrefix + "loop1"})
	if err := os.Symlink(filepath.Join(root, "real"), filepath.Join(root, "abs")); err != nil {
		t.Fatal(err)
	}
	t.Chdir(root)
	for path, want := range map[string]string{"abs/x": "real/x", "abs/../abs/x": "real/x", "loop1/x": "loop1/x",
		"abs/x/../../abs": "real", "rel": "rel"} {
		if resolved, err := pyRealpath(path); err != nil || resolved != root+"/"+want {
			t.Fatal(path, resolved, err)
		}
	}
	if _, err := pyRealpath("a\x00"); err == nil || err.Error() != "embedded null byte" {
		t.Fatal(err)
	}
}
