package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha1"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"
)

const (
	testPOM = `<project xmlns="http://maven.apache.org/POM/4.0.0"><groupId>co.logbrew</groupId>` +
		`<artifactId>logbrew-sdk</artifactId><version>1.2.3</version><name>LogBrew</name><description>SDK</description>` +
		`<url>https://logbrew.co</url><licenses><license><url>https://first</url></license><license><name>MIT</name>` +
		`<url>https://mit</url></license></licenses><developers><developer><name>Dev</name></developer></developers>` +
		`<scm><url>https://github.com</url></scm></project>`
	testDeployment = "0123abcd-0123-4567-89ab-0123456789ab"
)

// runChecks runs one release check against a fake network, with a clock
// that only sleeping advances.
func runChecks(transport http.RoundTripper, stdin string, arguments ...string) (int, string, string) {
	var output, diagnostic bytes.Buffer
	now := time.Unix(0, 0)
	tools := releaseTools{transport, strings.NewReader(stdin), func(duration time.Duration) { now = now.Add(duration) },
		func() time.Time { return now }}
	code := checkRelease(arguments, tools, &output, &diagnostic)
	return code, output.String(), diagnostic.String()
}

func writeTestFile(t *testing.T, path, text string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestReleaseChecksUsage(t *testing.T) {
	for _, arguments := range [][]string{{}, {"nope"}, {"npm-peers"}, {"npm-peers", "m", "bad"}, {"npm-peers", "m", "=1.0.0"},
		{"maven-pom", "--group-id"}, {"maven-pom", "pom", "--group-id", "g", "--artifact-id", "a"},
		{"release-notes", "a", "b", "--since", "x"}, {"maven-deployment"}, {"maven-deployment", "nope"},
		{"publication-run", "--repository", "a/b", "--run-id", "x", "--family", "pypi", "--workflow-sha", "a",
			"--source-sha", "b"},
		{"publication-run", "--repository", "a/b", "--run-id", "1", "--family", "other", "--workflow-sha", "a",
			"--source-sha", "b"},
		{"maven-deployment", "wait", "--deployment-id-file", "/x", "--timeout-seconds", "x"}} {
		if code, output, _ := runChecks(nil, "", arguments...); code != exitUsage || output != "" {
			t.Errorf("%v = %d, %q", arguments, code, output)
		}
	}
	for _, arguments := range [][]string{{"--help"}, {"-h"}, {"maven-pom", "-h"}, {"maven-deployment", "--help"}} {
		if code, output, _ := runChecks(nil, "", arguments...); code != exitOK || output != releaseChecksUsage {
			t.Errorf("%v = %d, %q", arguments, code, output)
		}
	}
	spec := checkSpec{required: []string{"since"}, positional: 2}
	parsed, help, err := parseCheck(spec, []string{"a", "--since", "x", "--", "-b"})
	if help || err != nil || !slices.Equal(parsed.positional, []string{"a", "-b"}) || parsed.values["since"] != "x" {
		t.Fatalf("parsed = %v, %v, %v", parsed, help, err)
	}
}

func TestCaretAllows(t *testing.T) {
	for _, test := range []struct {
		caret, version string
		allowed        bool
	}{
		{"^1.2.3", "1.2.3", true}, {"^1.2.3", "1.9.0", true}, {"^1.2.3", "1.2.2", false}, {"^1.2.3", "2.0.0", false},
		{"^0.1.34", "0.1.40", true}, {"^0.1.34", "0.2.0", false}, {"^0.1.34", "1.1.34", false},
		{"^0.0.5", "0.0.5", true}, {"^0.0.5", "0.0.6", false}, {"^0.0.5", "1.0.5", false},
		{"^99999999999999999999.0.0", "99999999999999999999.5.1", true}, {"^1.2.3", "10.2.3", false},
		{"1.2.3", "1.2.3", false}, {"^01.2.3", "1.2.3", false}, {"^1.2.3", "1.2.3-beta", false},
	} {
		if got := caretAllows(test.caret, test.version); got != test.allowed {
			t.Errorf("caretAllows(%q, %q) = %v", test.caret, test.version, got)
		}
	}
}

func TestNPMPeers(t *testing.T) {
	directory := t.TempDir()
	manifest := writeTestFile(t, filepath.Join(directory, "a", "package.json"),
		`{"peerDependencies": {"@logbrew/sdk": "^0.1.34", "react": 5}}`)
	if code, output, _ := runChecks(nil, "", "npm-peers", manifest, "@logbrew/sdk=0.1.40"); code != exitOK ||
		output != "npm peer compatibility ok\n" {
		t.Fatalf("ok = %d, %q", code, output)
	}
	code, _, diagnostic := runChecks(nil, "", "npm-peers", manifest, "react=1.0.0", "x=1.0.0", "react=2.0.0")
	if want := manifest + ": peer react range 5 does not include 2.0.0\n" + manifest +
		": peer x range None does not include 1.0.0\n"; code != exitFailure || diagnostic != want {
		t.Fatalf("failures = %d, %q", code, diagnostic)
	}
	for _, text := range []string{"[]", "{", `{"peerDependencies": []}`} {
		writeTestFile(t, filepath.Join(directory, "b.json"), text)
		code, _, diagnostic := runChecks(nil, "", "npm-peers", filepath.Join(directory, "b.json"), "x=1.0.0")
		if code != exitFailure || !strings.HasSuffix(diagnostic, ": invalid npm manifest\n") {
			t.Errorf("%s = %d, %q", text, code, diagnostic)
		}
	}
	writeTestFile(t, filepath.Join(directory, "c.json"), `{}`)
	if code, _, diagnostic := runChecks(nil, "", "npm-peers", filepath.Join(directory, "c.json"), "x=1.0.0"); code != exitFailure ||
		!strings.Contains(diagnostic, "range None") {
		t.Fatalf("no peers = %d, %q", code, diagnostic)
	}
}

func TestMavenPOM(t *testing.T) {
	directory := t.TempDir()
	pom := writeTestFile(t, filepath.Join(directory, "pom.xml"), testPOM)
	arguments := []string{"maven-pom", "--group-id", "co.logbrew", pom, "--artifact-id", "logbrew-sdk", "--version", "1.2.3"}
	if code, output, _ := runChecks(nil, "", arguments...); code != exitOK || output != "maven pom metadata checks passed\n" {
		t.Fatalf("ok = %d, %q", code, output)
	}
	writeTestFile(t, pom, strings.NewReplacer("<name>MIT</name>", "", "<scm><url>https://github.com</url></scm>", "",
		"<groupId>co.logbrew</groupId>", "<groupId> </groupId>").Replace(testPOM))
	code, _, diagnostic := runChecks(nil, "", arguments...)
	if want := "missing or invalid Maven Central POM metadata:\n- m:groupId='', expected 'co.logbrew'\n" +
		"- license name\n- scm url\n"; code != exitFailure || diagnostic != want {
		t.Fatalf("failures = %d, %q", code, diagnostic)
	}
	writeTestFile(t, pom, "<project>")
	if code, _, diagnostic := runChecks(nil, "", arguments...); code != exitFailure ||
		!strings.HasPrefix(diagnostic, "invalid Maven POM: ") {
		t.Fatalf("invalid = %d, %q", code, diagnostic)
	}
	arguments[3] = filepath.Join(directory, "missing.xml")
	if code, _, _ := runChecks(nil, "", arguments...); code != exitFailure {
		t.Fatalf("missing = %d", code)
	}
}

func testJAR(t *testing.T, path string, entries map[string]string, extra int) {
	t.Helper()
	var buffer bytes.Buffer
	archive := zip.NewWriter(&buffer)
	names := slices.Sorted(func(yield func(string) bool) {
		for name := range entries {
			if !yield(name) {
				return
			}
		}
	})
	for _, name := range names {
		writer, err := archive.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate})
		if err == nil {
			_, err = writer.Write([]byte(entries[name]))
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	for index := range extra {
		if _, err := archive.CreateHeader(&zip.FileHeader{Name: "f" + string(rune('a'+index%26)), Method: zip.Store}); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, path, buffer.String())
}

func TestMavenJAR(t *testing.T) {
	directory := t.TempDir()
	jar := filepath.Join(directory, "sdk.jar")
	pom := `<project xmlns="http://maven.apache.org/POM/4.0.0"><groupId>co.logbrew</groupId>` +
		`<artifactId>logbrew-sdk</artifactId><version>1.2.3</version></project>`
	testJAR(t, jar, map[string]string{mavenPOMPath: "\xef\xbb\xbf" + pom, "META-INF/MANIFEST.MF": "x"}, 0)
	if code, output, diagnostic := runChecks(nil, "", "maven-jar", jar, "1.2.3"); code != exitOK || output+diagnostic != "" {
		t.Fatalf("ok = %d, %q", code, diagnostic)
	}
	if err := os.Symlink(jar, filepath.Join(directory, "link.jar")); err != nil {
		t.Fatal(err)
	}
	failing := [][]string{{jar, "1.2.4"}, {jar, "1.2"}, {jar}, {filepath.Join(directory, "link.jar"), "1.2.3"},
		{directory, "1.2.3"}, {filepath.Join(directory, "missing.jar"), "1.2.3"}}
	for _, entries := range []map[string]string{
		{mavenPOMPath: pom, "META-INF/maven/co.logbrew/other/pom.xml": pom},
		{"META-INF/maven/co.logbrew/other/pom.xml": pom},
		{mavenPOMPath: ""},
		{mavenPOMPath: strings.Repeat(" ", 256<<10+1)},
		{mavenPOMPath: "<!DOCTYPE project>" + pom},
		{mavenPOMPath: "\xff" + pom},
		{mavenPOMPath: "<project"},
		{mavenPOMPath: strings.ReplaceAll(pom, "project", "projekt")},
		{mavenPOMPath: strings.Replace(pom, "<version>", "<version>1.2.3</version><version>", 1)},
		{mavenPOMPath: strings.Replace(pom, "<version>1.2.3", "<version><x/>1.2.3", 1)},
		{mavenPOMPath: strings.Replace(pom, "<version>1.2.3</version>", `<v:version xmlns:v="x">1.2.3</v:version>`, 1)},
		{mavenPOMPath: strings.Replace(pom, "logbrew-sdk", "logbrew-kotlin", 1)},
	} {
		path := filepath.Join(directory, "case"+string(rune('a'+len(failing)))+".jar")
		testJAR(t, path, entries, 0)
		failing = append(failing, []string{path, "1.2.3"})
	}
	testJAR(t, filepath.Join(directory, "many.jar"), map[string]string{mavenPOMPath: pom}, 20_000)
	writeTestFile(t, filepath.Join(directory, "text.jar"), "not a zip")
	failing = append(failing, []string{filepath.Join(directory, "many.jar"), "1.2.3"},
		[]string{filepath.Join(directory, "text.jar"), "1.2.3"})
	for _, arguments := range failing {
		code, _, diagnostic := runChecks(nil, "", append([]string{"maven-jar"}, arguments...)...)
		if code != exitFailure || diagnostic != mavenJARFailure {
			t.Errorf("%v = %d, %q", arguments, code, diagnostic)
		}
	}
}

func digest512(data string) string {
	sum := sha512.Sum512([]byte(data))
	return base64.StdEncoding.EncodeToString(sum[:])
}

// nugetFixture writes bound packages, their installed copies, and the assets
// file, and returns the arguments that verify them.
func nugetFixture(t *testing.T, directory string) []string {
	t.Helper()
	source := filepath.Join(directory, "source")
	if err := os.MkdirAll(source, 0o755); err != nil {
		t.Fatal(err)
	}
	libraries := map[string]any{}
	for index, release := range [][2]string{{"LogBrew", "1.2.3"}, {"LogBrew.HttpClient", "0.4.0"}} {
		data := "package " + release[0]
		writeTestFile(t, filepath.Join(directory, "bound", string(rune('0'+index))+".nupkg"), data)
		name := strings.ToLower(release[0])
		installed := filepath.Join(directory, "packages", name, release[1])
		writeTestFile(t, filepath.Join(installed, name+"."+release[1]+".nupkg.sha512"), digest512(data)+"\n")
		metadata, _ := json.Marshal(map[string]any{"contentHash": digest512("content"), "source": source})
		writeTestFile(t, filepath.Join(installed, ".nupkg.metadata"), string(metadata))
		libraries[release[0]+"/"+release[1]] = map[string]any{"type": "package", "sha512": digest512("content")}
	}
	assets, _ := json.Marshal(map[string]any{"libraries": libraries})
	writeTestFile(t, filepath.Join(directory, "assets.json"), string(assets))
	return []string{"nuget-provenance", "--bound-dir", filepath.Join(directory, "bound"), "--source-dir", source,
		"--packages-dir", filepath.Join(directory, "packages"), "--assets", filepath.Join(directory, "assets.json"),
		"--core-version", "1.2.3", "--httpclient-version", "0.4.0"}
}

func TestNuGetProvenance(t *testing.T) {
	directory := t.TempDir()
	arguments := nugetFixture(t, directory)
	if code, _, diagnostic := runChecks(nil, "", arguments...); code != exitOK {
		t.Fatalf("ok = %d, %q", code, diagnostic)
	}
	core := filepath.Join(directory, "packages", "logbrew", "1.2.3")
	for _, mutate := range []func(){
		func() { arguments[2] = arguments[4] },
		func() { arguments[2] = filepath.Join(directory, "missing") },
		func() { writeTestFile(t, arguments[8], `{"libraries": []}`) },
		func() { writeTestFile(t, arguments[8], `[]`) },
		func() { arguments[10] = "1.2.4" },
		func() { arguments[10] = "/1.2.3" },
		func() { writeTestFile(t, filepath.Join(core, "logbrew.1.2.3.nupkg.sha512"), digest512("other")) },
		func() { writeTestFile(t, filepath.Join(core, "logbrew.1.2.3.nupkg.sha512"), "\xff") },
		func() { writeTestFile(t, filepath.Join(core, ".nupkg.metadata"), `{"source": 1}`) },
		func() {
			writeTestFile(t, filepath.Join(core, ".nupkg.metadata"), `{"contentHash": "`+digest512("content")+`", "source": "source"}`)
		},
		func() {
			writeTestFile(t, filepath.Join(core, ".nupkg.metadata"),
				`{"contentHash": "`+digest512("other")+`", "source": "`+arguments[4]+`"}`)
		},
		func() {
			writeTestFile(t, filepath.Join(core, ".nupkg.metadata"),
				`{"contentHash": "`+strings.TrimRight(digest512("content"), "=")+`", "source": "`+arguments[4]+`"}`)
		},
		func() {
			bound := filepath.Join(arguments[2], "0.nupkg")
			if os.Rename(bound, bound+".real") != nil || os.Symlink(bound+".real", bound) != nil {
				t.Fatal("cannot link the bound package")
			}
		},
	} {
		arguments = nugetFixture(t, t.TempDir())
		directory = filepath.Dir(arguments[8])
		core = filepath.Join(directory, "packages", "logbrew", "1.2.3")
		mutate()
		if code, _, diagnostic := runChecks(nil, "", arguments...); code != exitFailure ||
			diagnostic != "NuGet receipt provenance verification failed\n" {
			t.Errorf("%v = %d, %q", arguments, code, diagnostic)
		}
	}
	if canonicalSHA512(digest512("x")[:4]+"====") != "" || pyJoin("a", "", "/b", "c") != "/b/c" {
		t.Fatal("canonical digest or path join is wrong")
	}
}

func TestPyResolveStrict(t *testing.T) {
	directory := t.TempDir()
	loop := filepath.Join(directory, "loop")
	if err := os.Symlink(loop, loop); err != nil {
		t.Fatal(err)
	}
	resolvedDirectory, _ := pyRealpath(directory)
	for path, want := range map[string]bool{directory: true, filepath.Join(directory, "missing"): false,
		directory + "/missing/..": false, loop: false} {
		resolved, err := pyResolve(path, true)
		if (err == nil) != want || want && resolved != resolvedDirectory {
			t.Errorf("pyResolve(%q) = %q, %v", path, resolved, err)
		}
	}
}

func git(t *testing.T, directory string, arguments ...string) {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", directory, "-c", "user.name=a", "-c", "user.email=a@b"},
		arguments...)...)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v %s", arguments, err, output)
	}
}

