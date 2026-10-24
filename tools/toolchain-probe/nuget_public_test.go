package main

import (
	"bytes"
	"cmp"
	"compress/gzip"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	publicCoreRange = "[0.1.11, 0.2.0)"
	publicTimestamp = "2026.10.24.08.00.00"
	coreProject     = `<Project><PropertyGroup><TargetFrameworks>netstandard2.0;net8.0</TargetFrameworks></PropertyGroup>` +
		`<ItemGroup><PackageReference Include="Microsoft.Extensions.Logging" Version="10.0.9" /></ItemGroup></Project>`
	httpProject = `<Project><PropertyGroup><TargetFrameworks>netstandard2.0;net8.0</TargetFrameworks></PropertyGroup>` +
		`<ItemGroup><ProjectReference Include="../LogBrew/LogBrew.csproj" />` +
		`<PackageReference Include="Microsoft.Extensions.Http" Version="10.0.9" /></ItemGroup></Project>`
)

var publicVersions = map[string]string{"LogBrew": "0.1.11", "LogBrew.HttpClient": "0.1.6"}

type publicResponse struct {
	hook     func()
	location string
	encoding []string
	body     []byte
	status   int
}

// publicRegistry serves registry responses by URL; other URLs fail to connect.
type publicRegistry map[string]*publicResponse

func (registry publicRegistry) RoundTrip(request *http.Request) (*http.Response, error) {
	response, found := registry[request.URL.String()]
	if !found {
		return nil, errors.New("offline")
	}
	if response.hook != nil {
		response.hook()
	}
	header := http.Header{"Content-Encoding": response.encoding}
	if response.location != "" {
		header.Set("Location", response.location)
	}
	return &http.Response{StatusCode: cmp.Or(response.status, http.StatusOK), Header: header,
		Body: io.NopCloser(bytes.NewReader(response.body)), Request: request}, nil
}

