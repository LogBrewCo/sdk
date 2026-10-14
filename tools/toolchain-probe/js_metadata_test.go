package main

import (
	"bytes"
	"encoding/json"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

func TestJSMetadataCommand(t *testing.T) {
	t.Parallel()
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	var output, diagnostic bytes.Buffer
	if runReleaseMetadata([]string{areaJS, root}, &output, &diagnostic) != exitOK || diagnostic.Len() != 0 ||
		output.String() != "{\"scope\":\"javascript_release_metadata\",\"valid\":true}\n" {
		t.Fatal("JavaScript metadata command unavailable or receipt invalid")
	}
}

func jsMetadataDocument(t *testing.T, directory string) map[string]any {
	t.Helper()
	var manifest map[string]any
	if err := json.Unmarshal([]byte(repositorySource(t, directory+"/"+jsMetadataManifest)), &manifest); err != nil {
		t.Fatal(err)
	}
	return manifest
}

func assertJSMetadataRejected(t *testing.T, manifest map[string]any, name string) {
	t.Helper()
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if validJSMetadata(data, name, "") {
		t.Fatal("invalid JavaScript metadata accepted")
	}
}

func rejectJSMetadataPath(t *testing.T, manifest map[string]any, name string, path []string) {
	t.Helper()
	parent := manifest
	if len(path) > 1 {
		value, present := checkField(manifest, path[:len(path)-1])
		var object bool
		parent, object = value.(map[string]any)
		if !present || !object {
			t.Fatal("required metadata parent absent in source fixture")
		}
	}
	key := path[len(path)-1]
	old, exists := parent[key]
	if !exists {
		t.Fatal("required metadata field absent in source fixture")
	}
	delete(parent, key)
	assertJSMetadataRejected(t, manifest, name)
	parent[key] = []any{}
	assertJSMetadataRejected(t, manifest, name)
	parent[key] = old
}

func TestJSMetadataDeclarations(t *testing.T) {
	t.Parallel()
	fields, exports, files := 0, 0, 0
	for directory, name := range jsMetadataPackages() {
		manifest := jsMetadataDocument(t, directory)
		policy := newJSMetadataPolicy(name)
		fields += len(policy.fields)
		files += len(policy.files)
		for path := range policy.fields {
			rejectJSMetadataPath(t, manifest, name, strings.Split(path, "."))
		}
		for exported, requirements := range policy.exports {
			exports += len(requirements)
			for field := range requirements {
				path := append([]string{jsMetadataExport, exported}, strings.Split(field, ".")...)
				rejectJSMetadataPath(t, manifest, name, path)
			}
		}
		rejectJSMetadataFiles(t, manifest, name, policy.files)
	}
	const expectedFields, expectedExports, expectedFiles = 157, 90, 131
	if fields != expectedFields || exports != expectedExports || files != expectedFiles {
		t.Fatalf("JavaScript policy inventory changed: %d fields, %d exports, %d files", fields, exports, files)
	}
}

func rejectJSMetadataFiles(t *testing.T, manifest map[string]any, name string, required []string) {
	t.Helper()
	declared, array := manifest[jsMetadataFiles].([]any)
	if !array {
		t.Fatal("files array missing from actual manifest")
	}
	for _, file := range required {
		index := slices.Index(declared, any(file))
		if index < 0 {
			t.Fatal("required file absent in source manifest")
		}
		manifest[jsMetadataFiles] = slices.Delete(slices.Clone(declared), index, index+1)
		assertJSMetadataRejected(t, manifest, name)
	}
	manifest[jsMetadataFiles] = append(slices.Clone(declared), declared[0])
	assertJSMetadataRejected(t, manifest, name)
	manifest[jsMetadataFiles] = append(slices.Clone(declared), map[string]any{})
	assertJSMetadataRejected(t, manifest, name)
}

func jsMetadataFixtureFiles(t *testing.T) map[string]string {
	t.Helper()
	files := make(map[string]string)
	for directory := range jsMetadataPackages() {
		files[directory+"/"+jsMetadataManifest] = repositorySource(t, directory+"/"+jsMetadataManifest)
		files[directory+"/"+policyRootGuide] = ""
	}
	return files
}

func TestJSMetadataRequiredFiles(t *testing.T) {
	t.Parallel()
	files := jsMetadataFixtureFiles(t)
	const expectedFiles = 34
	if len(files) != expectedFiles {
		t.Fatal("JavaScript manifest/README inventory changed")
	}
	assertReleaseMetadataFiles(t, areaJS, files)
}

func TestJSMetadataCatalog(t *testing.T) {
	t.Parallel()
	for _, extra := range []map[string]string{
		{"js/logbrew-unknown/package.json": `{}`},
		{"js/logbrew-copy/package.json": repositorySource(t, "js/logbrew-js/package.json")},
	} {
		files := jsMetadataFixtureFiles(t)
		maps.Copy(files, extra)
		root := publishFixtureRoot(t, confidentialityFixture(t, files))
		if checkJSMetadata(root) {
			t.Fatal("unknown package catalog entry accepted")
		}
	}
}

func TestJSMetadataVersionAndShape(t *testing.T) {
	t.Parallel()
	for directory, name := range jsMetadataPackages() {
		manifest := jsMetadataDocument(t, directory)
		for _, field := range []string{pythonManifestVersion, "description"} {
			rejectJSMetadataPath(t, manifest, name, []string{field})
		}
		for _, invalid := range []any{true, nil, strconv.FormatBool(false), []any{}} {
			manifest["private"] = invalid
			assertJSMetadataRejected(t, manifest, name)
		}
		delete(manifest, "private")
		manifest[pythonManifestVersion] = "not-version"
		assertJSMetadataRejected(t, manifest, name)
		const selectedVersion = "1.2.3"
		manifest[pythonManifestVersion] = selectedVersion
		data, err := json.Marshal(manifest)
		if err != nil || !validJSMetadata(data, name, selectedVersion) || validJSMetadata(data, name, "1.2.4") {
			t.Fatal("JavaScript expected-version selection failed")
		}
	}
}

func TestJSMetadataInvalidInput(t *testing.T) {
	t.Parallel()
	for _, invalid := range []string{
		"", "{}", "[]", "{", fixtureNullJSON, "\xff", strings.Repeat(" ", pythonManifestLimit+1),
	} {
		if validJSMetadata([]byte(invalid), jsMetadataCore, "") {
			t.Fatal("malformed or oversized JavaScript metadata accepted")
		}
	}
	data := repositorySource(t, "js/logbrew-js/package.json")
	if validJSMetadata([]byte(strings.Replace(data, "{", `{ "version": "0.0.0",`, 1)), jsMetadataCore, "") {
		t.Fatal("duplicate JSON key accepted")
	}
}

func TestJSMetadataOverrides(t *testing.T) {
	t.Parallel()
	root := confidentialityFixture(t, jsMetadataFixtureFiles(t))
	for _, extra := range [][]string{
		{"@logbrew/sdk"},
		{"@logbrew/sdk="},
		{"@logbrew/unknown=1.2.3"},
		{"@logbrew/sdk=wrong"},
		{"@logbrew/sdk=1.2.3", "@logbrew/sdk=1.2.3"},
	} {
		var output, diagnostic bytes.Buffer
		if runReleaseMetadata(append([]string{areaJS, root}, extra...), &output, &diagnostic) != exitUsage ||
			output.Len() != 0 || strings.Contains(diagnostic.String(), root) {
			t.Fatal("invalid JavaScript version selection did not fail without disclosing input")
		}
	}
	if jsMetadataOverrideCheck(make([]string, len(jsMetadataPackages())+1)) != nil {
		t.Fatal("oversized override list accepted")
	}
	var output, diagnostic bytes.Buffer
	if runReleaseMetadata([]string{areaJS, root, "@logbrew/sdk=0.1.27"}, &output, &diagnostic) != exitOK ||
		diagnostic.Len() != 0 || output.Len() == 0 {
		t.Fatal("matching JavaScript version override failed")
	}
}

func TestJSMetadataCatalogBounds(t *testing.T) {
	t.Parallel()
	files := jsMetadataFixtureFiles(t)
	for index := range dotnetMetadataInventoryLimit + 1 {
		files["js/extra-"+strconv.Itoa(index)] = ""
	}
	root := publishFixtureRoot(t, confidentialityFixture(t, files))
	if checkJSMetadata(root) {
		t.Fatal("oversized JavaScript directory inventory accepted")
	}
}

func TestJSMetadataOptionalFields(t *testing.T) {
	t.Parallel()
	manifest := jsMetadataDocument(t, "js/logbrew-js")
	manifest["private"] = false
	for _, module := range []any{nil, jsMetadataIndex} {
		manifest["module"] = module
		data, err := json.Marshal(manifest)
		if err != nil || !validJSMetadata(data, jsMetadataCore, "") {
			t.Fatal("valid optional JavaScript metadata rejected")
		}
	}
	for _, invalid := range []any{true, []any{}, "index.js"} {
		manifest["module"] = invalid
		assertJSMetadataRejected(t, manifest, jsMetadataCore)
	}
	delete(manifest, "module")
	manifest["description"] = "Different product"
	assertJSMetadataRejected(t, manifest, jsMetadataCore)
}

func TestJSMetadataCatalogLinks(t *testing.T) {
	t.Parallel()
	for _, relative := range []string{"js/logbrew-js", "js/logbrew-js/package.json", "js/logbrew-js/README.md"} {
		directory := confidentialityFixture(t, jsMetadataFixtureFiles(t))
		path := filepath.Join(directory, relative)
		if err := os.Rename(path, path+".saved"); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Base(path)+".saved", path); err != nil {
			t.Fatal(err)
		}
		if checkJSMetadata(publishFixtureRoot(t, directory)) {
			t.Fatalf("symlinked package, manifest or README accepted: %s", relative)
		}
	}
}

func TestJSMetadataCatalogIgnoresNonpackages(t *testing.T) {
	t.Parallel()
	files := jsMetadataFixtureFiles(t)
	files["js/logbrew-not-a-package/README.md"] = ""
	files["js/logbrew-file"] = ""
	files["js/examples/nested/package.json"] = "{}"
	if !checkJSMetadata(publishFixtureRoot(t, confidentialityFixture(t, files))) {
		t.Fatal("nonpackage source directory or nested example changed release catalog")
	}
}