func TestReleaseNotes(t *testing.T) {
	directory := t.TempDir()
	git(t, directory, "init", "-q")
	commit := func(path, subject string) {
		writeTestFile(t, filepath.Join(directory, path), subject)
		git(t, directory, "add", "-A")
		git(t, directory, "commit", "-q", "--cleanup=verbatim", "-m", subject)
	}
	commit("go/pkg/a", "chore: start")
	git(t, directory, "tag", "v1")
	for _, subject := range []string{"feat(go): add a", "fix: repair b", "docs: c", "perf!: faster d", "feat: e\x1cf"} {
		commit("go/pkg/a", subject)
	}
	commit("other/b", "feat: elsewhere")
	t.Chdir(directory)
	code, output, _ := runChecks(nil, "", "release-notes", "go/pkg", "--since", "v1")
	if want := "### Added\n- add a\n- e\n\n### Fixed\n- repair b\n\n### Faster\n- faster d\n"; code != exitOK ||
		output != want {
		t.Fatalf("notes = %d, %q", code, output)
	}
	if code, output, _ := runChecks(nil, "", "release-notes", "other", "--since", "HEAD", "--until", "HEAD"); code != exitOK ||
		output != "Maintenance release with no behavior changes.\n" {
		t.Fatalf("empty = %d, %q", code, output)
	}
	if code, _, diagnostic := runChecks(nil, "", "release-notes", "go", "--since", "nope"); code != exitFailure ||
		diagnostic != "release notes failed: git log failed\n" {
		t.Fatalf("bad range = %d, %q", code, diagnostic)
	}
	writeTestFile(t, filepath.Join(directory, "go", "c"), "c")
	git(t, directory, "add", "-A")
	tree, _ := exec.Command("git", "-C", directory, "write-tree").Output()
	parent, _ := exec.Command("git", "-C", directory, "rev-parse", "HEAD").Output()
	object := exec.Command("git", "-C", directory, "hash-object", "-t", "commit", "-w", "--stdin")
	object.Stdin = strings.NewReader("tree " + string(tree) + "parent " + string(parent) +
		"author a <a@b> 0 +0000\ncommitter a <a@b> 0 +0000\n\nfeat: \xff\n")
	sha, err := object.Output()
	if err != nil {
		t.Fatal(err)
	}
	git(t, directory, "update-ref", "HEAD", strings.TrimSpace(string(sha)))
	if code, _, _ := runChecks(nil, "", "release-notes", "go", "--since", "v1"); code != exitFailure {
		t.Fatalf("invalid UTF-8 = %d", code)
	}
}

