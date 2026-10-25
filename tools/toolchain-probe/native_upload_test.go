package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
)

type uploadFixture struct {
	root, manifest string
	document       map[string]any
}

func digestText(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// newUploadFixture writes a mapping file, a symbols directory, and a ready
// manifest for both.
func newUploadFixture(t *testing.T) uploadFixture {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{"mapping.txt": "a -> b\n", "symbols/lib/a.so": "elf-a", "symbols/lib/b.so": "elf-bb"}
	writeArtifacts(t, filepath.Join(root, "artifacts"), files)
	tree := sha256.New()
	for _, name := range []string{"symbols/lib/a.so", "symbols/lib/b.so"} {
		fmt.Fprintf(tree, "%s\x00%s\x00%d\x00", name, digestText(files[name]), len(files[name]))
	}
	ready := map[string]any{"status": "ready"}
	document := map[string]any{
		"artifactType": "native_debug_symbol_manifest", "validation": ready, "release": "1.0.0",
		"environment": "production", "service": "checkout",
		"artifacts": []any{
			map[string]any{"artifactType": "android_proguard_mapping", "path": "mapping.txt", "validation": ready,
				"artifactSha256": digestText(files["mapping.txt"]), "byteSize": 7, "fileCount": 1},
			map[string]any{"artifactType": "android_native_symbols", "path": "symbols", "validation": ready,
				"artifactSha256": hex.EncodeToString(tree.Sum(nil)), "byteSize": 11, "fileCount": 2},
		},
	}
	fixture := uploadFixture{filepath.Join(root, "artifacts"), filepath.Join(root, "manifest.json"), document}
	fixture.write(t, func(map[string]any, map[string]any) {})
	return fixture
}

// write saves the manifest after change edits it and its first artifact.
func (fixture uploadFixture) write(t *testing.T, change func(manifest, artifact map[string]any)) {
	t.Helper()
	var copied map[string]any
	data, _ := json.Marshal(fixture.document)
	_ = json.Unmarshal(data, &copied)
	change(copied, copied["artifacts"].([]any)[0].(map[string]any))
	data, _ = json.Marshal(copied)
	if err := os.WriteFile(fixture.manifest, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func (fixture uploadFixture) arguments(endpoint string, extra ...string) []string {
	return append([]string{"native-upload", "--artifact-root", fixture.root, "--manifest", fixture.manifest,
		"--endpoint", endpoint, "--retry-delay", "0"}, extra...)
}

func runUpload(arguments ...string) (int, map[string]any, string) {
	var output, diagnostic bytes.Buffer
	code := checkReleaseArtifacts(arguments, nil, &output, &diagnostic)
	var document map[string]any
	_ = json.Unmarshal(output.Bytes(), &document)
	if document == nil {
		document = map[string]any{"text": output.String()}
	}
	return code, document, diagnostic.String()
}

// intake answers each upload with the next status and records the requests.
type intake struct {
	mutex    sync.Mutex
	statuses []int
	requests []*http.Request
	parts    [][]string
}

func (server *intake) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	server.mutex.Lock()
	defer server.mutex.Unlock()
	_, parameters, _ := mime.ParseMediaType(request.Header.Get("Content-Type"))
	reader := multipart.NewReader(request.Body, parameters["boundary"])
	parts := []string{}
	for part, err := reader.NextPart(); err == nil; part, err = reader.NextPart() {
		data, _ := io.ReadAll(part)
		parts = append(parts, part.FormName()+"|"+part.FileName()+"|"+part.Header.Get("Content-Type")+"|"+string(data))
	}
	server.requests, server.parts = append(server.requests, request), append(server.parts, parts)
	writer.Header().Set("Location", "/moved")
	writer.WriteHeader(server.statuses[min(len(server.requests), len(server.statuses))-1])
}

func startIntake(t *testing.T, statuses ...int) (*intake, string) {
	server := &intake{statuses: statuses}
	listener := httptest.NewServer(server)
	t.Cleanup(listener.Close)
	return server, listener.URL
}

func TestNativeUploadArguments(t *testing.T) {
	fixture := newUploadFixture(t)
	for _, arguments := range [][]string{
		{"native-upload", "--manifest", "m", "--endpoint", "e"},
		fixture.arguments("http://127.0.0.1/", "--max-retries", "x"),
		fixture.arguments("http://127.0.0.1/", "--max-retries", "-1"),
		fixture.arguments("http://127.0.0.1/", "--retry-delay", "x"),
		fixture.arguments("http://127.0.0.1/", "--timeout", "-1"),
		fixture.arguments("http://127.0.0.1/", "--retry-delay", "-0.5"),
		fixture.arguments("http://127.0.0.1/", "extra"),
		{"native-upload", "--bogus"},
	} {
		if code, _, diagnostic := runUpload(arguments...); code != exitUsage || diagnostic != nativeUploadUsage {
			t.Errorf("%v: %d %q", arguments, code, diagnostic)
		}
	}
	if code, document, _ := runUpload("native-upload", "--help"); code != exitOK || document["text"] != nativeUploadUsage {
		t.Errorf("help: %d %v", code, document)
	}
	if !strings.Contains(releaseArtifactsUsage, "native-upload") {
		t.Error("usage does not name native-upload")
	}
}

func TestNativeUploadDryRunAndAuth(t *testing.T) {
	fixture := newUploadFixture(t)
	t.Setenv(uploadTokenDefault, "")
	code, document, _ := runUpload(fixture.arguments("HTTP://LocalHost:080/v1/upload?q=1#f", "--dry-run")...)
	want := map[string]any{"status": "dry_run", "dryRun": true, "endpoint": "http://localhost:80/v1/upload",
		"attempts": []any{}, "retryCount": 0.0, "artifactCount": 2.0, "filePartCount": 3.0, "totalArtifactBytes": 18.0,
		"artifactTypes": []any{"android_proguard_mapping", "android_native_symbols"}, "release": "1.0.0",
		"environment": "production", "service": "checkout", "artifactType": "native_debug_symbol_manifest",
		"uploader": map[string]any{"name": nativeUploader, "version": jsArtifactVersion}}
	if code != exitOK || fmt.Sprint(document) != fmt.Sprint(want) {
		t.Errorf("dry run: %d %v", code, document)
	}
	for endpoint, want := range map[string]string{"http://[::1%EtH0]/": "http://::1%EtH0/", "https://u@127.0.0.1": "https://127.0.0.1/"} {
		if code, document, _ := runUpload(fixture.arguments(endpoint)...); code != 2 || document["status"] != "auth_missing" ||
			document["endpoint"] != want {
			t.Errorf("%s: %d %v", endpoint, code, document)
		}
	}
}

func TestNativeUploadSendsFilesAndRetries(t *testing.T) {
	fixture := newUploadFixture(t)
	t.Setenv("CUSTOM_TOKEN", " token \n")
	server, endpoint := startIntake(t, 503, 202)
	code, document, _ := runUpload(fixture.arguments(endpoint+"/upload", "--token-env", "CUSTOM_TOKEN", "--retry-delay", "1e-9")...)
	attempts := fmt.Sprint(document["attempts"])
	if code != exitOK || document["status"] != "uploaded" || document["retryCount"] != 1.0 ||
		attempts != "[map[attempt:1 httpStatus:503 result:retryable_error] map[attempt:2 httpStatus:202 result:uploaded]]" {
		t.Fatalf("upload: %d %v", code, document)
	}
	request := server.requests[0]
	manifest, _ := pyJSONText(fixture.document, "")
	want := []string{"manifest|manifest.json|application/json|" + strings.TrimSuffix(manifest, "\n"),
		"artifact_0_file_0|mapping.txt|application/octet-stream|a -> b\n",
		"artifact_1_file_0|a.so|application/octet-stream|elf-a", "artifact_1_file_1|b.so|application/octet-stream|elf-bb"}
	if request.Header.Get("Authorization") != "Bearer token" || request.Header.Get("Accept-Encoding") != "identity" ||
		request.Header.Get("User-Agent") != "logbrew-release-artifact-verifier/0.1.0" ||
		fmt.Sprint(server.parts[1]) != fmt.Sprint(want) {
		t.Errorf("request: %v %v", request.Header, server.parts[1])
	}
}

func TestNativeUploadResults(t *testing.T) {
	fixture := newUploadFixture(t)
	t.Setenv(uploadTokenDefault, "token")
	for _, test := range []struct {
		statuses []int
		code     int
		status   string
		attempts int
	}{
		{[]int{204}, exitOK, "uploaded", 1},
		{[]int{401}, 3, "auth_failed", 1},
		{[]int{403}, 3, "auth_failed", 1},
		{[]int{400}, 4, "validation_failed", 1},
		{[]int{413}, 4, "validation_failed", 1},
		{[]int{404}, 5, "upload_failed", 1},
		{[]int{302}, 5, "upload_failed", 1},
		{[]int{408, 429, 500}, 5, "retryable_error", 3},
	} {
		_, endpoint := startIntake(t, test.statuses...)
		code, document, _ := runUpload(fixture.arguments(endpoint)...)
		if code != test.code || document["status"] != test.status || len(document["attempts"].([]any)) != test.attempts {
			t.Errorf("%v: %d %v", test.statuses, code, document)
		}
	}
	listener := httptest.NewServer(http.NotFoundHandler())
	listener.Close()
	// A refused connection and a zero timeout fail without a status.
	for extra, want := range map[string]int{"--max-retries=1": 2, "--timeout=0": 3} {
		code, document, _ := runUpload(fixture.arguments(listener.URL, extra)...)
		attempts, _ := document["attempts"].([]any)
		if code != 5 || len(attempts) != want || fmt.Sprint(attempts[0]) != "map[attempt:1 result:retryable_error]" {
			t.Errorf("%s: %d %v", extra, code, document)
		}
	}
	for _, extra := range [][]string{{"--timeout", "1e10"}, {"--timeout", "nan"}, {"--retry-delay", "inf"}} {
		_, endpoint := startIntake(t, 503)
		if code, _, diagnostic := runUpload(fixture.arguments(endpoint, extra...)...); code != exitFailure ||
			!strings.HasPrefix(diagnostic, "invalid ") {
			t.Errorf("%v: %d %q", extra, code, diagnostic)
		}
	}
}

func TestNativeUploadReadFailure(t *testing.T) {
	defer func() {
		if stop, _ := recover().(nativeStop); stop.code != exitFailure || !strings.Contains(stop.message, "No such file") {
			t.Errorf("stop: %v", stop)
		}
	}()
	uploadWithRetries(uploadOptions{}, nil, "token", map[string]any{}, [][2]string{{"part", "/missing/file"}})
}

func TestNativeUploadValidation(t *testing.T) {
	fixture := newUploadFixture(t)
	writeArtifacts(t, fixture.root, map[string]string{"empty/": "", "link": symlinkPrefix + "symbols",
		"linked/file": "x", "linked/file2": symlinkPrefix + "file"})
	if err := syscall.Mkfifo(filepath.Join(fixture.root, "fifo"), 0o600); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		change func(manifest, artifact map[string]any)
		want   string
	}{
		{func(manifest, _ map[string]any) { manifest["artifactType"] = "other" }, "only native_debug_symbol_manifest"},
		{func(manifest, _ map[string]any) { manifest["validation"] = "ready" }, "manifest validation status must be ready"},
		{func(manifest, _ map[string]any) { manifest["artifacts"] = []any{} }, "at least one native/mobile"},
		{func(manifest, _ map[string]any) { manifest["artifacts"] = []any{1} }, "artifact entries must be JSON objects"},
		{func(_, artifact map[string]any) { artifact["path"] = "" }, "artifact is missing path"},
		{func(_, artifact map[string]any) { delete(artifact, "fileCount") }, "artifact is missing fileCount"},
		{func(_, artifact map[string]any) { artifact["validation"] = nil }, "validation status must be ready: mapping.txt"},
		{func(_, artifact map[string]any) { artifact["path"] = "link/lib/a.so" }, "uses a symbolic link: link/lib/a.so"},
		{func(_, artifact map[string]any) { artifact["path"] = "../manifest.json" }, "resolves outside the artifact root"},
		{func(_, artifact map[string]any) { artifact["path"] = "a\x00b" }, "resolves outside the artifact root"},
		{func(_, artifact map[string]any) { artifact["path"] = 5 }, "artifact path is missing: 5"},
		{func(_, artifact map[string]any) { artifact["path"] = "fifo" }, "neither a file nor directory: fifo"},
		{func(_, artifact map[string]any) { artifact["path"] = "empty" }, "contains no regular files: empty"},
		{func(_, artifact map[string]any) { artifact["path"] = "linked" }, "contains a symbolic link: linked/file2"},
		{func(_, artifact map[string]any) { artifact["fileCount"] = 1.5 }, "missing valid fileCount"},
		{func(_, artifact map[string]any) { artifact["fileCount"] = -1 }, "missing valid fileCount"},
		{func(_, artifact map[string]any) { artifact["fileCount"] = "1" }, "missing valid fileCount"},
		{func(_, artifact map[string]any) { artifact["fileCount"] = json.Number("-0") }, "file count changed"},
		{func(_, artifact map[string]any) { artifact["byteSize"] = json.Number("1e3") }, "missing valid byteSize"},
		{func(_, artifact map[string]any) { artifact["byteSize"] = json.Number("99999999999999999999") }, "byte size changed"},
		{func(_, artifact map[string]any) { artifact["artifactSha256"] = 5 }, "sha256 changed after manifest creation"},
		{func(_, artifact map[string]any) { artifact["path"] = fixture.root + "/mapping.txt" }, ""},
	}
	for index, test := range cases {
		fixture.write(t, test.change)
		code, document, diagnostic := runUpload(fixture.arguments("http://127.0.0.1/", "--dry-run")...)
		errorsText := fmt.Sprint(document["validation"])
		if test.want == "" && code != exitOK || test.want != "" && (code != exitFailure || !strings.Contains(errorsText, test.want)) {
			t.Errorf("case %d: %d %v %q", index, code, document, diagnostic)
		}
	}
	fixture.write(t, func(map[string]any, map[string]any) {})
	for _, test := range []struct {
		arguments []string
		want      string
	}{
		{[]string{"native-upload", "--artifact-root", fixture.root + "/missing", "--manifest", fixture.manifest,
			"--endpoint", "http://127.0.0.1/"}, "artifact root does not exist: " + fixture.root + "/missing"},
		{fixture.arguments("http://example.com/"), "must be loopback-only"},
		{fixture.arguments("ftp://127.0.0.1/"), "must be loopback-only"},
		{fixture.arguments("http://127.0.0.2.example/"), "must be loopback-only"},
	} {
		if code, document, _ := runUpload(test.arguments...); code != exitFailure ||
			!strings.Contains(fmt.Sprint(document["validation"]), test.want) || document["status"] != "validation_failed" {
			t.Errorf("%v: %d %v", test.arguments, code, document)
		}
	}
	for endpoint, want := range map[string]string{
		"http://[bad/": "Invalid IPv6 URL\n", "http://127.0.0.1:x1/": "Port could not be cast to integer value as 'x1'\n",
		"http://127.0.0.1:65536/": "Port out of range 0-65535\n", "http://127.0.0.1:99999999999999999999/": "Port out of range 0-65535\n",
	} {
		if code, _, diagnostic := runUpload(fixture.arguments(endpoint)...); code != exitFailure || diagnostic != want {
			t.Errorf("%s: %d %q", endpoint, code, diagnostic)
		}
	}
	for text, want := range map[string]string{"[]": "must be a JSON object", "{": "is not valid JSON", "\xff": "is not UTF-8"} {
		if err := os.WriteFile(fixture.manifest, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
		code, document, diagnostic := runUpload(fixture.arguments("http://127.0.0.1/")...)
		if code != exitFailure || !strings.Contains(fmt.Sprint(document["validation"])+diagnostic, want) {
			t.Errorf("%q: %d %v %q", text, code, document, diagnostic)
		}
	}
	if code, _, diagnostic := runUpload(fixture.arguments("http://127.0.0.1/")[:4]...); code != exitUsage || diagnostic == "" {
		t.Errorf("missing manifest: %d %q", code, diagnostic)
	}
	_ = os.Remove(fixture.manifest)
	if code, _, diagnostic := runUpload(fixture.arguments("http://127.0.0.1/")...); code != exitFailure ||
		!strings.Contains(diagnostic, "No such file") {
		t.Errorf("missing manifest: %d %q", code, diagnostic)
	}
}
