package main

import (
	"bytes"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func nugetProvenanceFixture(t *testing.T) *nugetProvenance {
	t.Helper()
	const coreVersion = "0.1.5"
	directory := t.TempDir()
	options := nugetProvenance{
		boundDir: filepath.Join(directory, "bound"), sourceDir: filepath.Join(directory, nugetReceiptSource),
		packagesDir: filepath.Join(directory, "packages"), assets: filepath.Join(directory, "assets.json"),
		coreVersion: coreVersion, httpclientVersion: "0.1.0",
	}
	files := make(map[string]string)
	libraries := make(map[string]any)
	for _, spec := range []struct{ id, version, filename string }{
		{dotnetMetadataCore, options.coreVersion, "0.nupkg"},
		{"LogBrew.HttpClient", options.httpclientVersion, "1.nupkg"},
	} {
		body := "bound-" + spec.id
		digest := sha512.Sum512([]byte(body))
		archiveHash := base64.StdEncoding.EncodeToString(digest[:])
		// Signed-package content hashes need not equal the complete archive hash.
		digest = sha512.Sum512([]byte("content-" + spec.id))
		contentHash := base64.StdEncoding.EncodeToString(digest[:])
		name := strings.ToLower(spec.id)
		prefix := "packages/" + name + "/" + spec.version + "/"
		files["bound/"+spec.filename] = body
		files["source/"+spec.id+"."+spec.version+".nupkg"] = body
		files[prefix+name+"."+spec.version+".nupkg"] = body
		files[prefix+name+"."+spec.version+".nupkg.sha512"] = archiveHash + "\n"
		metadata := pythonManifestJSON(t, map[string]any{
			pythonManifestVersion: 2, "contentHash": contentHash, nugetReceiptSource: options.sourceDir,
		})
		files[prefix+".nupkg.metadata"] = string(metadata)
		libraries[spec.id+"/"+spec.version] = map[string]any{nugetReceiptType: "package", "sha512": contentHash}
	}
	assets := pythonManifestJSON(t, map[string]any{"libraries": libraries})
	files["assets.json"] = string(assets)
	for name, body := range files {
		filename := filepath.Join(directory, name)
		if err := os.MkdirAll(filepath.Dir(filename), pythonBundleDirectoryMode); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filename, []byte(body), fixtureReceiptMode); err != nil {
			t.Fatal(err)
		}
	}
	return &options
}

func TestNugetProvenanceCommand(t *testing.T) {
	t.Parallel()
	options := nugetProvenanceFixture(t)
	arguments := []string{
		"--bound-dir", options.boundDir, "--source-dir", options.sourceDir,
		"--packages-dir", options.packagesDir, "--assets", options.assets,
		"--core-version", options.coreVersion, "--httpclient-version", options.httpclientVersion,
	}
	for _, test := range []struct {
		arguments []string
		code      int
	}{
		{arguments, exitOK},
		{nil, exitUsage},
		{arguments[:len(arguments)-1], exitUsage},
		{append([]string{"--unrecognized-receipt", "private-receipt-marker"}, arguments[2:]...), exitUsage},
		{append([]string{"--assets", options.assets}, arguments[2:]...), exitUsage},
		{append([]string{"--bound-dir", "relative-receipt"}, arguments[2:]...), exitFailure},
		{append(append([]string{}, arguments[:10]...), "--httpclient-version", "../outside"), exitFailure},
	} {
		var output, diagnostic bytes.Buffer
		code := runNugetProvenance(test.arguments, &output, &diagnostic)
		if code != test.code || output.Len() != 0 ||
			code == exitOK && diagnostic.Len() != 0 ||
			code != exitOK && diagnostic.String() != "NuGet receipt provenance verification failed\n" {
			t.Fatal("unexpected command result or reflected diagnostic")
		}
	}
}

func TestNugetProvenanceRejectsAmbiguousReceipts(t *testing.T) {
	t.Parallel()
	for name, replacement := range map[string]string{
		"duplicate libraries": `{"libraries":{},"libraries":{}}`, "array": `[]`, "zero bytes": "",
		"wrong type": `{"libraries":{"LogBrew/0.1.5":{"type":"project"}}}`,
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			options := nugetProvenanceFixture(t)
			if err := os.WriteFile(options.assets, []byte(replacement), fixtureReceiptMode); err != nil {
				t.Fatal(err)
			}
			if verifyNugetProvenance(options) {
				t.Fatal("ambiguous receipt accepted")
			}
		})
	}
}

func TestNugetProvenanceRejectsAliasingAndLinks(t *testing.T) {
	t.Parallel()
	options := nugetProvenanceFixture(t)
	options.sourceDir = options.boundDir
	if verifyNugetProvenance(options) {
		t.Fatal("bound directory accepted as source")
	}
	options = nugetProvenanceFixture(t)
	filename := filepath.Join(options.sourceDir, "LogBrew.0.1.5.nupkg")
	if err := os.Remove(filename); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(options.boundDir, "0.nupkg"), filename); err != nil {
		t.Fatal(err)
	}
	if verifyNugetProvenance(options) {
		t.Fatal("symbolic archive alias accepted")
	}
	options = nugetProvenanceFixture(t)
	original := options.assets
	options.assets = filepath.Join(filepath.Dir(original), "assets-alias.json")
	if err := os.Symlink(original, options.assets); err != nil {
		t.Fatal(err)
	}
	if verifyNugetProvenance(options) {
		t.Fatal("symbolic assets alias accepted")
	}
}