func TestNPMPlan(t *testing.T) {
	node, sdk := "https://registry.npmjs.org/%40logbrew%2Fnode", "https://registry.npmjs.org/%40logbrew%2Fsdk"
	responses := map[string][]registryReply{
		node: ok(`{"name": "@logbrew/node", "versions": {"0.1.5": null}}`), sdk: {{http.StatusNotFound, ""}},
		"https://registry.npmjs.org/logbrew": ok(`{"name": "logbrew", "versions": {}}`),
	}
	code, output, _ := runChecks(&fakeRegistry{responses, map[string]int{}}, "", "npm-plan", "--package",
		"@logbrew/node=0.1.5", "--package", "@logbrew/sdk=0.1.8", "--package", "logbrew=1.0.0", "--registry",
		"https://registry.npmjs.org/")
	if want := `{"existingVersions":["@logbrew/node@0.1.5"],"missingPackagePages":["@logbrew/sdk"],` +
		`"registry":"https://registry.npmjs.org","schemaVersion":1,"selectedVersions":["@logbrew/node@0.1.5",` +
		`"@logbrew/sdk@0.1.8","logbrew@1.0.0"]}` + "\n"; code != exitOK || output != want {
		t.Fatalf("plan = %d, %q", code, output)
	}
	for packages, message := range map[string]string{
		"":                              "npm publication plan requires 1..64 selections",
		"Bad=1":                         "invalid npm package selection: 'Bad=1'",
		"x":                             "invalid npm package selection: 'x'",
		"x=":                            "invalid npm package version for x",
		"x=1 2":                         "invalid npm package version for x",
		"x=" + strings.Repeat("é", 129): "invalid npm package version for x",
		"x=1,x=2":                       "npm publication plan contains duplicate package names",
	} {
		arguments := []string{"npm-plan"}
		for _, selection := range strings.Split(packages, ",") {
			if selection != "" {
				arguments = append(arguments, "--package", selection)
			}
		}
		code, _, diagnostic := runChecks(nil, "", arguments...)
		if code != exitFailure || diagnostic != "npm publication preflight failed: "+message+"\n" {
			t.Errorf("%q = %d, %q", packages, code, diagnostic)
		}
	}
	many := []string{"npm-plan"}
	for index := range 65 {
		many = append(many, "--package", "p"+string(rune('a'+index%26))+string(rune('a'+index/26))+"=1")
	}
	if _, _, diagnostic := runChecks(nil, "", many...); !strings.Contains(diagnostic, "1..64") {
		t.Fatalf("many = %q", diagnostic)
	}
	for _, registry := range []string{"http://registry.npmjs.org", "https://", "https://u@x", "https://x?a", "https://x#f",
		"https://[x"} {
		if _, _, diagnostic := runChecks(nil, "", "npm-plan", "--package", "x=1", "--registry", registry); !strings.HasSuffix(
			diagnostic, "npm registry must be a plain HTTPS URL\n") {
			t.Errorf("%s = %q", registry, diagnostic)
		}
	}
	x := "https://registry.npmjs.org/x"
	for reply, message := range map[registryReply]string{
		{0, ""}: "npm registry lookup failed for x", {-1, ""}: "npm registry lookup failed for x",
		{http.StatusInternalServerError, ""}:             "npm registry returned HTTP 500 for x",
		{http.StatusOK, strings.Repeat(" ", 16<<20+1)}:   "npm registry metadata is too large for x",
		{http.StatusOK, "{"}:                             "npm registry returned invalid JSON for x",
		{http.StatusOK, `{"name": "y"}`}:                 "npm registry returned mismatched metadata for x",
		{http.StatusOK, `{"name": "x", "versions": []}`}: "npm registry returned invalid versions metadata for x",
	} {
		registry := &fakeRegistry{map[string][]registryReply{x: {reply}}, map[string]int{}}
		if _, _, diagnostic := runChecks(registry, "", "npm-plan", "--package", "x=1"); diagnostic !=
			"npm publication preflight failed: "+message+"\n" {
			t.Errorf("%d = %q", reply.status, diagnostic)
		}
	}
	if _, _, diagnostic := runChecks(nil, "", "npm-plan", "--package", "x=1", "--registry", "https://a b"); !strings.Contains(
		diagnostic, "lookup failed") {
		t.Fatalf("bad host = %q", diagnostic)
	}
}

