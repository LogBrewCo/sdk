package main

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const pythonVersion = "1.2.3"

type tarEntry struct {
	name, body string
	kind       byte
}

// tarStream returns a source archive stream with the members and two zero blocks.
func tarStream(entries ...tarEntry) []byte {
	var stream bytes.Buffer
	for _, entry := range entries {
		stream.Write(tarHeaderBlock(entry.name, 0o644, int64(len(entry.body)), 0, entry.kind))
		stream.WriteString(entry.body)
		stream.Write(make([]byte, tarBlocks(int64(len(entry.body)))-int64(len(entry.body))))
	}
	stream.Write(make([]byte, 2*tarBlock))
	return stream.Bytes()
}

// checksummed recomputes a header block's checksum after a field changed.
func checksummed(block []byte) []byte {
	changed := bytes.Clone(block)
	copy(changed[148:156], "        ")
	sum := 0
	for _, character := range changed {
		sum += int(character)
	}
	copy(changed[148:], []byte(strings.Repeat("0", 6-len(itoaOctal(sum)))+itoaOctal(sum)+"\x00"))
	return changed
}

func itoaOctal(value int) string {
	text := ""
	for ; value > 0; value /= 8 {
		text = string(rune('0'+value%8)) + text
	}
	return text
}

func paxEntry(kind byte, records ...string) tarEntry {
	body := ""
	for _, record := range records {
		key, value, _ := strings.Cut(record, "=")
		body += paxRecord(key, value)
	}
	return tarEntry{"././@PaxHeader", body, kind}
}

func pythonMetadata(id, version string) string {
	return "Metadata-Version: 2.4\nName: " + id + "\nVersion: " + version + "\n\nBody\n"
}

func wheelBytes(t *testing.T, candidate pythonPackage, version, metadata string) []byte {
	t.Helper()
	return zipBytes(t, zipMember{name: candidate.prefix + "/", body: ""},
		zipMember{name: candidate.prefix + "-" + version + ".dist-info/METADATA", body: metadata},
		zipMember{name: candidate.prefix + "/__init__.py", body: "VERSION = 1\n", method: zip.Deflate})
}

func sdistBytes(candidate pythonPackage, version, metadata string) []byte {
	base := candidate.prefix + "-" + version
	return gzipSdist(tarStream(tarEntry{base + "/src/a.py", "print(1)\n", '0'}, tarEntry{base, "", '5'},
		tarEntry{base + "/PKG-INFO", metadata, '0'}), 0)
}

func testPythonCatalog(t *testing.T) []pythonPackage {
	t.Helper()
	packages, err := pythonCatalog()
	if err != nil || len(packages) != 4 || packages[0].id != "logbrew-sdk" || packages[0].directory != "logbrew_py" {
		t.Fatalf("catalog %v %v", packages, err)
	}
	return packages
}

// pythonFixture writes valid artifacts for every package and returns the
// artifact root and the version arguments.
func pythonFixture(t *testing.T) (string, []string) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "dist")
	arguments := []string{}
	for _, candidate := range testPythonCatalog(t) {
		writeFixtureFile(t, root, candidate.directory+"/"+candidate.artifact(pythonVersion, "wheel"),
			string(wheelBytes(t, candidate, pythonVersion, pythonMetadata(candidate.id, pythonVersion))))
		writeFixtureFile(t, root, candidate.directory+"/"+candidate.artifact(pythonVersion, "sdist"),
			string(sdistBytes(candidate, pythonVersion, pythonMetadata(candidate.id, pythonVersion))))
		arguments = append(arguments, "--python-version", candidate.id+"="+pythonVersion)
	}
	return root, arguments
}

func runPython(t *testing.T, transport http.RoundTripper, want int, message string, arguments ...string) {
	t.Helper()
	code, output, diagnostic := runArtifacts(transport, append([]string{"python"}, arguments...)...)
	expected := map[bool]string{true: "python release artifacts ok\n"}[want == exitOK]
	failure := map[bool]string{true: "Python release artifacts failed: " + message + "\n"}[want == exitFailure]
	if code != want || output != expected || diagnostic != failure {
		t.Errorf("%q: code %d, output %q, diagnostic %q", arguments, code, output, diagnostic)
	}
}

func createManifest(t *testing.T, root string, versions []string) string {
	t.Helper()
	manifest := filepath.Join(filepath.Dir(root), "manifest.json")
	runPython(t, nil, exitOK, "", append([]string{"create", "--directory", root, "--source-commit", artifactCommit,
		"--manifest", manifest}, versions...)...)
	return manifest
}

