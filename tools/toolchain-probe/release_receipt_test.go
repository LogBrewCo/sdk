package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	receiptEnvironment = "LOGBREW_RELEASE_ARTIFACT_FILES_JSON"
	// A bzip2 tar holding the directory dir and the file dir/z of 8,192 zero bytes.
	receiptBzip2Tar = "QlpoOTFBWSZTWQLc7YkAAIr7gNiAAEBAAN+AAAxkIB4QCAggAHUJKMppoaBoBoJJIGmmTQA2o9o0kXggbAEhmSEVp4SKxgTyYiQEIYCCkaMhMQEjXeri" +
		"HKbZX0ri8ZTmmij04t4enw445aQkH4u5IpwoSAFudsSA"
)

type receiptMember struct {
	name string
	kind byte
	body string
}

func receiptTar(t *testing.T, compress bool, members ...receiptMember) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := tar.NewWriter(&buffer)
	for _, member := range members {
		header := &tar.Header{Name: member.name, Typeflag: member.kind, Mode: 0o644, Size: int64(len(member.body)),
			Linkname: map[bool]string{true: "target"}[member.kind == tar.TypeSymlink]}
		if err := writer.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		_, _ = writer.Write([]byte(member.body))
	}
	_ = writer.Close()
	if !compress {
		return buffer.Bytes()
	}
	var compressed bytes.Buffer
	gzipWriter := gzip.NewWriter(&compressed)
	_, _ = gzipWriter.Write(buffer.Bytes())
	_ = gzipWriter.Close()
	return compressed.Bytes()
}