// fakeBun puts a bun on PATH that packs "packed" unless FAKE_BUN_FAIL is set.
func fakeBun(t *testing.T) {
	t.Helper()
	directory := t.TempDir()
	writeTestFile(t, filepath.Join(directory, "bun"), "#!/bin/sh\n[ -n \"$FAKE_BUN_FAIL\" ] && exit 1\n"+
		"while [ $# -gt 0 ]; do [ \"$1\" = --filename ] && printf packed > \"$2\"; shift; done\nexit 0\n")
	if err := os.Chmod(filepath.Join(directory, "bun"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+":"+os.Getenv("PATH"))
}

func workspace(t *testing.T, manifests map[string]string) string {
	t.Helper()
	directory := t.TempDir()
	for name, text := range manifests {
		writeTestFile(t, filepath.Join(directory, name, "package.json"), text)
	}
	t.Chdir(directory)
	return directory
}

func TestNPMWorkspace(t *testing.T) {
	fakeBun(t)
	sum := sha1.Sum([]byte("packed"))
	packed := hex.EncodeToString(sum[:])
	workspace(t, map[string]string{
		"sdk":   `{"name": "@logbrew/sdk", "version": "0.1.0"}`,
		"node":  `{"name": "@logbrew/node", "version": "0.2.0", "peerDependencies": {"@logbrew/sdk": "^0.1.0", "left-pad": "1"}}`,
		"next":  `{"name": "@logbrew/next", "version": "0.3.0", "peerDependencies": {"@logbrew/sdk": "^0.1.0", "@logbrew/node": "^0.1.0"}}`,
		"extra": `{"name": "extra", "version": "1.0.0"}`,
	})
	sdk := "https://registry.test/@logbrew%2Fsdk/0.1.0"
	base := []string{"npm-workspace", "--registry", "https://registry.test/", "--workspace-dir", "sdk", "--workspace-dir", "node",
		"--workspace-dir", "next"}
	check := func(reply registryReply, selected ...string) (int, string, string) {
		arguments := slices.Clone(base)
		for _, directory := range selected {
			arguments = append(arguments, "--selected-dir", directory)
		}
		return runChecks(&fakeRegistry{map[string][]registryReply{sdk: {reply}}, map[string]int{}}, "", arguments...)
	}
	if code, output, _ := check(registryReply{http.StatusOK, `{"dist": {"shasum": "` + packed + `"}}`}, "node"); code != exitOK ||
		output != "npm workspace peer release plan ok\n" {
		t.Fatalf("ok = %d, %q", code, output)
	}
	for _, test := range []struct {
		reply    registryReply
		selected []string
		want     string
	}{
		{registryReply{http.StatusOK, `{"dist": {"shasum": "` + strings.Repeat("f", 40) + `"}}`}, []string{"node"},
			"@logbrew/node@0.2.0 depends on unpublished workspace content for @logbrew/sdk@0.1.0; bump and include that peer before its consumer\n"},
		{registryReply{http.StatusNotFound, ""}, []string{"node", "next"},
			"@logbrew/node@0.2.0 requires @logbrew/sdk@0.1.0, which is not published or could not be verified; include that peer before its consumer\n" +
				"@logbrew/next@0.3.0 peer @logbrew/node range '^0.1.0' does not include workspace release 0.2.0\n" +
				"@logbrew/next@0.3.0 requires @logbrew/sdk@0.1.0, which is not published or could not be verified; include that peer before its consumer\n"},
		{registryReply{http.StatusNotFound, ""}, []string{"node", "sdk", "node", "extra"},
			"selected npm package @logbrew/node appears more than once\nselected npm package extra is not in the workspace package set\n" +
				"@logbrew/sdk@0.1.0 must publish before @logbrew/node@0.2.0\n@logbrew/sdk@0.1.0 must publish before @logbrew/node@0.2.0\n"},
		{registryReply{0, ""}, []string{"node"}, "cannot verify @logbrew/sdk@0.1.0\n"},
		{registryReply{-1, ""}, []string{"node"}, "cannot verify @logbrew/sdk@0.1.0\n"},
		{registryReply{http.StatusBadGateway, ""}, []string{"node"}, "cannot verify @logbrew/sdk@0.1.0\n"},
		{registryReply{http.StatusOK, strings.Repeat(" ", 16<<20+1)}, []string{"node"}, "cannot verify @logbrew/sdk@0.1.0\n"},
		{registryReply{http.StatusOK, `{"dist": {"shasum": 5}}`}, []string{"node"}, "cannot verify @logbrew/sdk@0.1.0\n"},
		{registryReply{http.StatusOK, `{"dist": "x"}`}, []string{"node"},
			"npm view returned an invalid shasum for @logbrew/sdk@0.1.0\n"},
	} {
		if code, _, diagnostic := check(test.reply, test.selected...); code != exitFailure || diagnostic != test.want {
			t.Errorf("%v %v = %d, %q", test.reply.status, test.selected, code, diagnostic)
		}
	}
	t.Setenv("FAKE_BUN_FAIL", "1")
	if _, _, diagnostic := check(registryReply{}, "node"); diagnostic != "cannot pack @logbrew/sdk@0.1.0\n" {
		t.Fatalf("pack = %q", diagnostic)
	}
	t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "missing"))
	if code, _, _ := check(registryReply{}, "node"); code != exitFailure {
		t.Fatalf("temporary folder = %d", code)
	}
}

