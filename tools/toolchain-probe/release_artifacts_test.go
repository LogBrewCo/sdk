package main

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"hash/crc32"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	artifactCommit = "0123456789abcdef0123456789abcdef01234567"
	nuspecRange    = `<dependencies><group targetFramework="net8.0"><dependency id="LogBrew" version="[0.1.11, 0.2.0)"/>` +
		`</group></dependencies>`
)

type zipMember struct {
	name, body string
	method     uint16
	extra      []byte
}

func zipBytes(t *testing.T, members ...zipMember) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, member := range members {
		target, err := writer.CreateHeader(&zip.FileHeader{Name: member.name, Method: member.method, Extra: member.extra})
		if err == nil {
			_, err = target.Write([]byte(member.body))
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

// centralRecord returns the offset of an archive's indexed central directory record.
func centralRecord(data []byte, index int) int {
	offset := int(binary.LittleEndian.Uint32(data[len(data)-6:]))
	for ; index > 0; index-- {
		offset += 46 + int(binary.LittleEndian.Uint16(data[offset+28:])) +
			int(binary.LittleEndian.Uint16(data[offset+30:])) + int(binary.LittleEndian.Uint16(data[offset+32:]))
	}
	return offset
}

func patched(data []byte, offset int, value ...byte) []byte {
	changed := bytes.Clone(data)
	copy(changed[offset:], value)
	return changed
}

func flipped(data []byte, offset int) []byte {
	changed := bytes.Clone(data)
	changed[offset] ^= 0xff
	return changed
}

func nuspecText(id, version, commit, dependencies string) string {
	return `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">` +
		"<metadata><id>" + id + "</id><version>" + version + `</version><repository type="git" url="` + sdkRepoURL +
		`" commit="` + commit + `"/>` + dependencies + "</metadata></package>"
}

// writeDotnetPackages writes a package and its symbols with the given nuspec.
func writeDotnetPackages(t *testing.T, directory, id, version, nuspec string) {
	t.Helper()
	writeFixtureFile(t, directory, id+"."+version+".nupkg", string(zipBytes(t, zipMember{name: id + ".nuspec", body: nuspec},
		zipMember{name: "lib/net8.0/" + id + ".dll", body: "assembly", method: zip.Deflate},
		zipMember{name: "lib/net8.0/" + id + ".xml", body: "<doc/>"})))
	writeFixtureFile(t, directory, id+"."+version+".snupkg", string(zipBytes(t, zipMember{name: id + ".nuspec", body: nuspec},
		zipMember{name: "lib/net8.0/" + id + ".pdb", body: sourceLinkRoot + "/" + artifactCommit})))
}

func runArtifacts(transport http.RoundTripper, arguments ...string) (int, string, string) {
	var output, diagnostic bytes.Buffer
	code := checkReleaseArtifacts(arguments, transport, &output, &diagnostic)
	return code, output.String(), diagnostic.String()
}

func dotnetArguments(directory string, extra ...string) []string {
	return append([]string{"dotnet", "--directory", directory, "--source-commit", artifactCommit,
		"--manifest", filepath.Join(directory, "out", "manifest.json")}, extra...)
}

func TestReleaseArtifactsDotnet(t *testing.T) {
	directory := t.TempDir()
	writeDotnetPackages(t, directory, "LogBrew", "0.1.11", nuspecText("LogBrew", "0.1.11", artifactCommit, ""))
	writeDotnetPackages(t, directory, "LogBrew.HttpClient", "0.1.6",
		nuspecText("LogBrew.HttpClient", "0.1.6", artifactCommit, nuspecRange))
	selection := []string{"--nuget-version", "LogBrew=0.1.11", "--nuget-version", " LogBrew.HttpClient = 0.1.6",
		"--dependency-range", "LogBrew.HttpClient:LogBrew=[0.1.11, 0.2.0)"}
	code, output, diagnostic := runArtifacts(nil, dotnetArguments(directory, selection...)...)
	if code != exitOK || !strings.HasSuffix(output, "dotnet release artifacts ok\n") || diagnostic != "" {
		t.Fatalf("code %d, output %q, diagnostic %q", code, output, diagnostic)
	}
	_, digest, _ := runArtifacts(nil, "nuget-content", filepath.Join(directory, "LogBrew.0.1.11.nupkg"))
	manifest := readText(t, filepath.Join(directory, "out", "manifest.json"))
	if !strings.Contains(output, "content_sha256="+strings.TrimSpace(digest)) ||
		!strings.Contains(manifest, `"nupkgContentSha256":"`+strings.TrimSpace(digest)+`"`) {
		t.Fatalf("output %q, manifest %q", output, manifest)
	}
	code, _, diagnostic = runArtifacts(nil, dotnetArguments(directory, append(selection,
		"--manifest", filepath.Join(directory, "LogBrew.0.1.11.nupkg", "manifest.json"))...)...)
	if code != exitFailure || diagnostic != "cannot write the release artifact manifest\n" {
		t.Fatalf("code %d, diagnostic %q", code, diagnostic)
	}
}

func TestReleaseArtifactsSelection(t *testing.T) {
	directory := t.TempDir()
	httpRange := "LogBrew.HttpClient:LogBrew=[0.1.11, 0.2.0)"
	for _, test := range []struct {
		diagnostic string
		arguments  []string
	}{
		{"--source-commit must be 40 lowercase hexadecimal characters", []string{"--source-commit", "ABC"}},
		{"invalid NuGet package version selection", []string{"--nuget-version", "Other=1.0.0"}},
		{"invalid NuGet package version selection", []string{"--nuget-version", "LogBrew"}},
		{"duplicate NuGet package selection: LogBrew",
			[]string{"--nuget-version", "LogBrew=0.1.11", "--nuget-version", "LogBrew=0.1.12"}},
		{"missing NuGet package version selection", nil},
		{"invalid NuGet dependency range selection",
			[]string{"--nuget-version", "LogBrew=0.1.11", "--dependency-range", "LogBrew.HttpClient=[0.1.11, 0.2.0)"}},
		{"invalid NuGet dependency range selection",
			[]string{"--nuget-version", "LogBrew=0.1.11", "--dependency-range", "LogBrew.HttpClient:LogBrew=0.1.11"}},
		{"duplicate NuGet dependency range selection", []string{"--nuget-version", "LogBrew.HttpClient=0.1.6",
			"--dependency-range", httpRange, "--dependency-range", httpRange}},
		{"dependency range package must be selected for validation",
			[]string{"--nuget-version", "LogBrew=0.1.11", "--dependency-range", httpRange}},
		{"missing HttpClient core dependency range", []string{"--nuget-version", "LogBrew.HttpClient=0.1.6"}},
		{"HttpClient core dependency range does not match selected core version", []string{"--nuget-version",
			"LogBrew=0.1.12", "--nuget-version", "LogBrew.HttpClient=0.1.6", "--dependency-range", httpRange}},
	} {
		code, output, diagnostic := runArtifacts(nil, dotnetArguments(directory, test.arguments...)...)
		if code != exitUsage || output != "" || diagnostic != test.diagnostic+"\n" {
			t.Errorf("%q: code %d, output %q, diagnostic %q", test.arguments, code, output, diagnostic)
		}
	}
	original := releaseCatalogText
	releaseCatalogText = "rust = 1\n"
	defer func() { releaseCatalogText = original }()
	if code, _, _ := runArtifacts(nil, dotnetArguments(directory, "--nuget-version", "LogBrew=0.1.11")...); code != exitUsage {
		t.Fatalf("catalog failure: code %d", code)
	}
}

func TestReleaseArtifactsUsage(t *testing.T) {
	for _, arguments := range [][]string{
		nil, {"other"}, {"dotnet", "--unknown"}, {"dotnet", "extra"}, {"dotnet", "--directory", "d"},
		append(dotnetArguments("d"), "--source-root", "r"), {"nuget-content"},
	} {
		code, output, diagnostic := runArtifacts(nil, arguments...)
		if code != exitUsage || output != "" || diagnostic != releaseArtifactsUsage {
			t.Errorf("%q: code %d, output %q, diagnostic %q", arguments, code, output, diagnostic)
		}
	}
	directory := t.TempDir()
	writeFixtureFile(t, directory, "bad.nupkg", "not an archive")
	for _, name := range []string{"bad.nupkg", "missing.nupkg"} {
		code, output, diagnostic := runArtifacts(nil, "nuget-content", filepath.Join(directory, name))
		if code != exitFailure || output != "" || diagnostic != "invalid package content\n" {
			t.Errorf("%s: code %d, output %q, diagnostic %q", name, code, output, diagnostic)
		}
	}
}

func TestReleaseArtifactsDotnetFailures(t *testing.T) {
	valid := nuspecText("LogBrew", "0.1.11", artifactCommit, "")
	archive := func(name string, members ...zipMember) func(t *testing.T, directory string) {
		return func(t *testing.T, directory string) {
			t.Helper()
			writeFixtureFile(t, directory, name, string(zipBytes(t, members...)))
		}
	}
	nupkg := func(members ...zipMember) func(t *testing.T, directory string) {
		return archive("LogBrew.0.1.11.nupkg", append(members, zipMember{name: "lib/net8.0/LogBrew.dll"},
			zipMember{name: "lib/net8.0/LogBrew.xml"})...)
	}
	nuspec := func(text string) func(t *testing.T, directory string) {
		return nupkg(zipMember{name: "LogBrew.nuspec", body: text})
	}
	symbols := func(body string) []byte {
		return zipBytes(t, zipMember{name: "LogBrew.nuspec", body: valid}, zipMember{name: "lib/net8.0/LogBrew.pdb", body: body})
	}
	stored := zipBytes(t, zipMember{name: "LogBrew.nuspec", body: valid})
	invalid := []string{"LogBrew: invalid package archive", "LogBrew: missing package assemblies",
		"LogBrew: missing portable symbols for package assemblies"}
	snupkg := func(body string) func(t *testing.T, directory string) {
		return func(t *testing.T, directory string) {
			t.Helper()
			writeFixtureFile(t, directory, "LogBrew.0.1.11.snupkg", body)
		}
	}
	for _, test := range []struct {
		change   func(t *testing.T, directory string)
		failures []string
	}{
		{func(t *testing.T, directory string) {
			for _, name := range []string{"LogBrew.0.1.11.nupkg", "LogBrew.0.1.11.snupkg"} {
				if err := os.Remove(filepath.Join(directory, name)); err != nil {
					t.Fatal(err)
				}
			}
			writeFixtureFile(t, directory, "Other.1.0.0.nupkg", "")
			writeFixtureFile(t, directory, "Other.1.0.0.snupkg", "")
		}, []string{"missing nupkg: LogBrew.0.1.11.nupkg", "unexpected nupkg: Other.1.0.0.nupkg",
			"missing snupkg: LogBrew.0.1.11.snupkg", "unexpected snupkg: Other.1.0.0.snupkg"}},
		{func(t *testing.T, directory string) {
			for _, name := range []string{"LogBrew.0.1.11.nupkg", "LogBrew.0.1.11.snupkg"} {
				if os.Remove(filepath.Join(directory, name)) != nil || os.Mkdir(filepath.Join(directory, name), 0o700) != nil {
					t.Fatal(name)
				}
			}
		}, []string{"LogBrew: invalid package archive", "LogBrew: invalid package archive",
			"LogBrew: missing package assemblies", "LogBrew: invalid portable symbols", "LogBrew: invalid package content"}},
		{nupkg(zipMember{name: "a.nuspec"}, zipMember{name: "b.nuspec"}), []string{"LogBrew: expected one nuspec"}},
		{nuspec("<package>"), invalid},
		{archive("LogBrew.0.1.11.nupkg"), []string{"LogBrew: expected one nuspec", "LogBrew: missing package assemblies",
			"LogBrew: missing portable symbols for package assemblies"}},
		{func(t *testing.T, directory string) {
			writeFixtureFile(t, directory, "LogBrew.0.1.11.nupkg", string(patched(stored, centralRecord(stored, 0)+10, 99)))
		}, append(invalid, "LogBrew: invalid package content")},
		{nuspec("<package/>"), []string{"LogBrew: missing package metadata"}},
		{nuspec("<package><metadata><id>Other</id><version>1</version></metadata></package>"),
			[]string{"LogBrew: package id mismatch", "LogBrew: package version mismatch", "LogBrew: repository source mismatch"}},
		{nuspec(nuspecText("LogBrew", "0.1.11", strings.Repeat("f", 40), "")), []string{"LogBrew: source commit mismatch"}},
		{nupkg(zipMember{name: "LogBrew.nuspec", body: valid}, zipMember{name: "LogBrew.nuspec", body: valid}),
			[]string{"LogBrew: invalid package content"}},
		{archive("LogBrew.0.1.11.nupkg", zipMember{name: "LogBrew.nuspec", body: valid}, zipMember{name: "lib/net8.0/LogBrew.dll"}),
			[]string{"LogBrew: missing XML documentation for package assemblies"}},
		{snupkg(string(symbols(sourceLinkRoot))),
			[]string{"LogBrew: portable symbols are missing exact Source Link"}},
		{snupkg(string(flipped(symbols("x"), centralRecord(symbols("x"), 1)+16))),
			[]string{"LogBrew: invalid portable symbols"}},
	} {
		directory := t.TempDir()
		writeDotnetPackages(t, directory, "LogBrew", "0.1.11", valid)
		test.change(t, directory)
		code, output, diagnostic := runArtifacts(nil, dotnetArguments(directory, "--nuget-version", "LogBrew=0.1.11")...)
		if want := strings.Join(test.failures, "\n") + "\n"; code != exitFailure || output != "" || diagnostic != want {
			t.Errorf("code %d, output %q, diagnostic %q, want %q", code, output, diagnostic, want)
		}
	}
}

func TestReleaseArtifactsDependencyRanges(t *testing.T) {
	for _, dependencies := range []string{
		"",
		`<dependencies><dependency id="LogBrew" version="[0.1.10, 0.2.0)"/></dependencies>`,
		`<dependencies><group><dependency id="LogBrew" version="[0.1.11, 0.2.0)"/></group><group/></dependencies>`,
	} {
		directory := t.TempDir()
		writeDotnetPackages(t, directory, "LogBrew.HttpClient", "0.1.6",
			nuspecText("LogBrew.HttpClient", "0.1.6", artifactCommit, dependencies))
		code, _, diagnostic := runArtifacts(nil, dotnetArguments(directory, "--nuget-version", "LogBrew.HttpClient=0.1.6",
			"--dependency-range", "LogBrew.HttpClient:LogBrew=[0.1.11, 0.2.0)")...)
		want := "LogBrew.HttpClient: LogBrew dependency range mismatch\n"
		if dependencies == "" {
			want = "LogBrew.HttpClient: missing dependency range metadata\n"
		}
		want += want
		if code != exitFailure || diagnostic != want {
			t.Errorf("%s: code %d, diagnostic %q", dependencies, code, diagnostic)
		}
	}
}

func TestZipReader(t *testing.T) {
	archive := zipBytes(t, zipMember{name: "a", body: "first"}, zipMember{name: "b\x00ignored", body: "second", method: zip.Deflate},
		zipMember{name: "ä", body: "third", extra: []byte{1, 2, 1, 0, 9}})
	entries, err := openZip(archive)
	if err != nil || len(entries) != 3 || entries[1].name != "b" || entries[1].directory != "b\x00ignored" || entries[2].name != "ä" {
		t.Fatalf("entries %+v, error %v", entries, err)
	}
	for index, want := range []string{"first", "second", "third"} {
		if data, err := readZipFile(entries[index]); string(data) != want || err != nil {
			t.Errorf("member %d: %q, %v", index, data, err)
		}
	}
	var commented bytes.Buffer
	writer := zip.NewWriter(&commented)
	if writer.SetComment("note") != nil || writer.Close() != nil {
		t.Fatal("comment")
	}
	prefixed := append([]byte("prefix"), archive...)
	for name, data := range map[string][]byte{"commented": commented.Bytes(), "prefixed": prefixed} {
		entries, err := openZip(data)
		if err == nil && len(entries) > 0 {
			_, err = readZipFile(entries[0])
		}
		if err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	first := centralRecord(archive, 0)
	end := len(archive) - zipEndRecordBytes
	zip64 := append(append(bytes.Clone(archive[:end]), append([]byte("PK\x06\x07"), make([]byte, 16)...)...), archive[end:]...)
	for name, data := range map[string][]byte{
		"short":         []byte("PK"),
		"no record":     bytes.Repeat([]byte("x"), 40),
		"late record":   append(bytes.Repeat([]byte("x"), 40), "PK\x05\x06xx"...),
		"zip64":         zip64,
		"before start":  patched(archive, end+12, 0xff, 0xff, 0xff),
		"bad header":    patched(archive, first, 'X'),
		"short header":  patched(archive, end+12, 10),
		"new version":   patched(archive, first+6, 64),
		"zip64 size":    patched(archive, first+24, 0xff, 0xff, 0xff, 0xff),
		"invalid utf-8": patched(archive, centralRecord(archive, 2)+46, 0xff),
		"bad extra":     zipBytes(t, zipMember{name: "a", extra: []byte{1, 2, 9, 0, 0}}),
	} {
		if _, err := openZip(data); err == nil {
			t.Errorf("%s: archive accepted", name)
		}
	}
	plain, _ := openZip(patched(archive, centralRecord(archive, 2)+9, 0))
	if plain[2].name != "├ñ" {
		t.Errorf("CP437 name %q", plain[2].name)
	}
	bzip2Data, _ := hex.DecodeString("425a68393141592653596a2f28920000018180128490802000220365086034147c5dc914e14241a8bca248")
	stored, _ := openZip(zipBytes(t, zipMember{name: "a", body: string(bzip2Data)}))
	stored[0].method, stored[0].crc, stored[0].size = 12, crc32.ChecksumIEEE([]byte("logbrew")), 7
	if data, err := readZipFile(stored[0]); string(data) != "logbrew" || err != nil {
		t.Errorf("bzip2: %q, %v", data, err)
	}
	for name, change := range map[string]func(entry *zipEntry){
		"negative header": func(entry *zipEntry) { entry.header = -1 },
		"local signature": func(entry *zipEntry) { entry.header++ },
		"local name":      func(entry *zipEntry) { entry.directory = "other" },
		"encrypted":       func(entry *zipEntry) { entry.flags |= 1 },
		"overlap":         func(entry *zipEntry) { entry.compressed += 1000 },
		"method":          func(entry *zipEntry) { entry.method = 99 },
		"checksum":        func(entry *zipEntry) { entry.crc++ },
		"truncated":       func(entry *zipEntry) { entry.end, entry.compressed, entry.size = entry.header, 1<<20, 1<<20 },
		"plain name":      func(entry *zipEntry) { *entry = plain[2] },
	} {
		entry := entries[0]
		change(&entry)
		if _, err := readZipFile(entry); err == nil {
			t.Errorf("%s: member accepted", name)
		}
	}
}

func TestPackageContentDigest(t *testing.T) {
	archive := zipBytes(t, zipMember{name: "b", body: "second"}, zipMember{name: ".signature.p7s", body: "signed"},
		zipMember{name: "a", body: "first"})
	unsigned := zipBytes(t, zipMember{name: "a", body: "first"}, zipMember{name: "b", body: "second"})
	digest, err := packageContentSHA256(archive, true)
	other, otherError := packageContentSHA256(unsigned, false)
	if err != nil || otherError != nil || digest != other || len(digest) != 64 {
		t.Fatalf("digests %q %q, errors %v %v", digest, other, err, otherError)
	}
	larger := patched(archive, centralRecord(archive, 0)+24, 7)
	if _, err := packageContentSHA256(larger, false); err != nil {
		t.Fatalf("unbounded declared size: %v", err)
	}
	for name, test := range map[string]struct {
		data    []byte
		bounded bool
	}{
		"empty":       {nil, true},
		"unsafe":      {zipBytes(t, zipMember{name: "../a"}), true},
		"duplicate":   {zipBytes(t, zipMember{name: "a"}, zipMember{name: "a"}), false},
		"checksum":    {flipped(archive, centralRecord(archive, 0)+16), false},
		"size":        {larger, true},
		"not archive": {[]byte("text"), false},
	} {
		if _, err := packageContentSHA256(test.data, test.bounded); err == nil {
			t.Errorf("%s: digest accepted", name)
		}
	}
}

func TestPyPath(t *testing.T) {
	for path, want := range map[string]string{"": ".", ".": ".", "a//./b/": "a/b", "/x/./y": "/x/y", "/": "/"} {
		if got := pyPath(path); got != want {
			t.Errorf("%q: %q", path, got)
		}
	}
}
