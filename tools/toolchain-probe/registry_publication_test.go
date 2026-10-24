package main

import (
	"bytes"
	"errors"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"testing/iotest"
)

const (
	npmSDK      = "https://registry.npmjs.org/%40logbrew%2Fsdk"
	nugetCore   = "https://api.nuget.org/v3-flatcontainer/logbrew/index.json"
	mavenSDK    = "https://repo1.maven.org/maven2/co/logbrew/logbrew-sdk/maven-metadata.xml"
	cratesIndex = "https://index.crates.io/lo/gb/logbrew"
)

// fakeRegistry serves each URL's responses in order, repeating the last; a
// missing URL is a 404, status 0 a transport error, and status -1 a body
// that fails to read.
type fakeRegistry struct {
	responses map[string][]registryReply
	calls     map[string]int
}

type registryReply struct {
	status int
	body   string
}

func (registry *fakeRegistry) RoundTrip(request *http.Request) (*http.Response, error) {
	address := request.URL.String()
	replies := registry.responses[address]
	if len(replies) == 0 {
		replies = []registryReply{{http.StatusNotFound, ""}}
	}
	reply := replies[min(registry.calls[address], len(replies)-1)]
	registry.calls[address]++
	body := io.NopCloser(strings.NewReader(reply.body))
	switch reply.status {
	case 0:
		return nil, errors.New("connection refused")
	case -1:
		reply.status, body = http.StatusOK, io.NopCloser(iotest.ErrReader(errors.New("connection reset")))
	}
	return &http.Response{StatusCode: reply.status, Body: body, Header: http.Header{}, Request: request}, nil
}

func runRegistry(responses map[string][]registryReply, arguments ...string) (int, string, string, float64) {
	now := 0.0
	var output, diagnostic bytes.Buffer
	code := checkRegistryPublication(arguments, &fakeRegistry{responses, map[string]int{}},
		func(seconds float64) { now += seconds }, func() float64 { return now }, &output, &diagnostic)
	return code, output.String(), diagnostic.String(), now
}

func ok(body string) []registryReply { return []registryReply{{http.StatusOK, body}} }

func TestRegistryPublicationUsage(t *testing.T) {
	if code, output, _, _ := runRegistry(nil, "-h"); code != exitOK || output != registryUsage {
		t.Fatalf("help = %d, %q", code, output)
	}
	plan := filepath.Join(t.TempDir(), "plan.json")
	for _, arguments := range [][]string{{"--bogus"}, {"extra"}, {"--target", "nope"}, {"--timeout", "x"},
		{"--retry-delay", "0x10"}, {"--max-wait-seconds", "1__0"}, {"--retries", "1.5"}, {"--npm-package", "left-pad"},
		{"--maven-artifact", "x"}, {"--maven-plan", plan, "--maven-plan-scope", "all"}} {
		if code, output, diagnostic, _ := runRegistry(nil, arguments...); code != exitUsage || output != "" ||
			diagnostic != registryUsage {
			t.Errorf("%v = %d, %q, %q", arguments, code, output, diagnostic)
		}
	}
	for arguments, message := range map[string]string{
		"--target pypi --npm-package @logbrew/sdk":      "--npm-package requires --target npm or --target all",
		"--target pypi --require-npm-provenance":        "--require-npm-provenance requires --target npm or --target all",
		"--target npm --pypi-version logbrew-sdk=1":     "--pypi-version requires --target pypi or --target all",
		"--target npm --nuget-version LogBrew=1":        "--nuget-version requires --target nuget or --target all",
		"--target nuget --target nuget --expect-absent": "--expect-absent requires exactly --target nuget or --target maven",
		"--target npm --maven-artifact logbrew-sdk":     "--maven-artifact requires --target maven or --target all",
		"--target npm --maven-version co.logbrew:x=1":   "--maven-version requires --target maven or --target all",
		"--target npm --maven-plan " + plan:             "--maven-plan requires --target maven or --target all",
		"--maven-plan-scope selected":                   "--maven-plan and --maven-plan-scope must be used together",
		"--maven-plan p --maven-plan-scope selected --maven-artifact logbrew-sdk": "--maven-plan cannot be combined " +
			"with Maven artifact or version overrides",
		"--target maven --expect-absent":                             "Maven --expect-absent requires the selected Maven release plan",
		"--npm-version @logbrew/sdk":                                 "expected npm package version in name=version form, got '@logbrew/sdk'",
		"--pypi-version x=1":                                         "unknown PyPI package: x",
		"--nuget-version LogBrew=1 --nuget-version \u3000LogBrew=2":  "duplicate NuGet package: LogBrew",
		"--maven-version co.logbrew:logbrew-sdk=":                    "expected Maven package version in name=version form, got 'co.logbrew:logbrew-sdk='",
		"--require-released-package-set":                             "released package verification requires exact npm and NuGet maps",
		"--target npm --target nuget --require-released-package-set": "released package verification requires exact npm and NuGet maps",
		"--maven-plan " + plan + " --maven-plan-scope selected":      "invalid Maven release plan: FileNotFoundError",
	} {
		code, _, diagnostic, _ := runRegistry(nil, strings.Fields(arguments)...)
		if want := registryUsage + "registry-publication: error: " + message + "\n"; code != exitUsage || diagnostic != want {
			t.Errorf("%s = %d, %q", arguments, code, diagnostic)
		}
	}
	original := releaseCatalogText
	releaseCatalogText = "["
	defer func() { releaseCatalogText = original }()
	if code, _, diagnostic, _ := runRegistry(nil); code != exitFailure || !strings.HasPrefix(diagnostic, "release catalog") {
		t.Fatalf("broken catalog = %d, %q", code, diagnostic)
	}
}