func TestPythonArtifactsCreateVerify(t *testing.T) {
	root, versions := pythonFixture(t)
	manifest := createManifest(t, root, versions)
	data, err := os.ReadFile(manifest)
	if err != nil || !bytes.HasPrefix(data, []byte(`{"packages":[{"id":"logbrew-sdk","sdist":{"file":"logbrew_py/`+
		`logbrew_sdk-1.2.3.tar.gz","sha256":"`)) || !bytes.HasSuffix(data, []byte(`],"schemaVersion":1,"sourceCommit":"`+
		artifactCommit+"\"}\n")) {
		t.Fatalf("manifest %s %v", data, err)
	}
	runPython(t, nil, exitOK, "", "verify", "--directory", root, "--manifest", manifest)
	runPython(t, nil, exitOK, "", append([]string{"check-manifest", "--manifest", manifest, "--source-commit",
		artifactCommit}, versions...)...)
	runPython(t, nil, exitFailure, "Python release manifest identity mismatch", append([]string{"check-manifest",
		"--manifest", manifest, "--source-commit", strings.Repeat("b", 40)}, versions...)...)
	other := slices.Clone(versions)
	other[1] = "logbrew-sdk=1.2.4"
	runPython(t, nil, exitFailure, "Python release manifest identity mismatch", append([]string{"check-manifest",
		"--manifest", manifest, "--source-commit", artifactCommit}, other...)...)
	runPython(t, nil, exitFailure, "invalid Python release manifest", append([]string{"check-manifest",
		"--manifest", root, "--source-commit", artifactCommit}, versions...)...)
	runPython(t, nil, exitFailure, "Python release validation requires every public package version",
		"check-manifest", "--manifest", manifest, "--source-commit", artifactCommit)
	writeFixtureFile(t, root, "bad.json", `{"schemaVersion":2}`)
	runPython(t, nil, exitFailure, "invalid Python release manifest schema", append([]string{"check-manifest",
		"--manifest", filepath.Join(root, "bad.json"), "--source-commit", artifactCommit}, versions...)...)
	runPython(t, nil, exitFailure, "invalid Python release manifest schema", "verify", "--directory", root,
		"--manifest", filepath.Join(root, "bad.json"))

	sdist := filepath.Join(root, "logbrew_py", "logbrew_sdk-1.2.3.tar.gz")
	if err := os.WriteFile(sdist, append(sdistBytes(testPythonCatalog(t)[0], pythonVersion,
		pythonMetadata("logbrew-sdk", pythonVersion)), 0), 0o600); err != nil {
		t.Fatal(err)
	}
	runPython(t, nil, exitFailure, "Python release artifact digest or metadata mismatch", "verify", "--directory",
		root, "--manifest", manifest)
	if err := os.Remove(sdist); err != nil {
		t.Fatal(err)
	}
	runPython(t, nil, exitFailure, "Python release artifact digest or metadata mismatch", "verify", "--directory",
		root, "--manifest", manifest)
	if err := os.Mkdir(sdist, 0o700); err != nil {
		t.Fatal(err)
	}
	runPython(t, nil, exitFailure, "Python release artifact digest or metadata mismatch", "verify", "--directory",
		root, "--manifest", manifest)
}

func TestPythonVerifyRebuildsManifest(t *testing.T) {
	root, versions := pythonFixture(t)
	manifest := createManifest(t, root, versions)
	writeFixtureFile(t, root, "logbrew_flask/extra.whl", "x")
	runPython(t, nil, exitFailure, "unexpected artifact: logbrew_flask/extra.whl", "verify", "--directory", root,
		"--manifest", manifest)
	if err := os.Remove(filepath.Join(root, "logbrew_flask/extra.whl")); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(manifest)
	var value map[string]any
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	value["extra"] = true
	extra, _ := json.Marshal(value)
	writeFixtureFile(t, root, "extra.json", string(extra))
	runPython(t, nil, exitFailure, "Python release artifact digest or metadata mismatch", "verify", "--directory",
		root, "--manifest", filepath.Join(root, "extra.json"))
	value["schemaVersion"] = true
	delete(value, "extra")
	equal, _ := json.Marshal(value)
	writeFixtureFile(t, root, "equal.json", string(equal))
	runPython(t, nil, exitOK, "", "verify", "--directory", root, "--manifest", filepath.Join(root, "equal.json"))
}

func TestPythonSelection(t *testing.T) {
	release := pythonRelease{catalog: testPythonCatalog(t)}
	all := []string{"logbrew-sdk=1.0.0", " logbrew-fastapi = 1.0.0+local.1 ", "logbrew-flask=1.0.0\n",
		"logbrew-django=1.0.0-rc.1"}
	versions, err := release.selection(all)
	if err != nil || versions["logbrew-fastapi"] != "1.0.0+local.1" || versions["logbrew-flask"] != "1.0.0" {
		t.Fatalf("selection %v %v", versions, err)
	}
	for raw, message := range map[string]string{
		"logbrew-sdk":        "invalid Python package version selection",
		"unknown=1.0.0":      "invalid Python package version selection",
		"logbrew-sdk=1.0":    "invalid Python package version selection",
		"logbrew-sdk=1.0.0-": "invalid Python package version selection",
		"logbrew-sdk=2.0.0":  "duplicate Python package version selection",
	} {
		if _, err := release.selection(append(slices.Clone(all), raw)); err == nil || err.Error() != message {
			t.Errorf("%q: %v", raw, err)
		}
	}
	if _, err := release.selection(all[:3]); err == nil ||
		err.Error() != "Python release validation requires every public package version" {
		t.Errorf("missing: %v", err)
	}
}