func TestNPMWorkspaceManifests(t *testing.T) {
	directory := workspace(t, map[string]string{
		"a": `{"name": "a", "version": "1.0.0"}`, "dup": `{"name": "a", "version": "2.0.0"}`, "list": `[]`,
		"noversion": `{"name": "b"}`, "peers": `{"name": "c", "version": "1", "peerDependencies": {"x": 1}}`,
		"json": `{`, "binary": "\xff",
	})
	for _, test := range []struct{ workspace, selected, want string }{
		{"missing", "a", "cannot read npm manifest missing/package.json: [Errno 2] No such file or directory: 'missing/package.json'\n"},
		{"binary", "a", "cannot read npm manifest binary/package.json: not UTF-8\n"},
		{"json", "a", "cannot read npm manifest json/package.json: JSONDecodeError\n"},
		{"list", "a", "list/package.json: name must be a non-empty string\n"},
		{"noversion", "a", "noversion/package.json: version must be a non-empty string\n"},
		{"peers", "a", "peers/package.json: peerDependencies must map names to ranges\n"},
		{"a,dup", "a", "workspace npm package names must be unique\n"},
		{"a", "list", "list/package.json: name must be a non-empty string\n"},
	} {
		arguments := []string{"npm-workspace", "--selected-dir", test.selected}
		for _, name := range strings.Split(test.workspace, ",") {
			arguments = append(arguments, "--workspace-dir", name)
		}
		if code, _, diagnostic := runChecks(nil, "", arguments...); code != exitFailure || diagnostic != test.want {
			t.Errorf("%s = %d, %q", test.workspace, code, diagnostic)
		}
	}
	_ = directory
}