// receiptZip writes members; kind 'l' marks a symbolic link and 'c' a stored
// member with a wrong CRC.
func receiptZip(t *testing.T, members ...receiptMember) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, member := range members {
		header := &zip.FileHeader{Name: member.name, Method: zip.Deflate}
		if member.kind == 'l' {
			header.SetMode(os.ModeSymlink | 0o777)
		}
		var err error
		if member.kind == 'c' {
			header.Method, header.CRC32 = zip.Store, 1
			header.CompressedSize64, header.UncompressedSize64 = uint64(len(member.body)), uint64(len(member.body))
			var raw interface{ Write([]byte) (int, error) }
			if raw, err = writer.CreateRaw(header); err == nil {
				_, _ = raw.Write([]byte(member.body))
			}
		} else {
			var file interface{ Write([]byte) (int, error) }
			if file, err = writer.CreateHeader(header); err == nil {
				_, _ = file.Write([]byte(member.body))
			}
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	_ = writer.Close()
	return buffer.Bytes()
}

func runReceipt(arguments ...string) (int, string, string) {
	var output, diagnostic bytes.Buffer
	code := checkReleaseArtifacts(append([]string{"receipt"}, arguments...), nil, &output, &diagnostic)
	return code, output.String(), diagnostic.String()
}

func receiptDirectory(t *testing.T) string {
	t.Helper()
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return directory
}

// receiptSources writes each archive and sets the supplied paths in family
// order.
func receiptSources(t *testing.T, directory, family string, archives ...[]byte) []string {
	t.Helper()
	paths, pairs := []string{}, []string{}
	for index, artifact := range receiptFamilies[family] {
		path := filepath.Join(directory, "source", artifact[1])
		writeArtifacts(t, filepath.Dir(path), map[string]string{artifact[1]: string(archives[index])})
		key, _ := json.Marshal(artifact[0])
		value, _ := json.Marshal(path)
		paths, pairs = append(paths, path), append(pairs, string(key)+": "+string(value))
	}
	t.Setenv(receiptEnvironment, "{"+strings.Join(pairs, ", ")+"}")
	return paths
}

// bindFixture binds the archives and returns the metadata path.
func bindFixture(t *testing.T, family string, archives ...[]byte) string {
	t.Helper()
	directory := receiptDirectory(t)
	receiptSources(t, directory, family, archives...)
	metadata := filepath.Join(directory, "metadata.json")
	if code, _, diagnostic := runReceipt("bind", "--family", family, "--output-dir", filepath.Join(directory, "bound"),
		"--metadata", metadata); code != exitOK {
		t.Fatalf("bind: %d %q", code, diagnostic)
	}
	return metadata
}

func setReceiptLimits(t *testing.T, artifact, extracted int64, entries int) {
	saved := []int64{receiptMaxArtifact, receiptMaxExtracted, int64(receiptMaxEntries)}
	receiptMaxArtifact, receiptMaxExtracted, receiptMaxEntries = artifact, extracted, entries
	t.Cleanup(func() {
		receiptMaxArtifact, receiptMaxExtracted, receiptMaxEntries = saved[0], saved[1], int(saved[2])
	})
}

func TestReceiptArguments(t *testing.T) {
	for _, arguments := range [][]string{
		{}, {"nope", "--family", "go"}, {"ids"}, {"ids", "--family", "bogus"}, {"ids", "--family", "go", "--metadata", "m"},
		{"bind", "--family", "go", "--metadata", "m"}, {"ids", "--family", "go", "extra"}, {"ids", "--bogus"},
		{"extract", "--family", "go", "--metadata", "m", "--output-dir", "d", "--index", "x"},
	} {
		if code, output, diagnostic := runReceipt(arguments...); code != exitUsage || output != "" || diagnostic != receiptUsage {
			t.Errorf("%v: %d %q %q", arguments, code, output, diagnostic)
		}
	}
	for _, arguments := range [][]string{{"--help"}, {"-h"}, {"ids", "--help"}} {
		if code, output, _ := runReceipt(arguments...); code != exitOK || output != receiptUsage {
			t.Errorf("%v: %d %q", arguments, code, output)
		}
	}
	if code, output, _ := runReceipt("ids", "--family", "nuget"); code != exitOK ||
		output != "nuget:LogBrew\nnuget:LogBrew.HttpClient\n" {
		t.Errorf("ids: %d %q", code, output)
	}
}

func TestReceiptBindAttestExtract(t *testing.T) {
	directory := receiptDirectory(t)
	t.Chdir(directory)
	archive := receiptTar(t, true, receiptMember{"package/", tar.TypeDir, ""},
		receiptMember{"package//./index.js", tar.TypeReg, "module.exports = 1;\n"})
	receiptSources(t, directory, "npm-nestjs", archive)
	if code, _, diagnostic := runReceipt("bind", "--family", "npm-nestjs", "--output-dir", "bound", "--metadata",
		"meta/receipt.json"); code != exitOK {
		t.Fatalf("bind: %d %q", code, diagnostic)
	}
	sum := sha256.Sum256(archive)
	digest := "sha256:" + hex.EncodeToString(sum[:])
	metadata, _ := os.ReadFile(filepath.Join(directory, "meta/receipt.json"))
	want := `{"schema_version":1,"family":"npm-nestjs","artifacts":[{"id":"npm:@logbrew/nestjs","digest":"` + digest +
		`","file":"` + directory + `/bound/0.tgz"}]}` + "\n"
	if string(metadata) != want {
		t.Errorf("metadata: %s", metadata)
	}
	code, output, _ := runReceipt("attest", "--family", "npm-nestjs", "--metadata", "meta/receipt.json")
	if code != exitOK || output != `{"schema_version":1,"status":"passed","artifacts":[{"id":"npm:@logbrew/nestjs","digest":"`+
		digest+`"}]}`+"\n" {
		t.Errorf("attest: %d %q", code, output)
	}
	if code, _, _ := runReceipt("extract", "--family", "npm-nestjs", "--metadata", "meta/receipt.json", "--index", " +0 ",
		"--output-dir", "x"); code != exitOK {
		t.Fatalf("extract: %d", code)
	}
	if data, _ := os.ReadFile("x/package/index.js"); string(data) != "module.exports = 1;\n" {
		t.Errorf("extracted %q", data)
	}
	bzip2Tar, _ := base64.StdEncoding.DecodeString(receiptBzip2Tar)
	extracted := map[string][]byte{
		"rubygems": bzip2Tar,
		"crates":   receiptTar(t, false, receiptMember{"a/b.rs", tar.TypeReg, "fn main() {}"}),
		"maven":    receiptZip(t, receiptMember{"META-INF/", 0, ""}, receiptMember{"META-INF/MANIFEST.MF", 0, "Manifest\n"}),
	}
	for family, archive := range extracted {
		metadata := bindFixture(t, family, archive)
		output := filepath.Join(filepath.Dir(metadata), "x")
		if code, _, _ := runReceipt("extract", "--family", family, "--metadata", metadata, "--index", "0",
			"--output-dir", output); code != exitOK {
			t.Errorf("%s: %d", family, code)
		}
	}
	nuget := bindFixture(t, "nuget", receiptZip(t, receiptMember{"a", 0, "x"}), receiptZip(t, receiptMember{"b", 0, "y"}))
	if code, _, _ := runReceipt("extract", "--family", "nuget", "--metadata", nuget, "--index", "1", "--output-dir",
		filepath.Join(filepath.Dir(nuget), "x")); code != exitOK {
		t.Errorf("nuget: %d", code)
	}
	if data, _ := os.ReadFile(filepath.Join(filepath.Dir(nuget), "x", "b")); string(data) != "y" {
		t.Errorf("nuget extracted %q", data)
	}
}

func TestReceiptBindFailures(t *testing.T) {
	directory := receiptDirectory(t)
	paths := receiptSources(t, directory, "nuget", []byte("zero"), []byte("one"))
	writeArtifacts(t, directory, map[string]string{"empty": "", "link": symlinkPrefix + paths[0], "dir/": "",
		"locked": "x", "large": "12345", "out/": ""})
	if err := os.Chmod(filepath.Join(directory, "locked"), 0o200); err != nil {
		t.Fatal(err)
	}
	quoted := func(path string) string { data, _ := json.Marshal(path); return string(data) }
	first, second := `"nuget:LogBrew": `, `"nuget:LogBrew.HttpClient": `
	cases := map[string]bool{
		"": false, "[]": false, "{": false, "{} []": false, `{"nuget:LogBrew": NaN}`: false,
		"{" + second + quoted(paths[1]) + ", " + first + quoted(paths[0]) + "}":                     false,
		"{" + first + "1, " + second + quoted(paths[1]) + "}":                                       false,
		"{" + first + quoted(paths[0]) + ", " + second + quoted(paths[1]) + `, "extra": "x"}`:       false,
		"{" + first + "1, " + second + quoted(paths[1]) + ", " + first + quoted(paths[0]) + "}":     true,
		"{" + first + quoted(paths[0]+"/") + ", " + second + quoted(paths[1]) + "}":                 true,
		"{" + first + `"source/0.nupkg", ` + second + quoted(paths[1]) + "}":                        false,
		"{" + first + quoted(directory+"/link") + ", " + second + quoted(paths[1]) + "}":            false,
		"{" + first + quoted(directory+"/dir") + ", " + second + quoted(paths[1]) + "}":             false,
		"{" + first + quoted(directory+"/empty") + ", " + second + quoted(paths[1]) + "}":           false,
		"{" + first + quoted(directory+"/missing") + ", " + second + quoted(paths[1]) + "}":         false,
		"{" + first + quoted(directory+"/locked") + ", " + second + quoted(paths[1]) + "}":          false,
		"{" + first + quoted(directory+"/large") + ", " + second + quoted(directory+"/large") + "}": false,
	}
	setReceiptLimits(t, 4, receiptMaxExtracted, receiptMaxEntries)
	index := 0
	for text, succeeds := range cases {
		index++
		t.Setenv(receiptEnvironment, text)
		output := filepath.Join(directory, "out", strings.Repeat("x", index))
		code, _, diagnostic := runReceipt("bind", "--family", "nuget", "--output-dir", output, "--metadata",
			filepath.Join(directory, "meta.json"))
		if succeeds != (code == exitOK) || !succeeds && diagnostic != "release artifact binding failed\n" {
			t.Errorf("%s: %d %q", text, code, diagnostic)
		}
	}
	t.Setenv(receiptEnvironment, "{"+first+quoted(paths[0])+", "+second+quoted(paths[1])+"}")
	for output, metadata := range map[string]string{directory: "meta.json", directory + "/fresh": "empty/meta.json"} {
		if code, _, _ := runReceipt("bind", "--family", "nuget", "--output-dir", output, "--metadata",
			filepath.Join(directory, metadata)); code != exitFailure {
			t.Errorf("%s: %d", output, code)
		}
	}
	if _, err := copyReceiptArtifact(paths[0], paths[1]); err == nil {
		t.Error("copied over an existing file")
	}
}

func TestReceiptMetadataFailures(t *testing.T) {
	archive := receiptZip(t, receiptMember{"a", 0, "x"})
	metadata := bindFixture(t, "go", archive)
	original, _ := os.ReadFile(metadata)
	var payload map[string]any
	_ = json.Unmarshal(original, &payload)
	file := payload["artifacts"].([]any)[0].(map[string]any)["file"].(string)
	edit := func(change func(document, entry map[string]any)) string {
		var document map[string]any
		_ = json.Unmarshal(original, &document)
		change(document, document["artifacts"].([]any)[0].(map[string]any))
		data, _ := json.Marshal(document)
		return string(data)
	}
	cases := map[string]bool{
		"{": false, "[]": false,
		edit(func(document, _ map[string]any) { document["schema_version"] = true }):      true,
		edit(func(document, _ map[string]any) { document["schema_version"] = 1.0 }):       true,
		edit(func(document, _ map[string]any) { document["schema_version"] = 2 }):         false,
		edit(func(document, _ map[string]any) { document["extra"] = 1 }):                  false,
		edit(func(document, _ map[string]any) { document["family"] = "crates" }):          false,
		edit(func(document, _ map[string]any) { document["artifacts"] = []any{} }):        false,
		edit(func(_, entry map[string]any) { delete(entry, "digest") }):                   false,
		edit(func(_, entry map[string]any) { entry["id"] = "go:other" }):                  false,
		edit(func(_, entry map[string]any) { entry["file"] = "bound/0.zip" }):             false,
		edit(func(_, entry map[string]any) { entry["file"] = file + "/" }):                true,
		edit(func(_, entry map[string]any) { entry["digest"] = "sha256:00" }):             false,
		edit(func(_, entry map[string]any) { entry["file"] = filepath.Dir(file) }):        false,
		edit(func(_, entry map[string]any) { entry["file"] = filepath.Dir(file) + "/x" }): false,
	}
	for text, succeeds := range cases {
		if err := os.WriteFile(metadata, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
		if code, _, _ := runReceipt("attest", "--family", "go", "--metadata", metadata); succeeds != (code == exitOK) {
			t.Errorf("%s: %d", text, code)
		}
	}
	if code, _, _ := runReceipt("attest", "--family", "go", "--metadata", metadata+".missing"); code != exitFailure {
		t.Errorf("missing metadata: %d", code)
	}
	_ = os.WriteFile(metadata, original, 0o600)
	setReceiptLimits(t, int64(len(archive)-1), receiptMaxExtracted, receiptMaxEntries)
	if code, _, _ := runReceipt("attest", "--family", "go", "--metadata", metadata); code != exitFailure {
		t.Errorf("large artifact: %d", code)
	}
	setReceiptLimits(t, int64(len(archive)), receiptMaxExtracted, receiptMaxEntries)
	for _, change := range []func() error{
		func() error { return os.Chmod(file, 0o200) },
		func() error { return os.WriteFile(file, nil, 0o600) },
		func() error { _ = os.Remove(file); return os.Symlink(metadata, file) },
	} {
		if err := change(); err != nil {
			t.Fatal(err)
		}
		if code, _, _ := runReceipt("attest", "--family", "go", "--metadata", metadata); code != exitFailure {
			t.Errorf("changed artifact: %d", code)
		}
	}
}

func TestReceiptExtractFailures(t *testing.T) {
	bzip2Tar, _ := base64.StdEncoding.DecodeString(receiptBzip2Tar)
	cases := []struct {
		archive []byte
		index   string
		limits  [2]int64
	}{
		{receiptZip(t, receiptMember{"a", 0, "x"}), "-1", [2]int64{}},
		{receiptZip(t, receiptMember{"a", 0, "x"}), "1", [2]int64{}},
		{receiptZip(t), "0", [2]int64{}},
		{receiptZip(t, receiptMember{"a", 0, "x"}, receiptMember{"b", 0, "y"}), "0", [2]int64{0, 1}},
		{receiptZip(t, receiptMember{"../a", 0, "x"}), "0", [2]int64{}},
		{receiptZip(t, receiptMember{"a", 'l', "target"}), "0", [2]int64{}},
		{receiptZip(t, receiptMember{"a", 0, "x"}, receiptMember{"a/b/", 0, ""}), "0", [2]int64{}},
		{receiptZip(t, receiptMember{"a", 0, "12345"}), "0", [2]int64{4, 10}},
		{receiptZip(t, receiptMember{"a", 'c', "x"}), "0", [2]int64{}},
		{receiptZip(t, receiptMember{"a", 0, "x"}, receiptMember{"a", 0, "y"}), "0", [2]int64{}},
		{receiptZip(t, receiptMember{"a", 0, "x"}, receiptMember{"a/b", 0, "y"}), "0", [2]int64{}},
		{[]byte("not an archive"), "0", [2]int64{}},
		{receiptTar(t, false), "0", [2]int64{}},
		{receiptTar(t, true, receiptMember{"a", tar.TypeReg, ""}, receiptMember{"b", tar.TypeReg, ""}), "0", [2]int64{0, 1}},
		{receiptTar(t, true, receiptMember{"a", tar.TypeReg, "x"}, receiptMember{"a/b", tar.TypeDir, ""}), "0", [2]int64{}},
		{receiptTar(t, true, receiptMember{"/a", tar.TypeReg, "x"}), "0", [2]int64{}},
		{receiptTar(t, true, receiptMember{"a\\b", tar.TypeReg, "x"}), "0", [2]int64{}},
		{receiptTar(t, true, receiptMember{"a", tar.TypeSymlink, ""}), "0", [2]int64{}},
		{receiptTar(t, true, receiptMember{"a", tar.TypeReg, "12345"}), "0", [2]int64{4, 10}},
		{receiptTar(t, true, receiptMember{"a", tar.TypeReg, "x"}, receiptMember{"a", tar.TypeReg, "y"}), "0", [2]int64{}},
		{receiptTar(t, true, receiptMember{"a", tar.TypeReg, "x"})[:30], "0", [2]int64{}},
		{bzip2Tar, "0", [2]int64{1, 0}},
	}
	for index, test := range cases {
		metadata := bindFixture(t, "packagist", test.archive)
		if test.limits != [2]int64{} {
			setReceiptLimits(t, receiptMaxArtifact, test.limits[0], int(test.limits[1]))
		}
		code, _, diagnostic := runReceipt("extract", "--family", "packagist", "--metadata", metadata, "--index", test.index,
			"--output-dir", filepath.Join(filepath.Dir(metadata), "x"))
		if code != exitFailure || diagnostic != "release artifact binding failed\n" {
			t.Errorf("case %d: %d %q", index, code, diagnostic)
		}
		setReceiptLimits(t, 128<<20, 512<<20, 20_000)
	}
	metadata := bindFixture(t, "packagist", receiptZip(t, receiptMember{"a", 0, "x"}))
	if code, _, _ := runReceipt("extract", "--family", "packagist", "--metadata", metadata, "--index", "0",
		"--output-dir", filepath.Dir(metadata)); code != exitFailure {
		t.Errorf("existing output: %d", code)
	}
}