func TestPythonCreateFailures(t *testing.T) {
	root, versions := pythonFixture(t)
	create := func(want string, extra ...string) {
		t.Helper()
		runPython(t, nil, exitFailure, want, append(append([]string{"create", "--directory", root, "--source-commit",
			artifactCommit, "--manifest", filepath.Join(root, "out.json")}, versions...), extra...)...)
	}
	runPython(t, nil, exitFailure, "source commit must be 40 lowercase hexadecimal characters",
		append([]string{"create", "--directory", root, "--source-commit", "A", "--manifest", "m"}, versions...)...)
	create("duplicate Python package version selection", "--python-version", "logbrew-sdk=1.2.3")
	writeFixtureFile(t, root, "logbrew_py/link-0.whl", "x")
	writeFixtureFile(t, root, "logbrew_py/.whl", "x")
	writeFixtureFile(t, root, "logbrew_py/notes.txt", "x")
	if err := os.Mkdir(filepath.Join(root, "logbrew_py", "x.tar.gz"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, "logbrew_flask", "logbrew_flask-1.2.3.tar.gz")); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(root, "logbrew_django")); err != nil {
		t.Fatal(err)
	}
	create("missing artifact: logbrew_flask/logbrew_flask-1.2.3.tar.gz\n" +
		"missing artifact: logbrew_django/logbrew_django-1.2.3-py3-none-any.whl\n" +
		"missing artifact: logbrew_django/logbrew_django-1.2.3.tar.gz\nunexpected artifact: logbrew_py/link-0.whl")

	root, versions = pythonFixture(t)
	writeFixtureFile(t, root, "logbrew_flask/logbrew_flask-1.2.3-py3-none-any.whl", "")
	writeFixtureFile(t, root, "logbrew_fastapi/logbrew_fastapi-1.2.3-py3-none-any.whl", "")
	create("logbrew-fastapi: invalid wheel archive")

	root, versions = pythonFixture(t)
	if err := os.MkdirAll(filepath.Join(root, "file"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeFixtureFile(t, root, "file/f", "")
	runPython(t, nil, exitFailure, "mkdir "+filepath.Join(root, "file", "f")+": not a directory",
		append([]string{"create", "--directory", root, "--source-commit", artifactCommit, "--manifest",
			filepath.Join(root, "file", "f", "m.json")}, versions...)...)
}

func TestPythonWheelValidation(t *testing.T) {
	candidate := testPythonCatalog(t)[0]
	valid := wheelBytes(t, candidate, pythonVersion, pythonMetadata(candidate.id, pythonVersion))
	metadataName := candidate.prefix + "-" + pythonVersion + ".dist-info/METADATA"
	empty := zipBytes(t, zipMember{name: metadataName})
	shortened := patched(empty, centralRecord(empty, 0)+24, 5)
	unsupported := patched(valid, centralRecord(valid, 1)+10, 99)
	broken := patched(valid, centralRecord(valid, 1), 'X')
	for _, test := range []struct {
		data    []byte
		err     error
		message string
	}{
		{valid, nil, ""},
		{valid, os.ErrNotExist, "invalid wheel archive"},
		{nil, nil, "invalid wheel archive"},
		{broken, nil, "invalid wheel archive"},
		{unsupported, nil, "invalid wheel archive"},
		{zipBytes(t, zipMember{name: "../x"}), nil, "invalid wheel entries"},
		{zipBytes(t, zipMember{name: "a.py"}), nil, "expected one wheel metadata file"},
		{zipBytes(t, zipMember{name: metadataName, body: strings.Repeat("x", maxPythonMetadataBytes+1)}), nil,
			"invalid wheel entries"},
		{shortened, nil, "invalid wheel entries"},
		{zipBytes(t, zipMember{name: metadataName, body: "Name: \xff"}), nil, "invalid package metadata"},
		{zipBytes(t, zipMember{name: metadataName, body: "Name: other\nVersion: 1.2.3\n"}), nil,
			"package metadata mismatch"},
	} {
		err := validateWheel(test.data, test.err, candidate.id, pythonVersion)
		if test.message == "" && err != nil || test.message != "" && (err == nil || err.Error() != candidate.id+": "+test.message) {
			t.Errorf("%q: %v", test.message, err)
		}
	}
}

func TestPythonSdistValidation(t *testing.T) {
	candidate := testPythonCatalog(t)[0]
	name := candidate.artifact(pythonVersion, "sdist")
	base := candidate.prefix + "-" + pythonVersion
	metadata := pythonMetadata(candidate.id, pythonVersion)
	for _, test := range []struct {
		data    []byte
		err     error
		message string
	}{
		{sdistBytes(candidate, pythonVersion, metadata), nil, ""},
		{nil, os.ErrNotExist, "invalid source archive"},
		{[]byte("not gzip"), nil, "invalid source archive"},
		{gzipSdist(tarStream(tarEntry{"../x", "", '0'}), 0), nil, "invalid source archive entries"},
		{gzipSdist(tarStream(tarEntry{base + "/setup.py", "", '0'}), 0), nil, "expected one source metadata file"},
		{gzipSdist(tarStream(tarEntry{base + "/PKG-INFO", "", '5'}), 0), nil, "expected one source metadata file"},
		{gzipSdist(tarStream(tarEntry{base + "/PKG-INFO", strings.Repeat("x", maxPythonMetadataBytes+1), '0'}), 0),
			nil, "invalid source archive entries"},
		{gzipSdist(tarStream(paxEntry('g', "size=4000"), tarEntry{base + "/PKG-INFO", metadata, '0'}), 0), nil,
			"invalid source archive"},
		{gzipSdist(tarStream(tarEntry{base + "/PKG-INFO", "Version: 1.2.3\n", '0'}), 0), nil,
			"package metadata mismatch"},
	} {
		err := validateSdist(test.data, test.err, candidate.id, pythonVersion, name)
		if test.message == "" && err != nil || test.message != "" && (err == nil || err.Error() != candidate.id+": "+test.message) {
			t.Errorf("%q: %v", test.message, err)
		}
	}
}

func TestMetadataHeader(t *testing.T) {
	for _, test := range []struct {
		text, name, value string
		found             bool
	}{
		{"Name: a\nVersion: 1\n", "name", "a", true},
		{"NAME:\ta \r\n", "name", "a ", true},
		{"Name: a\r", "name", "a", true},
		{"Name:a", "name", "a", true},
		{"Name: a\n b\n\tc\nX: y\n", "name", "a\n b\n\tc", true},
		{"Name:\n b\n", "name", "\n b", true},
		{" lead\nName: a\n", "name", "a", true},
		{"From x\nName: a\n", "name", "a", true},
		{"Name: a\nFrom x\n more\n", "name", "a", true},
		{"Other: 1\nFrom x\n more\nName: b\n", "name", "b", true},
		{":x\n more\nName: c\n", "name", "c", true},
		{"Summary: s\nName: a\nName: b\n", "name", "a", true},
		{"Summary: s\n\nName: a\n", "name", "", false},
		{"Bad Header\nName: a\n", "name", "", false},
		{"\ufeffName: a\n", "name", "", false},
		{"Naïme: a\nName: b\n", "name", "", false},
		{"X-Name: a\n", "name", "", false},
		{"", "name", "", false},
	} {
		value, found := metadataHeader(test.text, test.name)
		if value != test.value || found != test.found {
			t.Errorf("%q: %q %v", test.text, value, found)
		}
	}
}

func TestPythonManifestVersions(t *testing.T) {
	release := pythonRelease{catalog: testPythonCatalog(t)}
	root, versions := pythonFixture(t)
	data, _ := os.ReadFile(createManifest(t, root, versions))
	for _, test := range []struct {
		change  func(map[string]any)
		message string
	}{
		{func(map[string]any) {}, ""},
		{func(manifest map[string]any) { manifest["schemaVersion"] = json.Number("1.0") }, ""},
		{func(manifest map[string]any) {
			pythonArtifact(manifest, 0, "wheel")["sha256"] = json.Number(strings.Repeat("1", 64))
		}, ""},
		{func(manifest map[string]any) { delete(manifest, "schemaVersion") }, "invalid Python release manifest schema"},
		{func(manifest map[string]any) { manifest["schemaVersion"] = "1" }, "invalid Python release manifest schema"},
		{func(manifest map[string]any) { manifest["sourceCommit"] = 5 }, "invalid Python release manifest"},
		{func(manifest map[string]any) { manifest["packages"] = manifest["packages"].([]any)[1:] },
			"invalid Python release manifest"},
		{func(manifest map[string]any) { manifest["packages"].([]any)[0] = "x" },
			"invalid Python release manifest package order"},
		{func(manifest map[string]any) { pythonEntry(manifest, 1)["extra"] = 1 },
			"invalid Python release manifest package order"},
		{func(manifest map[string]any) { pythonEntry(manifest, 1)["id"] = "logbrew-sdk" },
			"invalid Python release manifest package"},
		{func(manifest map[string]any) { pythonEntry(manifest, 1)["version"] = 1 },
			"invalid Python release manifest package"},
		{func(manifest map[string]any) { pythonEntry(manifest, 2)["sdist"] = "x" },
			"invalid Python release manifest artifact"},
		{func(manifest map[string]any) { pythonArtifact(manifest, 2, "sdist")["extra"] = 1 },
			"invalid Python release manifest artifact"},
		{func(manifest map[string]any) { pythonArtifact(manifest, 2, "sdist")["file"] = "x" },
			"invalid Python release manifest artifact"},
		{func(manifest map[string]any) {
			pythonArtifact(manifest, 3, "wheel")["sha256"] = strings.Repeat("A", 64)
		},
			"invalid Python release manifest artifact"},
		{func(manifest map[string]any) { pythonArtifact(manifest, 3, "wheel")["sha256"] = json.Number("1e63") },
			"invalid Python release manifest artifact"},
		{func(manifest map[string]any) { pythonArtifact(manifest, 3, "wheel")["sha256"] = true },
			"invalid Python release manifest artifact"},
	} {
		value, _ := decodePlanJSON(data)
		manifest := value.(map[string]any)
		test.change(manifest)
		parsed, err := release.manifestVersions(manifest)
		if test.message == "" && (err != nil || parsed["logbrew-django"] != pythonVersion) ||
			test.message != "" && (err == nil || err.Error() != test.message) {
			t.Errorf("%q: %v %v", test.message, parsed, err)
		}
	}
	for text, message := range map[string]string{"[]": "invalid Python release manifest", "{": "invalid Python release manifest"} {
		writeFixtureFile(t, root, "m.json", text)
		if _, err := loadPythonManifest(filepath.Join(root, "m.json")); err == nil || err.Error() != message {
			t.Errorf("%q: %v", text, err)
		}
	}
}

func pythonEntry(manifest map[string]any, index int) map[string]any {
	return manifest["packages"].([]any)[index].(map[string]any)
}

func pythonArtifact(manifest map[string]any, index int, kind string) map[string]any {
	return pythonEntry(manifest, index)[kind].(map[string]any)
}

func TestPythonNormalizeSdist(t *testing.T) {
	candidate := testPythonCatalog(t)[0]
	directory := t.TempDir()
	stream := tarStream(tarEntry{"pkg-1/b.py", "b", '0'}, tarEntry{"pkg-1", "", '5'},
		paxEntry('x', "path=pkg-1/"+strings.Repeat("é", 60)), tarEntry{"placeholder", "long", '0'},
		paxEntry('x', "path=pkg-1/"+strings.Repeat("l", 120)), tarEntry{"placeholder", "", '0'},
		tarEntry{"pkg-1/\xff.py", "raw", '7'},
		tarEntry{"pkg-1/sub/", "", 0})
	stream = append(stream, make([]byte, 512)...)
	first := filepath.Join(directory, "first.tar.gz")
	writeFixtureFile(t, directory, "first.tar.gz", string(gzipSdist(stream, 99)))
	writeFixtureFile(t, directory, "second.tar.gz", string(sdistBytes(candidate, pythonVersion, "x")))
	runPython(t, nil, exitOK, "", "normalize-sdist", "--source-date-epoch", " 1_700_000_000 ", first,
		filepath.Join(directory, "second.tar.gz"))
	data, err := os.ReadFile(first)
	info, statErr := os.Stat(first)
	normalized, gzipErr := gunzip(data, maxTarStreamBytes)
	if err != nil || statErr != nil || gzipErr != nil || info.Mode().Perm() != 0o644 ||
		binary.LittleEndian.Uint32(data[4:]) != 1_700_000_000 || len(normalized)%tarRecord != 0 {
		t.Fatalf("normalized %v %v %v %v", err, statErr, gzipErr, info)
	}
	names := []string{}
	reader := &tarReader{stream: normalized, global: map[string]string{}}
	for member, err := reader.next(); member != nil || err != nil; member, err = reader.next() {
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, member.name+":"+string(member.kind))
	}
	if !slices.Equal(names, []string{"pkg-1:5", "pkg-1/b.py:0", "pkg-1/" + strings.Repeat("l", 120) + ":0",
		"pkg-1/sub:5", "pkg-1/" + strings.Repeat("é", 60) + ":0", "pkg-1/\xff.py:0"}) {
		t.Errorf("names %q", names)
	}
	again := bytes.Clone(data)
	runPython(t, nil, exitOK, "", "normalize-sdist", "--source-date-epoch=1700000000", first)
	if data, _ := os.ReadFile(first); !bytes.Equal(data, again) {
		t.Error("normalizing twice changed the archive")
	}

	writeFixtureFile(t, directory, "bad.tar.gz", "x")
	writeFixtureFile(t, directory, "entries.tar.gz", string(gzipSdist(tarStream(tarEntry{"/abs", "", '0'}), 0)))
	writeFixtureFile(t, directory, "data.tar.gz", string(gzipSdist(tarStream(paxEntry('g', "size=4000"),
		tarEntry{"a", "", '0'}), 0)))
	many := []tarEntry{}
	for index := range 600 {
		block := tarHeaderBlock(strings.Repeat("n", 99)+string(rune('a'+index%26)), 0o644, 0, 0, '0')
		copy(block[345:], strings.Repeat("p", 10)+itoaOctal(index))
		many = append(many, tarEntry{string(checksummed(block)), "", 0})
	}
	var manyStream bytes.Buffer
	for _, entry := range many {
		manyStream.WriteString(entry.name)
	}
	manyStream.Write(make([]byte, 1024))
	writeFixtureFile(t, directory, "many.tar.gz", string(gzipSdist(manyStream.Bytes(), 0)))
	for name, message := range map[string]string{
		"missing.tar.gz": "invalid source archive", "bad.tar.gz": "invalid source archive",
		"entries.tar.gz": "invalid source archive entries", "data.tar.gz": "invalid source archive",
		"many.tar.gz": "invalid normalized source archive",
	} {
		runPython(t, nil, exitFailure, message, "normalize-sdist", "--source-date-epoch", "1",
			filepath.Join(directory, name))
	}
	for _, epoch := range []string{"-1", "4294967296"} {
		runPython(t, nil, exitFailure, "invalid source date epoch", "normalize-sdist", "--source-date-epoch", epoch, first)
	}
	locked := filepath.Join(directory, "locked")
	writeFixtureFile(t, locked, "a.tar.gz", string(sdistBytes(candidate, pythonVersion, "x")))
	if err := os.Chmod(locked, 0o500); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(locked, 0o700)
	runPython(t, nil, exitFailure, "invalid source archive", "normalize-sdist", "--source-date-epoch", "1",
		filepath.Join(locked, "a.tar.gz"))
}