func publicationRun(family string) (string, string) {
	contract := publicationContracts[family]
	run, _ := json.Marshal(map[string]any{"id": 7, "event": "workflow_dispatch",
		"path": ".github/workflows/publish-packages.yml", "head_branch": "main", "head_sha": strings.Repeat("a", 40),
		"display_title": "Publish " + family + " from " + strings.Repeat("b", 40), "conclusion": "failure", "run_attempt": 1,
		"head_repository": map[string]any{"full_name": "LogBrewCo/sdk"}, "referenced_workflows": []any{map[string]any{
			"path": "LogBrewCo/sdk/.github/workflows/publish-nuget.yml@" + strings.Repeat("a", 40),
			"ref":  "refs/heads/main", "sha": strings.Repeat("a", 40)}}})
	steps := []any{map[string]any{"name": "Post step", "conclusion": "skipped"}}
	for _, step := range contract.steps {
		conclusion, name := "success", step
		if strings.HasPrefix(step, "=") {
			conclusion, name, _ = strings.Cut(step[1:], " ")
		}
		steps = append(steps, map[string]any{"name": name, "conclusion": conclusion})
	}
	jobs := []any{map[string]any{"name": contract.job, "conclusion": "failure", "steps": steps},
		map[string]any{"name": contract.sibling, "conclusion": "neutral"}}
	for _, name := range publicationJobs {
		jobs = append(jobs, map[string]any{"name": name, "conclusion": "skipped"})
	}
	payload, _ := json.Marshal(map[string]any{"total_count": len(jobs), "jobs": jobs})
	return string(run), string(payload)
}