func gzipText(t *testing.T, data []byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := gzip.NewWriter(&buffer)
	if _, err := writer.Write(data); err != nil || writer.Close() != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func publicURLs(id, version string) (string, string, string) {
	lower := strings.ToLower(id)
	return nugetRegistrationRoot + lower + "/" + version + ".json",
		nugetCatalogRoot + publicTimestamp + "/" + lower + "." + version + ".json",
		nugetPackageRoot + lower + "/" + version + "/" + lower + "." + version + ".nupkg"
}

func publicNuspec(id, version, commit string) string {
	dependency := `<dependency id="Microsoft.Extensions.Logging" version="10.0.9" />`
	if id != "LogBrew" {
		dependency = `<dependency id="LogBrew" version="` + publicCoreRange + `" />` +
			`<dependency id="Microsoft.Extensions.Http" version="10.0.9" />`
	}
	return nuspecText(id, version, commit, `<dependencies><group targetFramework=".NETStandard2.0">`+dependency+
		`</group><group targetFramework="net8.0">`+dependency+`</group></dependencies>`)
}

// setPublicPackage serves a package, its gzip registration, and its catalog
// entry with the dependency groups the source projects declare.
func setPublicPackage(t *testing.T, registry publicRegistry, id, version string, body []byte,
	edit func(registration, catalog map[string]any),
) {
	t.Helper()
	registrationURL, catalogURL, packageURL := publicURLs(id, version)
	dependencies := []any{map[string]any{"id": "Microsoft.Extensions.Logging", "range": "[10.0.9, )"}}
	if id != "LogBrew" {
		dependencies = []any{map[string]any{"id": "LogBrew", "range": publicCoreRange},
			map[string]any{"id": "Microsoft.Extensions.Http", "range": "10.0.9"}}
	}
	digest := sha512.Sum512(body)
	registration := map[string]any{"packageContent": packageURL, "catalogEntry": catalogURL}
	catalog := map[string]any{"id": id, "version": version, "packageHashAlgorithm": "SHA512",
		"packageHash": base64.StdEncoding.EncodeToString(digest[:]), "dependencyGroups": []any{
			map[string]any{"targetFramework": ".NETStandard2.0", "dependencies": dependencies},
			map[string]any{"targetFramework": "net8.0", "dependencies": dependencies},
		}}
	if edit != nil {
		edit(registration, catalog)
	}
	registrationText, _ := json.Marshal(registration)
	catalogText, _ := json.Marshal(catalog)
	registry[registrationURL] = &publicResponse{body: gzipText(t, registrationText), encoding: []string{"gzip"}}
	registry[catalogURL] = &publicResponse{body: append([]byte("\ufeff"), catalogText...), encoding: []string{"identity"}}
	registry[packageURL] = &publicResponse{body: body}
}

func publicBody(t *testing.T, id, version, commit string) []byte {
	t.Helper()
	return zipBytes(t, zipMember{name: id + ".nuspec", body: publicNuspec(id, version, commit)},
		zipMember{name: "lib/net8.0/" + id + ".dll", body: "assembly"})
}

// publicFixture writes the source projects and serves both public packages.
func publicFixture(t *testing.T) (string, publicRegistry) {
	t.Helper()
	root := t.TempDir()
	writeFixtureFile(t, root, nugetRelease{ID: "LogBrew"}.project(), coreProject)
	writeFixtureFile(t, root, nugetRelease{ID: "LogBrew.HttpClient"}.project(), httpProject)
	registry := publicRegistry{}
	for id, version := range publicVersions {
		setPublicPackage(t, registry, id, version, publicBody(t, id, version, artifactCommit), nil)
	}
	return root, registry
}

func publicArguments(root string, extra ...string) []string {
	return append([]string{"nuget-public", "--nuget-version", "LogBrew=0.1.11", "--nuget-version", "LogBrew.HttpClient=0.1.6",
		"--source-commit", artifactCommit, "--dependency-range", publicCoreRange, "--source-root", root,
		"--output-directory", filepath.Join(root, "out", "packages"), "--manifest", filepath.Join(root, "out", "receipt.json")},
		extra...)
}

func publicContract(t *testing.T, root, id string) dependencyContract {
	t.Helper()
	contract, ok := sourceDependencyContract(root, id, publicCoreRange)
	if !ok {
		t.Fatal(id)
	}
	return contract
}

func TestPublicNuGet(t *testing.T) {
	root, registry := publicFixture(t)
	code, output, diagnostic := runArtifacts(registry, publicArguments(root)...)
	if code != exitOK || output != "NuGet public artifact verification ok\n" || diagnostic != "" {
		t.Fatalf("code %d, output %q, diagnostic %q", code, output, diagnostic)
	}
	var receipt struct {
		Packages []map[string]string
		Schema   int `json:"schemaVersion"`
	}
	if err := json.Unmarshal([]byte(readText(t, filepath.Join(root, "out", "receipt.json"))), &receipt); err != nil ||
		receipt.Schema != 1 || len(receipt.Packages) != 2 || receipt.Packages[1]["file"] != "LogBrew.HttpClient.0.1.6.nupkg" {
		t.Fatalf("receipt %+v, error %v", receipt, err)
	}
	_, _, packageURL := publicURLs("LogBrew", "0.1.11")
	content, _ := packageContentSHA256(registry[packageURL].body, true)
	if receipt.Packages[0]["contentSha256"] != content ||
		readText(t, filepath.Join(root, "out", "packages", "LogBrew.0.1.11.nupkg")) != string(registry[packageURL].body) {
		t.Fatalf("receipt %+v", receipt.Packages[0])
	}
}

func TestPublicNuGetFailures(t *testing.T) {
	_, _, corePackage := publicURLs("LogBrew", "0.1.11")
	httpRegistration, _, httpPackage := publicURLs("LogBrew.HttpClient", "0.1.6")
	for name, test := range map[string]struct {
		change    func(t *testing.T, root string, registry publicRegistry) []string
		selection bool
	}{
		"selection order": {func(_ *testing.T, root string, _ publicRegistry) []string {
			return append(publicArguments(root)[:1], publicArguments(root)[3:]...)
		}, true},
		"selection duplicate": {func(_ *testing.T, root string, _ publicRegistry) []string {
			return publicArguments(root, "--nuget-version", "LogBrew=0.1.11")
		}, true},
		"selection version": {func(_ *testing.T, root string, _ publicRegistry) []string {
			return publicArguments(root, "--nuget-version", "Other=0.1")
		}, true},
		"selection separator": {func(_ *testing.T, root string, _ publicRegistry) []string {
			arguments := publicArguments(root)
			arguments[2] = "LogBrew"
			return arguments
		}, true},
		"commit": {func(_ *testing.T, root string, _ publicRegistry) []string {
			return publicArguments(root, "--source-commit", "ABC")
		}, false},
		"core range": {func(_ *testing.T, root string, _ publicRegistry) []string {
			return publicArguments(root, "--dependency-range", "[0.1.10, 0.2.0)")
		}, false},
		"open range": {func(_ *testing.T, root string, _ publicRegistry) []string {
			return publicArguments(root, "--dependency-range", "[0.1.11, 0.2.0]")
		}, false},
		"existing output": {func(t *testing.T, root string, _ publicRegistry) []string {
			writeFixtureFile(t, root, "out/packages", "")
			return publicArguments(root)
		}, false},
		"relative source": {func(_ *testing.T, root string, _ publicRegistry) []string {
			return publicArguments(root, "--source-root", "relative")
		}, false},
		"output parent": {func(t *testing.T, root string, _ publicRegistry) []string {
			writeFixtureFile(t, root, "file", "")
			return publicArguments(root, "--output-directory", filepath.Join(root, "file", "packages"))
		}, false},
		"registration": {func(_ *testing.T, root string, registry publicRegistry) []string {
			delete(registry, httpRegistration)
			return publicArguments(root)
		}, false},
		"package": {func(_ *testing.T, root string, registry publicRegistry) []string {
			registry[corePackage].status = http.StatusNotFound
			return publicArguments(root)
		}, false},
		"digest": {func(_ *testing.T, root string, registry publicRegistry) []string {
			registry[corePackage].body = append(registry[corePackage].body, 0)
			return publicArguments(root)
		}, false},
		"write": {func(_ *testing.T, root string, registry publicRegistry) []string {
			registry[corePackage].hook = func() {
				temporary, _ := filepath.Glob(filepath.Join(root, "out", ".nuget-public.*"))
				for _, path := range temporary {
					_ = os.RemoveAll(path)
				}
			}
			return publicArguments(root)
		}, false},
		"nuspec": {func(t *testing.T, root string, registry publicRegistry) []string {
			setPublicPackage(t, registry, "LogBrew", "0.1.11", publicBody(t, "LogBrew", "0.1.11", strings.Repeat("f", 40)), nil)
			return publicArguments(root)
		}, false},
		"rename": {func(t *testing.T, root string, registry publicRegistry) []string {
			registry[httpPackage].hook = func() { writeFixtureFile(t, root, "out/packages/kept", "") }
			return publicArguments(root)
		}, false},
		"manifest": {func(t *testing.T, root string, _ publicRegistry) []string {
			writeFixtureFile(t, root, "file", "")
			return publicArguments(root, "--manifest", filepath.Join(root, "file", "receipt.json"))
		}, false},
	} {
		root, registry := publicFixture(t)
		code, output, diagnostic := runArtifacts(registry, test.change(t, root, registry)...)
		want := publicNuGetFailed + "\n"
		if test.selection {
			want = "invalid NuGet public package selection\n"
		}
		if code != exitFailure || output != "" || diagnostic != want {
			t.Errorf("%s: code %d, output %q, diagnostic %q", name, code, output, diagnostic)
		}
	}
}

func TestPublicFetch(t *testing.T) {
	url := "https://registry.test/item"
	twoMembers := append(gzipText(t, []byte("{}")), gzipText(t, []byte("{}"))...)
	for name, test := range map[string]struct {
		response *publicResponse
		target   string
		want     string
		limit    int64
		metadata bool
	}{
		"plain":        {&publicResponse{body: []byte("body")}, url, "body", 4, false},
		"identity":     {&publicResponse{body: []byte("body"), encoding: []string{"identity"}}, url, "body", 4, true},
		"gzip":         {&publicResponse{body: gzipText(t, []byte("body")), encoding: []string{"gzip"}}, url, "body", 4, true},
		"too large":    {&publicResponse{body: []byte("body")}, url, "", 3, false},
		"status":       {&publicResponse{status: http.StatusNotFound}, url, "", 4, false},
		"package gzip": {&publicResponse{body: gzipText(t, []byte("body")), encoding: []string{"gzip"}}, url, "", 4, false},
		"double gzip":  {&publicResponse{encoding: []string{"gzip", "gzip"}}, url, "", 4, true},
		"bad gzip":     {&publicResponse{body: []byte("body"), encoding: []string{"gzip"}}, url, "", 4, true},
		"gzip members": {&publicResponse{body: twoMembers, encoding: []string{"gzip"}}, url, "", 4, true},
		"gzip large":   {&publicResponse{body: gzipText(t, []byte("body")), encoding: []string{"gzip"}}, url, "", 3, true},
		"redirect":     {&publicResponse{status: http.StatusFound, location: url}, url, "", 4, false},
		"offline":      {&publicResponse{}, url + "/other", "", 4, false},
		"invalid url":  {&publicResponse{}, "::", "", 4, false},
		"compressed":   {&publicResponse{body: bytes.Repeat([]byte("x"), maxMetadataCompressedBytes+1), encoding: []string{"gzip"}}, url, "", 4, true},
	} {
		data, err := fetchBounded(publicRegistry{url: test.response}, test.target, test.limit, time.Second, test.metadata)
		if err == nil && string(data) != test.want || (err == nil) != (test.want != "") {
			t.Errorf("%s: %q, %v", name, data, err)
		}
	}
	registry := publicRegistry{url: {body: []byte("\ufeff{\"a\": 1}")}}
	if value, err := fetchJSON(registry, url); field(value, "a") == nil || err != nil {
		t.Errorf("JSON %v, %v", value, err)
	}
	if _, err := fetchJSON(registry, url+"/other"); err == nil {
		t.Error("offline JSON accepted")
	}
}

func TestPublicRegistryRecord(t *testing.T) {
	root, _ := publicFixture(t)
	contract := publicContract(t, root, "LogBrew")
	body := publicBody(t, "LogBrew", "0.1.11", artifactCommit)
	for name, edit := range map[string]func(registry publicRegistry, registration, catalog map[string]any){
		"package url":  func(_ publicRegistry, registration, _ map[string]any) { registration["packageContent"] = "other" },
		"catalog type": func(_ publicRegistry, registration, _ map[string]any) { registration["catalogEntry"] = 1 },
		"catalog root": func(_ publicRegistry, registration, _ map[string]any) { registration["catalogEntry"] = "https://x/" },
		"timestamp": func(_ publicRegistry, registration, _ map[string]any) {
			registration["catalogEntry"] = nugetCatalogRoot + "2026.02.30.00.00.00/logbrew.0.1.11.json"
		},
		"catalog name": func(_ publicRegistry, registration, _ map[string]any) {
			registration["catalogEntry"] = nugetCatalogRoot + publicTimestamp + "/other.json"
		},
		"catalog fetch": func(publicRegistry, map[string]any, map[string]any) {},
		"id":            func(_ publicRegistry, _, catalog map[string]any) { catalog["id"] = "logbrew" },
		"version":       func(_ publicRegistry, _, catalog map[string]any) { catalog["version"] = "0.1.12" },
		"algorithm":     func(_ publicRegistry, _, catalog map[string]any) { catalog["packageHashAlgorithm"] = "SHA256" },
		"groups":        func(_ publicRegistry, _, catalog map[string]any) { catalog["dependencyGroups"] = []any{} },
		"hash newline": func(_ publicRegistry, _, catalog map[string]any) {
			catalog["packageHash"] = catalog["packageHash"].(string) + "\n"
		},
		"hash encoding": func(_ publicRegistry, _, catalog map[string]any) { catalog["packageHash"] = "!" },
		"hash length":   func(_ publicRegistry, _, catalog map[string]any) { catalog["packageHash"] = "AAAA" },
	} {
		registry := publicRegistry{}
		setPublicPackage(t, registry, "LogBrew", "0.1.11", body, func(registration, catalog map[string]any) {
			edit(registry, registration, catalog)
		})
		if name == "catalog fetch" {
			_, catalogURL, _ := publicURLs("LogBrew", "0.1.11")
			delete(registry, catalogURL)
		}
		if _, _, err := registryRecord(registry, "LogBrew", "0.1.11", contract); err == nil {
			t.Errorf("%s: record accepted", name)
		}
	}
	registry := publicRegistry{}
	setPublicPackage(t, registry, "LogBrew", "0.1.11+build", body, nil)
	if _, _, err := registryRecord(registry, "LogBrew", "0.1.11+build", contract); err == nil {
		t.Error("build metadata accepted")
	}
	for text, want := range map[string]bool{
		publicTimestamp: true, "0000.01.01.00.00.00": false, "2026.02.30.00.00.00": false, "2026.10.24": false,
	} {
		if validCatalogTimestamp(text) != want {
			t.Errorf("timestamp %q", text)
		}
	}
}

func TestPublicDependencyGroups(t *testing.T) {
	contract := dependencyContract{frameworks: []string{"netstandard2.0", "net8.0"},
		dependencies: map[string]string{"A": "[1.0.0, )"}}
	group := func(framework any, dependencies ...any) any {
		return map[string]any{"targetFramework": framework, "dependencies": dependencies}
	}
	dependency := map[string]any{"id": "A", "range": "1.0.0"}
	if !validDependencyGroups([]any{group(".NETStandard2.0", dependency), group("net8.0", dependency)}, contract, "range") {
		t.Fatal("valid groups rejected")
	}
	for name, groups := range map[string]any{
		"not list":     map[string]any{},
		"length":       []any{group("net8.0", dependency)},
		"framework":    []any{group(nil, dependency), group("net8.0", dependency)},
		"empty":        []any{group("", dependency), group("net8.0", dependency)},
		"dependencies": []any{map[string]any{"targetFramework": "net8.0"}, group("netstandard2.0", dependency)},
		"duplicate":    []any{group("net8.0", dependency), group("net8.0", dependency)},
		"unknown":      []any{group("net9.0", dependency), group("net8.0", dependency)},
		"id":           []any{group("net8.0", map[string]any{"range": "1.0.0"}), group("netstandard2.0", dependency)},
		"repeated":     []any{group("net8.0", dependency, dependency), group("netstandard2.0", dependency)},
		"range":        []any{group("net8.0", map[string]any{"id": "A", "range": "(1.0.0, )"}), group("netstandard2.0", dependency)},
		"mismatch":     []any{group("net8.0"), group("netstandard2.0", dependency)},
	} {
		if validDependencyGroups(groups, contract, "range") {
			t.Errorf("%s: groups accepted", name)
		}
	}
	for raw, want := range map[any]string{
		"1.0.0": "[1.0.0, )", "[1.0.0, )": "[1.0.0, )", "[1.0.0, 2.0.0)": "[1.0.0, 2.0.0)", "(1.0.0, )": "",
		"[1.0.0)": "", "[1.0.0, 2)": "", "[1, )": "", 5: "",
	} {
		if text, valid := canonicalDependencyRange(raw); valid != (want != "") || valid && text != want {
			t.Errorf("range %v: %q %v", raw, text, valid)
		}
	}
}

func TestPublicSourceContract(t *testing.T) {
	root, _ := publicFixture(t)
	contract := publicContract(t, root, "LogBrew.HttpClient")
	if strings.Join(contract.frameworks, ";") != "netstandard2.0;net8.0" || len(contract.dependencies) != 2 ||
		contract.dependencies["LogBrew"] != publicCoreRange {
		t.Fatalf("contract %+v", contract)
	}
	project := func(frameworks, items string) string {
		return "<Project><PropertyGroup><TargetFrameworks>" + frameworks + "</TargetFrameworks></PropertyGroup>" +
			"<ItemGroup>" + items + "</ItemGroup></Project>"
	}
	reference := `<PackageReference Include="A" Version="1.0.0" />`
	for name, test := range map[string]struct {
		text, id string
	}{
		"doctype":         {"<!DOCTYPE p><Project/>", "LogBrew"},
		"invalid":         {"<Project>", "LogBrew"},
		"no frameworks":   {"<Project/>", "LogBrew"},
		"two frameworks":  {project("net8.0", reference) + "", "LogBrew"},
		"empty framework": {project("net8.0;;netstandard2.0", reference), "LogBrew"},
		"same framework":  {project("net8.0;net8.0", reference), "LogBrew"},
		"group condition": {strings.Replace(project("net8.0", reference), "<ItemGroup>", `<ItemGroup Condition="x">`, 1), "LogBrew"},
		"item condition":  {project("net8.0", `<PackageReference Include="A" Version="1.0.0" Condition="x" />`), "LogBrew"},
		"no include":      {project("net8.0", `<PackageReference Version="1.0.0" />`), "LogBrew"},
		"duplicate":       {project("net8.0", reference+reference), "LogBrew"},
		"version":         {project("net8.0", `<PackageReference Include="A" Version="1.0" />`), "LogBrew"},
		"core reference":  {project("net8.0", reference+`<ProjectReference Include="../LogBrew/LogBrew.csproj" />`), "LogBrew"},
		"no reference":    {project("net8.0", reference), "LogBrew.HttpClient"},
		"no dependencies": {project("net8.0", ""), "LogBrew"},
	} {
		directory := t.TempDir()
		text := test.text
		if name == "two frameworks" {
			text = strings.Replace(text, "</PropertyGroup>", "<TargetFrameworks>net8.0</TargetFrameworks></PropertyGroup>", 1)
		}
		writeFixtureFile(t, directory, nugetRelease{ID: test.id}.project(), text)
		if _, ok := sourceDependencyContract(directory, test.id, publicCoreRange); ok {
			t.Errorf("%s: contract accepted", name)
		}
	}
	large := t.TempDir()
	writeFixtureFile(t, large, nugetRelease{ID: "LogBrew"}.project(), strings.Repeat(" ", maxProjectBytes+1))
	linked := t.TempDir()
	if os.MkdirAll(filepath.Dir(filepath.Join(linked, nugetRelease{ID: "LogBrew"}.project())), 0o700) != nil ||
		os.Symlink(filepath.Join(root, nugetRelease{ID: "LogBrew"}.project()),
			filepath.Join(linked, nugetRelease{ID: "LogBrew"}.project())) != nil {
		t.Fatal("link")
	}
	file := filepath.Join(root, nugetRelease{ID: "LogBrew"}.project())
	for name, test := range map[string]struct{ root, coreRange string }{
		"relative": {"relative", publicCoreRange}, "missing": {filepath.Join(root, "missing"), publicCoreRange},
		"file": {file, publicCoreRange}, "large": {large, publicCoreRange}, "link": {linked, publicCoreRange},
		"core range": {root, "(0.1.11, )"},
	} {
		id := map[bool]string{false: "LogBrew", true: "LogBrew.HttpClient"}[name == "core range"]
		if _, ok := sourceDependencyContract(test.root, id, test.coreRange); ok {
			t.Errorf("%s: contract accepted", name)
		}
	}
	for text, want := range map[string]bool{"<!doctype x>": true, "<!EnTiTy x>": true, "<a/>": false} {
		if declaresDocumentType([]byte(text)) != want {
			t.Errorf("document type %q", text)
		}
	}
}

func TestPublicPackageValidation(t *testing.T) {
	root, _ := publicFixture(t)
	contract := publicContract(t, root, "LogBrew")
	valid := publicNuspec("LogBrew", "0.1.11", artifactCommit)
	checksum := zipBytes(t, zipMember{name: "LogBrew.nuspec", body: valid})
	for name, body := range map[string][]byte{
		"empty":       nil,
		"unsafe":      zipBytes(t, zipMember{name: "../LogBrew.nuspec", body: valid}),
		"two nuspecs": zipBytes(t, zipMember{name: "a.nuspec", body: valid}, zipMember{name: "b.nuspec", body: valid}),
		"large":       zipBytes(t, zipMember{name: "LogBrew.nuspec", body: strings.Repeat(" ", maxNuspecBytes+1)}),
		"checksum":    flipped(checksum, centralRecord(checksum, 0)+16),
		"doctype":     zipBytes(t, zipMember{name: "LogBrew.nuspec", body: "<!DOCTYPE package>" + valid}),
		"invalid":     zipBytes(t, zipMember{name: "LogBrew.nuspec", body: "<package>"}),
		"commit":      zipBytes(t, zipMember{name: "LogBrew.nuspec", body: publicNuspec("LogBrew", "0.1.11", strings.Repeat("f", 40))}),
		"dependencies": zipBytes(t, zipMember{name: "LogBrew.nuspec",
			body: nuspecText("LogBrew", "0.1.11", artifactCommit, "<dependencies><dependency/></dependencies>")}),
	} {
		if _, err := validatePublicPackage(body, "LogBrew", "0.1.11", artifactCommit, contract); err == nil {
			t.Errorf("%s: package accepted", name)
		}
	}
	metadata := func(text string) *xmlElement {
		root, err := parseXML([]byte("<metadata>" + text + "</metadata>"))
		if err != nil {
			t.Fatal(err)
		}
		return root
	}
	for name, text := range map[string]string{
		"none":      "",
		"two":       "<dependencies/><dependencies/>",
		"child":     `<dependencies><group targetFramework="net8.0"><other/></group></dependencies>`,
		"not group": `<dependencies><dependency id="A" version="1.0.0"/></dependencies>`,
	} {
		if validNuspecDependencies(metadata(text), contract) {
			t.Errorf("%s: dependencies accepted", name)
		}
	}
}

func TestPublicArchiveLimits(t *testing.T) {
	archive := zipBytes(t, zipMember{name: "a", body: "x"})
	end := len(archive) - zipEndRecordBytes
	if !preflightPackage(archive) {
		t.Fatal("valid archive rejected")
	}
	for name, data := range map[string][]byte{
		"empty":     nil,
		"large":     make([]byte, maxPackageBytes+1),
		"no record": []byte("archive"),
		"late":      append(bytes.Clone(archive), "PK\x05\x06"...),
		"disk":      patched(archive, end+4, 1),
		"entries":   patched(archive, end+8, 2),
		"members":   patched(archive, end+8, 0x01, 0x04, 0x01, 0x04),
		"offset":    patched(archive, end+16, 0),
		"comment":   append(bytes.Clone(archive), 0),
	} {
		if preflightPackage(data) {
			t.Errorf("%s: archive accepted", name)
		}
	}
	if boundedEntries([]zipEntry{{name: "d/", attrs: directoryFileType << 16}, {name: "d/a", attrs: regularFileType << 16}}) != nil {
		t.Fatal("valid entries rejected")
	}
	many := make([]zipEntry, maxArchiveMembers+1)
	for index := range many {
		many[index].name = strings.Repeat("a", index+1)
	}
	for name, entries := range map[string][]zipEntry{
		"duplicate": {{name: "a"}, {name: "a"}},
		"unsafe":    {{name: "/a"}},
		"member":    {{name: "a", size: maxArchiveMemberBytes + 1}},
		"encrypted": {{name: "a", flags: 1}},
		"link":      {{name: "a", attrs: 0o120000 << 16}},
		"total":     {{name: "a", size: maxArchiveMemberBytes}, {name: "b", size: maxArchiveMemberBytes}, {name: "c", size: maxArchiveMemberBytes}, {name: "d", size: maxArchiveMemberBytes}, {name: "e", size: 1}},
		"count":     many,
	} {
		if boundedEntries(entries) == nil {
			t.Errorf("%s: entries accepted", name)
		}
	}
	for name, want := range map[string]bool{"a/./b": true, "": false, "./": false, "/a": false, `a\b`: false, "a/../b": false} {
		if safeArchiveName(name) != want {
			t.Errorf("name %q", name)
		}
	}
}

func TestXMLAttributes(t *testing.T) {
	root, err := parseXML([]byte("\ufeff<a xmlns:x=\"urn:x\" x:b=\"1\" c=\"2\"/>\n"))
	if err != nil || root.attribute("{urn:x}b") != "1" || root.attribute("c") != "2" || root.attribute("d") != nil ||
		len(root.iter()) != 1 || (*xmlElement)(nil).iter() != nil {
		t.Fatalf("root %+v, error %v", root, err)
	}
	for _, text := range []string{`<a xmlns:x="u" xmlns:y="u" x:b="1" y:b="2"/>`, "<a/>junk", "junk<a/>"} {
		if _, err := parseXML([]byte(text)); err == nil {
			t.Errorf("%q accepted", text)
		}
	}
}