func TestPythonUsage(t *testing.T) {
	for _, arguments := range [][]string{
		{"python"}, {"python", "other"}, {"python", "verify", "--directory", "d"},
		{"python", "verify", "--directory", "d", "--manifest", "m", "extra"},
		{"python", "verify", "--directory", "d", "--manifest", "m", "--python-version", "x"},
		{"python", "normalize-sdist", "--source-date-epoch", "1"},
		{"python", "normalize-sdist", "--source-date-epoch", "x", "a.tar.gz"},
		{"python", "normalize-sdist", "--source-date-epoch", strings.Repeat("9", maxPyIntDigits+1), "a.tar.gz"},
	} {
		code, output, diagnostic := runArtifacts(nil, arguments...)
		if code != exitUsage || output != "" || diagnostic != releaseArtifactsUsage {
			t.Errorf("%q: code %d, output %q, diagnostic %q", arguments, code, output, diagnostic)
		}
	}
	original := releaseCatalogText
	releaseCatalogText = "rust = 1\n"
	defer func() { releaseCatalogText = original }()
	code, _, diagnostic := runArtifacts(nil, "python", "verify", "--directory", "d", "--manifest", "m")
	if code != exitFailure || !strings.HasPrefix(diagnostic, "Python release artifacts failed: toml:") {
		t.Errorf("catalog: %d %q", code, diagnostic)
	}
}