func TestNugetSHA512Canonical(t *testing.T) {
	t.Parallel()
	digest := sha512.Sum512([]byte("fixture"))
	canonical := base64.StdEncoding.EncodeToString(digest[:])
	if value, valid := nugetSHA512(canonical); !valid || value != canonical {
		t.Fatal("canonical SHA512 rejected")
	}
	for _, value := range []any{
		nil, true, 1, "", canonical + "\n", strings.TrimRight(canonical, "="),
		strings.Repeat("A", len(canonical)), canonical[:len(canonical)-3] + "B==",
	} {
		if _, valid := nugetSHA512(value); valid {
			t.Fatal("invalid SHA512 accepted")
		}
	}
}

func TestNugetProvenanceContentAndSource(t *testing.T) {
	t.Parallel()
	digest := sha512.Sum512([]byte("different-content"))
	for name, replacement := range map[string]any{
		"contentHash":      base64.StdEncoding.EncodeToString(digest[:]),
		nugetReceiptSource: t.TempDir(),
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			options := nugetProvenanceFixture(t)
			filename := filepath.Join(options.packagesDir, "logbrew", options.coreVersion, ".nupkg.metadata")
			data, readable := readNugetReceipt(filepath.Dir(filename), filepath.Base(filename), pythonManifestLimit)
			if !readable {
				t.Fatal("fixture metadata is unreadable")
			}
			var metadata map[string]any
			if err := json.Unmarshal(data, &metadata); err != nil {
				t.Fatal(err)
			}
			metadata[name] = replacement
			data = pythonManifestJSON(t, metadata)
			if err := os.WriteFile(filename, data, fixtureReceiptMode); err != nil {
				t.Fatal(err)
			}
			if verifyNugetProvenance(options) {
				t.Fatal("unbound content or source accepted")
			}
		})
	}
}

func TestNugetReceiptFileBounds(t *testing.T) {
	t.Parallel()
	const receipt, content, directoryName = "receipt", "data", "."
	directory := confidentialityFixture(t, map[string]string{receipt: content})
	for _, limit := range []int64{0, 1, 3, 4} {
		data, valid := readNugetReceipt(directory, receipt, limit)
		if valid != (limit == 4) || valid && string(data) != content {
			t.Fatal("receipt byte limit not enforced")
		}
	}
	for _, name := range []string{"absent-receipt", directoryName, "../receipt"} {
		if _, valid := readNugetReceipt(directory, name, outputLimit); valid {
			t.Fatal("non-regular or escaping receipt accepted")
		}
	}
}

func TestNugetProvenanceArchiveBinding(t *testing.T) {
	t.Parallel()
	for _, relative := range []string{
		"bound/0.nupkg", "bound/1.nupkg", "source/LogBrew.0.1.5.nupkg",
		"source/LogBrew.HttpClient.0.1.0.nupkg", "packages/logbrew/0.1.5/logbrew.0.1.5.nupkg",
		"packages/logbrew.httpclient/0.1.0/logbrew.httpclient.0.1.0.nupkg",
		"packages/logbrew/0.1.5/logbrew.0.1.5.nupkg.sha512", "packages/logbrew/0.1.5/.nupkg.metadata",
		"packages/logbrew.httpclient/0.1.0/.nupkg.metadata", "assets.json",
	} {
		t.Run(relative, func(t *testing.T) {
			t.Parallel()
			options := nugetProvenanceFixture(t)
			if !verifyNugetProvenance(options) {
				t.Fatal("valid distinct archive/content receipts rejected")
			}
			filename := filepath.Join(filepath.Dir(options.boundDir), relative)
			if err := os.WriteFile(filename, []byte("changed"), fixtureReceiptMode); err != nil {
				t.Fatal(err)
			}
			if verifyNugetProvenance(options) {
				t.Fatal("changed provenance accepted")
			}
		})
	}
}

func TestNugetProvenancePreservesArtifactSizeContract(t *testing.T) {
	t.Parallel()
	options := nugetProvenanceFixture(t)
	bound := filepath.Join(options.boundDir, "0.nupkg")
	data := bytes.Repeat([]byte("x"), maximumOutputFile+1)
	if err := os.WriteFile(bound, data, fixtureReceiptMode); err != nil {
		t.Fatal(err)
	}
	installed := filepath.Join(options.packagesDir, "logbrew", options.coreVersion, "logbrew.0.1.5.nupkg")
	for _, name := range []string{filepath.Join(options.sourceDir, "LogBrew.0.1.5.nupkg"), installed} {
		if err := os.Remove(name); err != nil {
			t.Fatal(err)
		}
		if err := os.Link(bound, name); err != nil {
			t.Fatal(err)
		}
	}
	digest := sha512.Sum512(data)
	hash := base64.StdEncoding.EncodeToString(digest[:])
	if err := os.WriteFile(installed+".sha512", []byte(hash), fixtureReceiptMode); err != nil {
		t.Fatal(err)
	}
	if !verifyNugetProvenance(options) {
		t.Fatal("artifact within the NuGet 50 MiB contract rejected by a generic file limit")
	}
}