func TestRegistryMavenPlan(t *testing.T) {
	directory := t.TempDir()
	write := func(text string) string {
		path := filepath.Join(directory, "plan.json")
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	entry := `{"artifactId": "logbrew-kotlin", "coordinate": "co.logbrew:logbrew-kotlin", "version": "1.0.0"}`
	for text, message := range map[string]string{
		"{":                                      "invalid Maven release plan: JSONDecodeError",
		`{"schemaVersion": 2}`:                   "invalid Maven release plan schema",
		`[]`:                                     "invalid Maven release plan schema",
		`{"schemaVersion": true}`:                "invalid Maven release plan selected",
		`{"schemaVersion": 1.0, "selected": []}`: "Maven release plan has no selected artifacts",
		`{"schemaVersion": 1, "selected": [1]}`:  "invalid Maven release plan selected",
		`{"schemaVersion": 1, "selected": [` + entry + `, ` + entry + `]}`: "invalid Maven release plan selected",
	} {
		code, _, diagnostic, _ := runRegistry(nil, "--target", "maven", "--maven-plan", write(text), "--maven-plan-scope",
			"selected")
		if code != exitUsage || !strings.HasSuffix(diagnostic, "error: "+message+"\n") {
			t.Errorf("%s = %d, %q", text, code, diagnostic)
		}
	}
	if code, _, diagnostic, _ := runRegistry(nil, "--maven-plan", write("\xff"), "--maven-plan-scope", "selected"); code !=
		exitFailure || diagnostic != "Maven release plan is not UTF-8\n" {
		t.Fatalf("binary plan = %d, %q", code, diagnostic)
	}
	path := write(`{"schemaVersion": 1, "selected": [` + entry + `], "externalDependencies": []}`)
	metadata := ok("<metadata><versioning><versions><version>1.0.0</version></versions></versioning></metadata>")
	responses := map[string][]registryReply{"https://repo1.maven.org/maven2/co/logbrew/logbrew-kotlin/maven-metadata.xml": metadata}
	code, output, _, _ := runRegistry(responses, "--target", "maven", "--maven-plan", path, "--maven-plan-scope", "selected")
	if code != exitOK || output != "public registry versions ok for maven at 0.1.0; maven overrides: co.logbrew:logbrew-kotlin@1.0.0\n" {
		t.Fatalf("selected plan = %d, %q", code, output)
	}
	code, output, _, _ = runRegistry(responses, "--target", "maven", "--maven-plan", path, "--maven-plan-scope",
		"selected", "--expect-absent", "--retries", "0")
	if code != exitFailure {
		t.Fatalf("existing version = %d, %q", code, output)
	}
	if code, output, _, _ = runRegistry(nil, "--target", "maven", "--maven-plan", path, "--maven-plan-scope",
		"dependencies"); code != exitOK || output != "public registry versions ok for maven at 0.1.0\n" {
		t.Fatalf("no dependencies = %d, %q", code, output)
	}
}

func TestRegistryPublicationChecks(t *testing.T) {
	catalog, _ := loadReleaseCatalog(releaseCatalogText)
	responses := map[string][]registryReply{
		"https://pypi.org/pypi/logbrew-sdk/json":            ok(`{"info": {"version": "0.1.0"}}`),
		"https://pypi.org/pypi/logbrew-flask/json":          ok(`{"releases": {"v0.1.0": []}}`),
		"https://pypi.org/pypi/logbrew-fastapi/json":        ok(`{"releases": {"0.1.0": []}}`),
		"https://pypi.org/pypi/logbrew-django/json":         ok(`{"releases": {"0.1.0": []}}`),
		"https://rubygems.org/api/v1/gems/logbrew-sdk.json": ok(`{"version": "` + catalog.RubyGems + `"}`),
		"https://repo.packagist.org/p2/logbrew/sdk.json": ok(`{"packages": {"logbrew/sdk": [1, {"version": 2},
			{"version": "` + catalog.Packagist + `"}]}}`),
		cratesIndex: ok("{\"vers\": \"" + catalog.Rust + "\"}\r\n{\"vers\": \"9\", \"yanked\": true}\x1cjunk"),
		"https://package.openupm.com/co.logbrew.unity": ok(`{"dist-tags": {"latest": "0.1.0"}}`),
		"https://registry.npmjs.org/co.logbrew.unity":  ok(`{"versions": {"0.1.0": {}}}`),
	}
	for _, id := range catalog.nugetIDs() {
		responses["https://api.nuget.org/v3-flatcontainer/"+strings.ToLower(id)+"/index.json"] = ok(`{"versions": ["0.1.0"]}`)
	}
	for _, artifact := range registryMaven {
		responses["https://repo1.maven.org/maven2/co/logbrew/"+artifact+"/maven-metadata.xml"] = ok(
			"<metadata><versioning><latest>" + catalog.Maven + "</latest></versioning></metadata>")
	}
	for _, name := range registryNPM {
		responses["https://registry.npmjs.org/"+pyQuote(name)] = ok(`{"versions": {"0.1.0": {}}}`)
	}
	code, output, diagnostic, _ := runRegistry(responses, "--include-unity-npm", "--include-pypi-extras",
		"--include-crates", "--include-packagist", "--include-maven", "--include-openupm")
	want := "public registry versions ok for all at 0.1.0; RubyGems overrides: logbrew-sdk@" + catalog.RubyGems +
		"; Packagist overrides: logbrew/sdk@" + catalog.Packagist + "; crates.io overrides: logbrew@" + catalog.Rust + "\n"
	if code != exitOK || output != want {
		t.Fatalf("all = %d, %q, %q", code, output, diagnostic)
	}
	released := []string{"--require-released-package-set", "--include-unity-npm"}
	for _, name := range append(slices.Clone(registryNPM), unityPackage) {
		released = append(released, "--npm-version", name+"=0.1.0")
	}
	for _, id := range catalog.nugetIDs() {
		released = append(released, "--nuget-version", id+"=0.1.0")
	}
	if code, _, diagnostic, _ = runRegistry(responses, released...); code != exitOK {
		t.Fatalf("released set = %d, %q", code, diagnostic)
	}
	if code, _, diagnostic, _ = runRegistry(responses, released[:len(released)-2]...); code != exitUsage {
		t.Fatalf("partial released set = %d, %q", code, diagnostic)
	}
	code, output, diagnostic, _ = runRegistry(responses, "--target", "npm", "--target", "pypi", "--npm-version",
		"@logbrew/sdk = v0.1.0", "--npm-version", "co.logbrew.unity=0.1.0", "--pypi-version", "logbrew-sdk=0.1.0",
		"--include-unity-npm")
	if code != exitOK || output != "public registry versions ok for npm, pypi at 0.1.0; npm overrides: "+
		"@logbrew/sdk@v0.1.0, co.logbrew.unity@0.1.0; pypi overrides: logbrew-sdk@0.1.0\n" {
		t.Fatalf("overrides = %d, %q, %q", code, output, diagnostic)
	}
	code, _, diagnostic, _ = runRegistry(responses, "--target", "nuget", "--target", "maven", "--target", "go",
		"--nuget-version", "LogBrew=2.0.0", "--maven-artifact", "logbrew-sdk", "--maven-version",
		"co.logbrew:logbrew-sdk=v9", "--retries", "0", "--npm-package", "@logbrew/sdk")
	if code != exitUsage || !strings.Contains(diagnostic, "--npm-package requires") {
		t.Fatalf("npm package without npm = %d, %q", code, diagnostic)
	}
	t.Setenv("PATH", t.TempDir())
	code, _, diagnostic, _ = runRegistry(responses, "--target", "nuget", "--target", "maven", "--target", "go",
		"--nuget-version", "LogBrew=2.0.0", "--maven-artifact", "logbrew-sdk", "--maven-version",
		"co.logbrew:logbrew-sdk=v9", "--retries", "0")
	if code != exitFailure || diagnostic != "LogBrew: expected one of ['2.0.0', 'v2.0.0'], found ['0.1.0']\n"+
		"co.logbrew:logbrew-sdk: expected one of ['v9'], found ['"+catalog.Maven+"']\ngo: command not found\n" {
		t.Fatalf("mismatch = %d, %q", code, diagnostic)
	}
}

func TestRegistryPublicationRetries(t *testing.T) {
	responses := map[string][]registryReply{npmSDK: {{0, ""}, {http.StatusInternalServerError, ""}, {-1, ""},
		{http.StatusOK, "\xff"}, {http.StatusOK, "{"}, {http.StatusOK, `{"versions": {"0.1.0": {}}}`}}}
	code, _, diagnostic, slept := runRegistry(responses, "--target", "npm", "--npm-package", "@logbrew/sdk",
		"--retries", "6", "--retry-delay", "2")
	if code != exitOK || slept != 10 {
		t.Fatalf("eventual success = %d, %q, %g", code, diagnostic, slept)
	}
	for count, want := range map[string]string{
		"0": "@logbrew/sdk: failed to read " + npmSDK + ": connection refused",
		"1": "@logbrew/sdk: registry returned HTTP 500 for " + npmSDK,
		"2": "@logbrew/sdk: failed to read " + npmSDK + ": connection reset",
		"3": "@logbrew/sdk: failed to read " + npmSDK + ": UnicodeDecodeError",
		"4": "@logbrew/sdk: failed to read " + npmSDK + ": JSONDecodeError",
	} {
		code, _, diagnostic, _ := runRegistry(responses, "--target", "npm", "--npm-package", "@logbrew/sdk",
			"--retries", count, "--retry-delay", "0")
		if code != exitFailure || diagnostic != want+"\n" {
			t.Errorf("retries %s = %d, %q", count, code, diagnostic)
		}
	}
	if code, _, _, _ := runRegistry(nil, "--target", "npm", "--retries", "-1"); code != exitOK {
		t.Fatalf("no attempts = %d", code)
	}
	code, _, diagnostic, slept = runRegistry(responses, "--target", "npm", "--npm-package", "@logbrew/sdk",
		"--max-wait-seconds", "40", "--retry-delay", "0")
	if code != exitOK || slept != 0.5+1+2+4+8 {
		t.Fatalf("wait = %d, %q, %g", code, diagnostic, slept)
	}
	code, _, diagnostic, slept = runRegistry(nil, "--target", "npm", "--npm-package", "@logbrew/sdk",
		"--max-wait-seconds", "100", "--retry-delay", "20")
	if code != exitFailure || slept != 100 || diagnostic != "@logbrew/sdk 0.1.0, v0.1.0 not visible after 100s; "+
		"last error: @logbrew/sdk: registry returned HTTP 404 for "+npmSDK+"\n" {
		t.Fatalf("timeout = %d, %q, %g", code, diagnostic, slept)
	}
	for _, arguments := range [][]string{{"--retry-delay", "-1"}, {"--max-wait-seconds", "5", "--retry-delay", "nan"},
		{"--timeout", "-1"}, {"--timeout", "inf"}} {
		code, _, diagnostic, _ := runRegistry(nil, append([]string{"--target", "npm", "--retries", "1"}, arguments...)...)
		if code != exitFailure || !strings.HasPrefix(diagnostic, "invalid ") {
			t.Errorf("%v = %d, %q", arguments, code, diagnostic)
		}
	}
	code, _, diagnostic, _ = runRegistry(nil, "--target", "npm", "--npm-package", "@logbrew/sdk", "--retries", "0",
		"--timeout", "0")
	if code != exitFailure || diagnostic != "@logbrew/sdk: failed to read "+npmSDK+": timed out\n" {
		t.Fatalf("zero timeout = %d, %q", code, diagnostic)
	}
}

func TestRegistryPublicationAbsent(t *testing.T) {
	for _, test := range []struct {
		replies []registryReply
		want    string
	}{
		{nil, ""},
		{[]registryReply{{0, ""}}, "LogBrew: registry availability check failed\n"},
		{[]registryReply{{http.StatusForbidden, ""}}, "LogBrew: registry availability check failed\n"},
		{ok("{"), "LogBrew: registry availability check failed\n"},
		{ok(`{"versions": []}`), "LogBrew: registry availability check failed\n"},
		{ok(`{"versions": ["v1.0.0"]}`), "LogBrew: immutable registry version already exists\n"},
		{ok(`{"versions": ["0.9.0"]}`), ""},
	} {
		code, output, diagnostic, _ := runRegistry(map[string][]registryReply{nugetCore: test.replies}, "--target",
			"nuget", "--expect-absent", "--nuget-version", "LogBrew=1.0.0")
		if diagnostic != test.want || (code == exitOK) != (test.want == "") {
			t.Errorf("%v = %d, %q, %q", test.replies, code, output, diagnostic)
		}
		if code == exitOK && output != "public registry versions absent for nuget at 0.1.0; nuget overrides: LogBrew@1.0.0\n" {
			t.Errorf("summary = %q", output)
		}
	}
}

func TestRegistryProvenance(t *testing.T) {
	attestation := func(predicate, address string) string {
		return `{"version": "1.0.0+b/x", "dist": {"attestations": {"url": "` + address +
			`", "provenance": {"predicateType": "` + predicate + `"}}}}`
	}
	good := "https://registry.npmjs.org/-/npm/v1/attestations/%40logbrew%2Fsdk@1.0.0%2Bb%2Fx"
	for body, want := range map[string]bool{
		attestation("https://slsa.dev/provenance/v1", good):                                        true,
		attestation("https://slsa.dev/provenance/v0.2", good):                                      false,
		attestation("https://slsa.dev/provenance/v1", "http://registry.npmjs.org/x@1.0.0%2Bb%2Fx"): false,
		attestation("https://slsa.dev/provenance/v1", strings.TrimSuffix(good, "%2Fx")+"/x"):       false,
		`{"version": 1}`: false,
	} {
		code, _, diagnostic, _ := runRegistry(map[string][]registryReply{npmSDK + "/1.0.0%2Bb%2Fx": ok(body)}, "--target",
			"npm", "--npm-package", "@logbrew/sdk", "--require-npm-provenance", "--version", "1.0.0+b/x", "--retries", "0")
		if (code == exitOK) != want {
			t.Errorf("%s = %d, %q", body, code, diagnostic)
		}
	}
}

func TestRegistryVersionReaders(t *testing.T) {
	decode := func(text string) any {
		value, err := decodePlanJSON([]byte(text))
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	for _, test := range []struct {
		read    func(any) []string
		payload any
		want    string
	}{
		{npmVersions, decode(`{"dist-tags": {"latest": "1"}, "versions": {"": {}}}`), "['', '1']"},
		{npmVersions, decode(`{"dist-tags": [], "versions": []}`), "[]"},
		{pypiVersions, decode(`{"info": {"version": ""}, "releases": {"2": []}}`), "['2']"},
		{nugetVersions, decode(`{"versions": {"b": 1}}`), "['b']"},
		{nugetVersions, decode(`{"versions": "1.é"}`), "['.', '1', 'é']"},
		{nugetVersions, decode(`{"versions": null}`), "[]"},
		{packagistVersions, decode(`{"packages": {"logbrew/sdk": {"version": "1"}}}`), "[]"},
		{cratesVersions, "{\"vers\": \"1\", \"yanked\": 0}\u2028{\"vers\": \"2\", \"yanked\": []}\u0085" +
			"{\"vers\": \"3\", \"yanked\": \"y\"}\n{\"vers\": \"\", \"yanked\": {}}\n{\"vers\": 4}\n\ufeff{\"vers\": \"5\"}", "['', '1', '2']"},
		{mavenVersions, "<m><versioning><latest/><release>r<!-- c -->1</release><versions><version>a</version>" +
			"<version><![CDATA[b]]></version><version/></versions></versioning><versioning><latest>z</latest>" +
			"</versioning></m>", "['a', 'b', 'r1']"},
		{mavenVersions, `<m xmlns="urn:x"><versioning><latest>1</latest></versioning></m>`, "[]"},
		{mavenVersions, "<m>", "[]"},
	} {
		found := test.read(test.payload)
		if got := pyRepr(slices.Compact(slices.Sorted(slices.Values(found)))); got != test.want {
			t.Errorf("%v = %s, want %s", test.payload, got, test.want)
		}
	}
	for value, want := range map[any]bool{nil: false, true: true, "": false, "x": true, 0.0: false} {
		if pyTruthy(value) != want {
			t.Errorf("pyTruthy(%v) != %v", value, want)
		}
	}
	if !pyTruthy([]any{1}) || pyTruthy(map[string]any{}) || pyTruthy(decode("0.0")) || !pyTruthy(decode("1e-5")) {
		t.Fatal("pyTruthy containers or numbers")
	}
	for text, want := range map[string]float64{" 1_0 ": 10, "-Infinity": math.Inf(-1), ".5": 0.5, "5.": 5, "1e400": math.Inf(1)} {
		if got, ok := pyFloat(text); !ok || got != want {
			t.Errorf("pyFloat(%q) = %g, %v", text, got, ok)
		}
	}
	for value, want := range map[float64]string{1e6: "1e+06", 1234567: "1.23457e+06", 0.25: "0.25", math.Inf(-1): "-inf",
		math.NaN(): "nan"} {
		if got := pyG(value); got != want {
			t.Errorf("pyG(%g) = %q, want %q", value, got, want)
		}
	}
	if got := pyQuote("@a/Z_.-~é"); got != "%40a%2FZ_.-~%C3%A9" {
		t.Fatalf("pyQuote = %q", got)
	}
	if got := pyString("a\u2028\u0085\U000e0001"); got != `'a\u2028\x85\U000e0001'` {
		t.Fatalf("pyString = %s", got)
	}
}

func TestRegistryGoModule(t *testing.T) {
	directory := t.TempDir()
	script := "#!/bin/sh\nif [ \"$1\" = \"$FAIL\" ]; then echo \" $1 broke \"; exit 1; fi\n"
	if err := os.WriteFile(filepath.Join(directory, "go"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+":/usr/bin:/bin")
	for fail, want := range map[string]string{"": "", "mod": "go mod init failed: mod broke",
		"get": "go get github.com/LogBrewCo/sdk/go/logbrew@v1.2.3 failed: get broke"} {
		t.Setenv("FAIL", fail)
		if got := strings.Join(registryGoModule("v1.2.3"), ""); got != want {
			t.Errorf("FAIL=%s: %q", fail, got)
		}
	}
	t.Setenv("TMPDIR", filepath.Join(directory, "missing"))
	code, _, diagnostic, _ := runRegistry(nil, "--target", "go")
	if code != exitFailure || diagnostic != "cannot create a temporary directory\n" {
		t.Fatalf("temporary directory = %d, %q", code, diagnostic)
	}
}