// pypiRegistry serves PyPI metadata and files for the fixture artifacts.
func pypiRegistry(t *testing.T, root string) publicRegistry {
	t.Helper()
	registry := publicRegistry{}
	for _, candidate := range testPythonCatalog(t) {
		files := []any{}
		for _, kind := range pythonKinds {
			name := candidate.artifact(pythonVersion, kind)
			data, err := os.ReadFile(filepath.Join(root, candidate.directory, name))
			if err != nil {
				t.Fatal(err)
			}
			address := "https://" + pypiFileOrigin + "/packages/" + kind + "/" + name
			registry[address] = &publicResponse{body: data}
			files = append(files, map[string]any{"filename": name, "url": address, "digests": map[string]any{
				"sha256": sha256Hex(data)}, "packagetype": map[string]string{"wheel": "bdist_wheel", "sdist": "sdist"}[kind]})
		}
		body, _ := json.Marshal(map[string]any{"info": map[string]any{"name": candidate.id, "version": pythonVersion},
			"urls": files})
		registry[pypiAPIRoot+candidate.id+"/"+pythonVersion+"/json"] = &publicResponse{body: body}
	}
	return registry
}

func resolveArguments(root, manifest string) []string {
	output := filepath.Dir(root)
	return []string{"resolve-public", "--directory", root, "--manifest", manifest, "--output-directory",
		filepath.Join(output, "public"), "--public-manifest", filepath.Join(output, "receipts", "public.json"),
		"--reconciliation", filepath.Join(output, "receipts", "reconciliation.json")}
}