type redirecting struct{}

func (redirecting) RoundTrip(request *http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: http.StatusFound, Header: http.Header{"Location": {"/elsewhere"}},
		Body: io.NopCloser(strings.NewReader("")), Request: request}, nil
}

func TestPublicationRun(t *testing.T) {
	base := "https://api.github.com/repos/LogBrewCo/sdk/actions/runs/7"
	arguments := func(family string) []string {
		return []string{"publication-run", "--repository", "LogBrewCo/sdk", "--run-id", "7", "--family", family,
			"--workflow-sha", strings.Repeat("a", 40), "--source-sha", strings.Repeat("b", 40)}
	}
	t.Setenv("GITHUB_AUTHORIZATION", "token")
	for _, family := range []string{"pypi", "nuget"} {
		run, jobs := publicationRun(family)
		registry := &fakeRegistry{map[string][]registryReply{base: ok(run), base + "/jobs?per_page=100": ok(jobs)}, map[string]int{}}
		if code, output, _ := runChecks(registry, "", arguments(family)...); code != exitOK ||
			output != "publication run verification ok\n" {
			t.Fatalf("%s = %d, %q", family, code, output)
		}
	}
	run, jobs := publicationRun("pypi")
	for _, test := range []struct{ run, jobs string }{
		{"", jobs}, {run, ""}, {"[]", jobs},
		{strings.Replace(run, `"run_attempt":1`, `"run_attempt":2`, 1), jobs},
		{strings.Replace(run, `"head_repository":{"full_name":"LogBrewCo/sdk"},`, "", 1), jobs},
		{strings.Replace(run, `"referenced_workflows"`, `"other"`, 1), jobs},
		{strings.Replace(run, `"ref":"refs/heads/main"`, `"ref":"x"`, 1), jobs},
		{run, strings.Replace(jobs, `"total_count":9`, `"total_count":8`, 1)},
		{run, strings.Replace(jobs, `"conclusion":"neutral"`, `"conclusion":"success"`, 1)},
		{run, strings.Replace(jobs, `"name":"npm packages"`, `"name":"crates.io package"`, 1)},
		{run, strings.Replace(jobs, `"steps":[`, `"steps":{"x":[`, 1) + "}"},
		{run, strings.Replace(jobs, `"name":"Post step"`, `"name":"Verify public PyPI packages"`, 1)},
		{run, strings.Replace(jobs, `{"conclusion":"skipped","name":"Post step"}`, `{"conclusion":"failure","name":"Post step"}`, 1)},
		{run, strings.Replace(jobs, `"conclusion":"failure","name":"Verify public PyPI installs"`,
			`"conclusion":"skipped","name":"Verify public PyPI installs"`, 1)},
	} {
		responses := map[string][]registryReply{}
		if test.run != "" {
			responses[base] = ok(test.run)
		}
		if test.jobs != "" {
			responses[base+"/jobs?per_page=100"] = ok(test.jobs)
		}
		if code, _, diagnostic := runChecks(&fakeRegistry{responses, map[string]int{}}, "", arguments("pypi")...); code !=
			exitFailure || diagnostic != "publication run verification failed\n" {
			t.Errorf("%.60s / %.60s = %d", test.run, test.jobs, code)
		}
	}
	refused := &fakeRegistry{map[string][]registryReply{base: {{0, ""}}}, map[string]int{}}
	if code, _, _ := runChecks(refused, "", arguments("pypi")...); code != exitFailure {
		t.Fatalf("refused = %d", code)
	}
	if code, _, _ := runChecks(redirecting{}, "", arguments("pypi")...); code != exitFailure {
		t.Fatalf("redirect = %d", code)
	}
	t.Setenv("GITHUB_AUTHORIZATION", "")
	if code, _, _ := runChecks(nil, "", arguments("pypi")...); code != exitFailure {
		t.Fatalf("no token = %d", code)
	}
}

