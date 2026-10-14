package main

import (
	"maps"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPythonPublicSmokeRejectsWheelChangedAfterManifestCheck(t *testing.T) {
	t.Parallel()
	directory, selection := pythonManifestFixture(t)
	manifest := pythonFixtureManifest(t, directory, selection)
	options := pythonSmokeOptions{versions: selection.versions, artifacts: directory, manifest: "", receipt: false}
	spec := pythonReleaseCatalog()[0]
	version := selection.versions[spec.id]
	rootName := pythonArtifactRoot(spec.id, version)
	metadata := "Metadata-Version: 2.4\nName: " + spec.id + "\nVersion: " + version + "\n"
	changed := pythonFixtureArchive(t, pythonWheel, []pythonArchiveEntry{
		pythonFixtureFile(rootName+".dist-info/METADATA", metadata),
		pythonFixtureFile("logbrew_sdk/__init__.py", "changed = True\n"),
	})
	if err := os.WriteFile(filepath.Join(directory, pythonReleaseArtifactPath(spec, version, pythonWheel)),
		changed, fixtureReceiptMode); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	_, bound := bindPythonSmokeAtRoot(t.Context(), options, root, nil, nil, manifest)
	if err := root.Close(); err != nil {
		t.Fatal(err)
	}
	if bound {
		t.Fatal("wheel changed after manifest validation was installed under the old manifest")
	}
}

func TestPythonPublicSmokeReceiptFileMap(t *testing.T) {
	t.Parallel()
	const supplied = `{"pypi:logbrew-sdk":"/core.whl","pypi:logbrew-fastapi":"/fastapi.whl",` +
		`"pypi:logbrew-flask":"/flask.whl","pypi:logbrew-django":"/django.whl"}`
	options := pythonSmokeOptions{versions: nil, manifest: "", artifacts: "", receipt: true}
	want := map[string]string{
		pythonCoreID: "/core.whl", pythonFastAPIID: "/fastapi.whl",
		pythonFlaskID: "/flask.whl", pythonDjangoID: "/django.whl",
	}
	for _, sample := range []struct {
		text  string
		valid bool
	}{
		{supplied, true},
		{`{"pypi:logbrew-django":"/django.whl","pypi:logbrew-flask":"/flask.whl",` +
			`"pypi:logbrew-fastapi":"/fastapi.whl","pypi:logbrew-sdk":"/core.whl"}`, true},
		{strings.Replace(supplied, `"/core.whl"`, "null", 1), false},
		{strings.Replace(supplied, `"/core.whl"`, "42", 1), false},
		{strings.Replace(supplied, `"/core.whl"`, `{"path":"/core.whl"}`, 1), false},
		{strings.TrimSuffix(supplied, "}") + `,"pypi:unknown":"/unknown.whl"}`, false},
		{"[]", false},
		{strings.Replace(supplied, "/core.whl", "relative.whl", 1), false},
		{strings.Replace(supplied, `,"pypi:logbrew-django":"/django.whl"`, "", 1), false},
		{strings.Replace(supplied, "pypi:logbrew-sdk", "pypi:logbrew-flask", 1), false},
		{strings.Replace(supplied, "pypi:logbrew-sdk", "pypi:unknown", 1), false},
		{supplied + `{}`, false},
	} {
		files, valid := pythonSmokeSuppliedFiles(options, func(string) string { return sample.text })
		if valid != sample.valid || valid && !maps.Equal(files, want) {
			t.Errorf("receipt files accepted=%v, want=%v", valid, sample.valid)
		}
	}
}