func TestPythonResolvePublic(t *testing.T) {
	root, versions := pythonFixture(t)
	manifest := createManifest(t, root, versions)
	registry := pypiRegistry(t, root)
	built := filepath.Join(root, "logbrew_flask", "logbrew_flask-1.2.3.tar.gz")
	published := registry["https://"+pypiFileOrigin+"/packages/sdist/logbrew_flask-1.2.3.tar.gz"]
	stream, _ := gunzip(published.body, maxTarStreamBytes)
	published.body = gzipSdist(stream, 7)
	metadataURL := pypiAPIRoot + "logbrew-flask/1.2.3/json"
	var metadata map[string]any
	_ = json.Unmarshal(registry[metadataURL].body, &metadata)
	metadata["urls"].([]any)[1].(map[string]any)["digests"] = map[string]any{"sha256": sha256Hex(published.body)}
	registry[metadataURL].body, _ = json.Marshal(metadata)
	runPython(t, registry, exitOK, "", resolveArguments(root, manifest)...)
	output := filepath.Dir(root)
	public, _ := os.ReadFile(filepath.Join(output, "public", "logbrew_flask", "logbrew_flask-1.2.3.tar.gz"))
	data, _ := os.ReadFile(filepath.Join(output, "receipts", "reconciliation.json"))
	var receipt map[string]any
	if err := json.Unmarshal(data, &receipt); err != nil || !bytes.Equal(public, published.body) {
		t.Fatalf("receipt %s %v", data, err)
	}
	flask := receipt["packages"].([]any)[2].(map[string]any)
	builtData, _ := os.ReadFile(built)
	content, _ := archiveContentSHA256(builtData, "sdist")
	if flask["sdist"].(map[string]any)["publicationState"] != "existing" ||
		flask["wheel"].(map[string]any)["publicationState"] != "source-build" ||
		flask["sdist"].(map[string]any)["contentSha256"] != content || receipt["sourceCommit"] != artifactCommit {
		t.Errorf("receipt %v", flask)
	}
	runPython(t, nil, exitOK, "", "verify", "--directory", filepath.Join(output, "public"), "--manifest",
		filepath.Join(output, "receipts", "public.json"))
	runPython(t, registry, exitFailure, "public artifact verification failed", resolveArguments(root, manifest)...)
}