func TestMavenDeploymentCapture(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "id")
	if code, output, _ := runChecks(nil, testDeployment, "maven-deployment", "capture", "--deployment-id-file", path); code !=
		exitOK || output != "Maven Central deployment submitted.\n" {
		t.Fatalf("capture = %d, %q", code, output)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != testDeployment+"\n" {
		t.Fatalf("stored = %q, %v", data, err)
	}
	for _, test := range []struct{ stdin, path, want string }{
		{testDeployment + "\n", path + "2", deploymentInvalid},
		{testDeployment, "relative", deploymentInvalid},
		{testDeployment, filepath.Join(directory, "missing", "id"), deploymentInvalid},
		{testDeployment, path, "Maven Central deployment identifier could not be stored."},
	} {
		if code, _, diagnostic := runChecks(nil, test.stdin, "maven-deployment", "capture", "--deployment-id-file",
			test.path); code != exitFailure || diagnostic != test.want+"\n" {
			t.Errorf("%q %s = %d, %q", test.stdin, test.path, code, diagnostic)
		}
	}
	var limit syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_FSIZE, &limit); err != nil {
		t.Fatal(err)
	}
	small := limit
	small.Cur = 8
	if err := syscall.Setrlimit(syscall.RLIMIT_FSIZE, &small); err != nil {
		t.Fatal(err)
	}
	code, _, diagnostic := runChecks(nil, testDeployment, "maven-deployment", "capture", "--deployment-id-file", path+"3")
	if err := syscall.Setrlimit(syscall.RLIMIT_FSIZE, &limit); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(path + "3"); code != exitFailure || !errors.Is(err, os.ErrNotExist) ||
		diagnostic != "Maven Central deployment identifier could not be stored.\n" {
		t.Fatalf("short write = %d, %q, %v", code, diagnostic, err)
	}
}

func TestMavenDeploymentWait(t *testing.T) {
	directory := t.TempDir()
	path := writeTestFile(t, filepath.Join(directory, "id"), testDeployment+"\n")
	status := centralStatusURL + "?id=" + testDeployment
	state := func(name string) registryReply {
		return registryReply{http.StatusOK, `{"deploymentId": "` + testDeployment + `", "deploymentState": "` + name + `"}`}
	}
	t.Setenv("CENTRAL_PORTAL_USERNAME", "user")
	t.Setenv("CENTRAL_PORTAL_PASSWORD", "value")
	wait := func(replies []registryReply, extra ...string) (int, string, string) {
		arguments := append([]string{"maven-deployment", "wait", "--deployment-id-file", path, "--poll-interval-seconds", "2",
			"--timeout-seconds", "5"}, extra...)
		return runChecks(&fakeRegistry{map[string][]registryReply{status: replies}, map[string]int{}}, "", arguments...)
	}
	for _, test := range []struct {
		replies []registryReply
		extra   []string
		code    int
		want    string
	}{
		{[]registryReply{{http.StatusTooManyRequests, ""}, {0, ""}, {-1, ""}, state("PUBLISHED")}, nil, exitOK,
			"Maven Central deployment published."},
		{[]registryReply{state("PENDING")}, nil, exitFailure, "Maven Central deployment did not finish before timeout."},
		{[]registryReply{state("FAILED")}, nil, exitFailure, "Maven Central deployment failed."},
		{[]registryReply{state("VALIDATED")}, []string{"--once"}, 3, "Maven Central deployment is still processing."},
		{[]registryReply{{http.StatusBadGateway, ""}}, []string{"--once"}, exitFailure, centralUnusable},
		{[]registryReply{{http.StatusUnauthorized, ""}}, nil, exitFailure, centralUnusable},
		{[]registryReply{{http.StatusOK, `{"deploymentId": "x", "deploymentState": "PUBLISHED"}`}}, nil, exitFailure, centralInvalid},
		{[]registryReply{{http.StatusOK, ""}}, nil, exitFailure, centralInvalid},
		{nil, []string{"--request-timeout-seconds", "61"}, exitFailure, centralUnusable},
		{nil, []string{"--timeout-seconds", "0"}, exitFailure, "Maven Central deployment wait is invalid."},
		{nil, []string{"--poll-interval-seconds", "301"}, exitFailure, "Maven Central deployment wait is invalid."},
	} {
		code, output, diagnostic := wait(test.replies, test.extra...)
		if code != test.code || output+diagnostic != test.want+"\n" {
			t.Errorf("%v %v = %d, %q", test.replies, test.extra, code, output+diagnostic)
		}
	}
	arguments := []string{"maven-deployment", "wait", "--deployment-id-file", path}
	if code, _, diagnostic := runChecks(redirecting{}, "", arguments...); code != exitFailure || diagnostic != centralUnusable+"\n" {
		t.Fatalf("redirect = %d, %q", code, diagnostic)
	}
	t.Setenv("CENTRAL_PORTAL_PASSWORD", "")
	if _, _, diagnostic := runChecks(nil, "", arguments...); diagnostic != centralUnusable+"\n" {
		t.Fatalf("no value = %q", diagnostic)
	}
	for file, want := range map[string]string{"relative": deploymentInvalid,
		filepath.Join(directory, "missing"): "Maven Central deployment identifier is unavailable.",
		directory:                           deploymentInvalid} {
		if _, _, diagnostic := runChecks(nil, "", "maven-deployment", "wait", "--deployment-id-file", file); diagnostic != want+"\n" {
			t.Errorf("%s = %q", file, diagnostic)
		}
	}
	writeTestFile(t, path, "x\n")
	if _, _, diagnostic := runChecks(nil, "", arguments...); diagnostic != deploymentInvalid+"\n" {
		t.Fatalf("content = %q", diagnostic)
	}
}