func TestPythonResolvePublicFailures(t *testing.T) {
	root, versions := pythonFixture(t)
	manifest := createManifest(t, root, versions)
	output := filepath.Dir(root)
	sdkWheel := "https://" + pypiFileOrigin + "/packages/wheel/logbrew_sdk-1.2.3-py3-none-any.whl"
	for name, change := range map[string]func(publicRegistry){
		"offline":  func(registry publicRegistry) { delete(registry, pypiAPIRoot+"logbrew-django/1.2.3/json") },
		"download": func(registry publicRegistry) { delete(registry, sdkWheel) },
		"digest":   func(registry publicRegistry) { registry[sdkWheel].body = append(registry[sdkWheel].body, 0) },
		"content": func(registry publicRegistry) {
			candidate := testPythonCatalog(t)[0]
			body := wheelBytes(t, candidate, pythonVersion, pythonMetadata(candidate.id, pythonVersion)+"x")
			setPythonFile(t, registry, candidate, "wheel", body)
		},
		"archive": func(registry publicRegistry) {
			setPythonFile(t, registry, testPythonCatalog(t)[0], "wheel", []byte("x"))
		},
	} {
		registry := pypiRegistry(t, root)
		change(registry)
		runPython(t, registry, exitFailure, "public artifact verification failed", resolveArguments(root, manifest)...)
		if entries, _ := os.ReadDir(output); len(entries) != 2 {
			t.Errorf("%s left %v", name, entries)
		}
	}
	registry := pypiRegistry(t, root)
	runPython(t, registry, exitFailure, "invalid Python release manifest", resolveArguments(root, root)...)
	writeFixtureFile(t, output, "schema.json", `{"schemaVersion":1}`)
	runPython(t, registry, exitFailure, "invalid Python release manifest",
		resolveArguments(root, filepath.Join(output, "schema.json"))...)
	writeFixtureFile(t, root, "logbrew_py/extra.whl", "")
	runPython(t, registry, exitFailure, "unexpected artifact: logbrew_py/extra.whl", resolveArguments(root, manifest)...)
	if err := os.Remove(filepath.Join(root, "logbrew_py/extra.whl")); err != nil {
		t.Fatal(err)
	}

	arguments := resolveArguments(root, manifest)
	arguments[6] = filepath.Join(output, "schema.json", "public")
	runPython(t, registry, exitFailure, "public artifact verification failed", arguments...)
	arguments[6] = filepath.Join(output, "schema.json")
	runPython(t, registry, exitFailure, "public artifact verification failed", arguments...)
	locked := filepath.Join(output, "locked")
	if err := os.Mkdir(locked, 0o500); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(locked, 0o700)
	arguments[6] = filepath.Join(locked, "public")
	runPython(t, registry, exitFailure, "public artifact verification failed", arguments...)
	arguments = resolveArguments(root, manifest)
	arguments[10] = filepath.Join(output, "schema.json", "public.json")
	runPython(t, registry, exitFailure, "mkdir "+filepath.Dir(arguments[10])+": not a directory", arguments...)
}

func setPythonFile(t *testing.T, registry publicRegistry, candidate pythonPackage, kind string, body []byte) {
	t.Helper()
	name := candidate.artifact(pythonVersion, kind)
	registry["https://"+pypiFileOrigin+"/packages/"+kind+"/"+name].body = body
	metadataURL := pypiAPIRoot + candidate.id + "/" + pythonVersion + "/json"
	var metadata map[string]any
	if err := json.Unmarshal(registry[metadataURL].body, &metadata); err != nil {
		t.Fatal(err)
	}
	for _, file := range metadata["urls"].([]any) {
		if file.(map[string]any)["filename"] == name {
			file.(map[string]any)["digests"] = map[string]any{"sha256": sha256Hex(body)}
		}
	}
	registry[metadataURL].body, _ = json.Marshal(metadata)
}

func TestPythonPublicFiles(t *testing.T) {
	candidate := testPythonCatalog(t)[0]
	wheel, sdist := candidate.artifact(pythonVersion, "wheel"), candidate.artifact(pythonVersion, "sdist")
	entry := func(name, kind string) map[string]any {
		return map[string]any{"filename": name, "packagetype": kind, "digests": map[string]any{"sha256": strings.Repeat("a", 64)},
			"url": "https://" + pypiFileOrigin + "/p/" + name}
	}
	metadataURL := pypiAPIRoot + "logbrew-sdk/1.2.3/json"
	for _, test := range []struct {
		body any
		ok   bool
	}{
		{map[string]any{"info": map[string]any{"name": "logbrew-sdk", "version": pythonVersion},
			"urls": []any{entry(sdist, "sdist"), entry(wheel, "bdist_wheel")}}, true},
		{"\ufeff", false},
		{[]any{}, false},
		{map[string]any{"info": map[string]any{"name": "other", "version": pythonVersion}, "urls": []any{}}, false},
		{map[string]any{"info": map[string]any{"name": "logbrew-sdk", "version": "1.2.4"}, "urls": []any{}}, false},
		{map[string]any{"info": map[string]any{"name": "logbrew-sdk", "version": pythonVersion}, "urls": "x"}, false},
		{map[string]any{"info": map[string]any{"name": "logbrew-sdk", "version": pythonVersion},
			"urls": []any{entry(wheel, "bdist_wheel")}}, false},
		{map[string]any{"info": map[string]any{"name": "logbrew-sdk", "version": pythonVersion},
			"urls": []any{entry(wheel, "bdist_wheel"), entry(wheel, "bdist_wheel")}}, false},
		{map[string]any{"info": map[string]any{"name": "logbrew-sdk", "version": pythonVersion},
			"urls": []any{entry(wheel, "sdist")}}, false},
		{map[string]any{"info": map[string]any{"name": "logbrew-sdk", "version": pythonVersion},
			"urls": []any{entry("other.whl", "bdist_wheel")}}, false},
		{map[string]any{"info": map[string]any{"name": "logbrew-sdk", "version": pythonVersion}, "urls": []any{5}}, false},
	} {
		body, _ := json.Marshal(test.body)
		if text, ok := test.body.(string); ok {
			body = []byte(text + `{"info":{"name":"logbrew-sdk","version":"1.2.3"},"urls":[]}`)
		}
		registry := publicRegistry{metadataURL: {body: body}}
		files, err := pythonRelease{transport: registry}.publicFiles(candidate, pythonVersion)
		if test.ok != (err == nil) || test.ok && !slices.Equal(slices.Sorted(maps.Keys(files)), []string{wheel, sdist}) {
			t.Errorf("%s: %v %v", body, files, err)
		}
	}
	unsigned := map[string]any{"filename": wheel, "packagetype": "bdist_wheel", "url": "https://" + pypiFileOrigin + "/p/" + wheel}
	body, _ := json.Marshal(map[string]any{"info": map[string]any{"name": "logbrew-sdk", "version": pythonVersion},
		"urls": []any{unsigned}})
	if _, err := (pythonRelease{transport: publicRegistry{metadataURL: {body: body}}}).publicFiles(candidate,
		pythonVersion); err == nil {
		t.Error("unsigned file accepted")
	}
}

func TestPublicFileURL(t *testing.T) {
	name := "a-1.0.0-py3-none-any.whl"
	for _, test := range []struct {
		raw     any
		address string
		ok      bool
	}{
		{"https://files.pythonhosted.org/p/" + name, "https://files.pythonhosted.org/p/" + name, true},
		{" \tHTTPS://files.pythonhosted.org/p/./" + name + "/.\n", "HTTPS://files.pythonhosted.org/p/./" + name + "/.", true},
		{"https://files.pythonhosted.org/" + name + "?#", "https://files.pythonhosted.org/" + name + "?#", true},
		{"https://files.pythonhosted.org//p/" + name, "https://files.pythonhosted.org//p/" + name, true},
		{5, "", false},
		{"http://files.pythonhosted.org/p/" + name, "", false},
		{"https://files.pythonhosted.org:443/p/" + name, "", false},
		{"https://files.pythonhosted.org/p/" + name + "?x=1", "", false},
		{"https://files.pythonhosted.org/p/" + name + "#x", "", false},
		{"https://files.pythonhosted.org/p%2F/" + name, "", false},
		{"https://files.pythonhosted.org/../" + name, "", false},
		{"https://files.pythonhosted.org/p/other.whl", "", false},
		{"https://files.pythonhosted.org", "", false},
		{"https:files.pythonhosted.org/" + name, "", false},
		{"//files.pythonhosted.org/" + name, "", false},
		{"1https://files.pythonhosted.org/" + name, "", false},
		{"ht_tps://files.pythonhosted.org/" + name, "", false},
		{"https://files.pythonhosted.org/p q/" + name, "", false},
		{"https://files.pythonhosted.org/p\t/" + name, "", false},
		{"\x01https://files.pythonhosted.org/p/" + name, "", false},
		{"https://files.pythonhosted.org/é/" + name, "", false},
		{"https://files.pythonhosted.org/p|/" + name, "", false},
	} {
		address, ok := publicFileURL(test.raw, name)
		if ok != test.ok || ok && address != test.address {
			t.Errorf("%q: %q %v", test.raw, address, ok)
		}
	}
}

func TestFetchPython(t *testing.T) {
	address := "https://" + pypiFileOrigin + "/f"
	for _, test := range []struct {
		response *publicResponse
		ok       bool
	}{
		{&publicResponse{body: []byte("abc"), encoding: []string{"gzip"}}, true},
		{&publicResponse{body: []byte("abcd")}, false},
		{&publicResponse{body: []byte("a"), status: http.StatusAccepted}, false},
		{&publicResponse{body: []byte("a"), status: http.StatusFound, location: "https://example.com/"}, false},
		{nil, false},
	} {
		registry := publicRegistry{}
		if test.response != nil {
			registry[address] = test.response
		}
		body, err := fetchPython(registry, address, 3, 0)
		if test.ok != (err == nil) || test.ok && string(body) != "abc" {
			t.Errorf("%v: %q %v", test.response, body, err)
		}
	}
}

func TestArchiveContentSHA256(t *testing.T) {
	candidate := testPythonCatalog(t)[0]
	wheel := wheelBytes(t, candidate, pythonVersion, "m")
	withDirectory, err := archiveContentSHA256(wheel, "wheel")
	if err != nil {
		t.Fatal(err)
	}
	without, _ := archiveContentSHA256(zipBytes(t, zipMember{name: candidate.prefix + "/__init__.py", body: "VERSION = 1\n"},
		zipMember{name: candidate.prefix + "-" + pythonVersion + ".dist-info/METADATA", body: "m"}), "wheel")
	if withDirectory != without {
		t.Error("wheel directories or member order changed the digest")
	}
	first, err := archiveContentSHA256(gzipSdist(tarStream(tarEntry{"b", "2", '0'}, tarEntry{"a", "1", '0'},
		tarEntry{"d", "", '5'}), 0), "sdist")
	second, _ := archiveContentSHA256(gzipSdist(tarStream(tarEntry{"a", "1", '0'}, tarEntry{"b", "2", '7'}), 9), "sdist")
	if err != nil || first != second || len(first) != 64 {
		t.Errorf("sdist digests %q %q %v", first, second, err)
	}
	for _, data := range [][]byte{
		gzipSdist(tarStream(tarEntry{"\xff", "1", '0'}), 0),
		gzipSdist(tarStream(paxEntry('g', "size=4000"), tarEntry{"a", "", '0'}), 0),
		[]byte("x"),
	} {
		if _, err := archiveContentSHA256(data, "sdist"); err == nil {
			t.Errorf("%q accepted", data)
		}
	}
}
