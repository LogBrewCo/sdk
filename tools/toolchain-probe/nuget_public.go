package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha512"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
)

const (
	publicNuGetFailed          = "NuGet public artifact verification failed"
	nugetRegistrationRoot      = "https://api.nuget.org/v3/registration5-gz-semver2/"
	nugetPackageRoot           = "https://api.nuget.org/v3-flatcontainer/"
	nugetCatalogRoot           = "https://api.nuget.org/v3/catalog0/data/"
	maxMetadataBytes           = 2 << 20
	maxMetadataCompressedBytes = 1 << 20
	maxPackageBytes            = 50 << 20
	maxArchiveMembers          = 1024
	maxArchiveMemberBytes      = 8 << 20
	maxArchiveBytes            = 32 << 20
	maxNuspecBytes             = 512 << 10
	maxProjectBytes            = 512 << 10
	maxZipTailBytes            = 65_557
	zipEndRecordBytes          = 22
	fileTypeMask               = 0o170000
	directoryFileType          = 0o040000
	regularFileType            = 0o100000
)

var (
	errPublicNuGet     = errors.New(publicNuGetFailed)
	publicPackageIDs   = []string{"LogBrew", "LogBrew.HttpClient"}
	catalogTimestamp   = regexp.MustCompile(`^[0-9]{4}(?:\.[0-9]{2}){5}$`)
	nugetFrameworkName = map[string]string{".NETStandard2.0": "netstandard2.0"}
)

// dependencyContract is the target frameworks and dependency ranges a source
// project declares.
type dependencyContract struct {
	dependencies map[string]string
	frameworks   []string
}

func checkPublicNuGet(values map[string]*string, rawVersions []string, dependencyRange string,
	transport http.RoundTripper, output, diagnostic io.Writer,
) int {
	versions := map[string]string{}
	ids := []string{}
	for _, raw := range rawVersions {
		id, version, found := strings.Cut(raw, "=")
		id, version = pyStrip(id), pyStrip(version)
		if _, duplicate := versions[id]; !found || !slices.Contains(publicPackageIDs, id) ||
			!nugetPlanVersion.MatchString(version) || duplicate {
			ids = nil
			break
		}
		versions[id], ids = version, append(ids, id)
	}
	if !slices.Equal(ids, publicPackageIDs) {
		return writeText(diagnostic, "invalid NuGet public package selection\n", exitFailure)
	}
	err := resolvePublicNuGet(versions, *values["source-commit"], dependencyRange, pyPath(*values["source-root"]),
		pyPath(*values["output-directory"]), pyPath(*values["manifest"]), transport)
	if err != nil {
		return writeText(diagnostic, publicNuGetFailed+"\n", exitFailure)
	}
	return writeText(output, "NuGet public artifact verification ok\n", exitOK)
}

// resolvePublicNuGet downloads the registry's exact package bytes, binds them
// to the source commit and project dependency ranges, and writes a receipt.
func resolvePublicNuGet(versions map[string]string, commit, dependencyRange, sourceRoot, directory, manifest string,
	transport http.RoundTripper,
) error {
	_, existing := os.Lstat(directory)
	if !sourceCommitSHA.MatchString(commit) || !strings.HasPrefix(dependencyRange, "["+versions["LogBrew"]+", ") ||
		!strings.HasSuffix(dependencyRange, ")") || existing == nil {
		return errPublicNuGet
	}
	contracts := map[string]dependencyContract{}
	for _, id := range publicPackageIDs {
		contract, ok := sourceDependencyContract(sourceRoot, id, dependencyRange)
		if !ok {
			return errPublicNuGet
		}
		contracts[id] = contract
	}
	err := os.MkdirAll(filepath.Dir(directory), 0o777)
	temporary := ""
	if err == nil {
		temporary, err = os.MkdirTemp(filepath.Dir(directory), ".nuget-public.")
	}
	if err != nil {
		return err
	}
	defer os.RemoveAll(temporary)
	records := []map[string]string{}
	for _, id := range publicPackageIDs {
		record, err := publicPackage(transport, temporary, id, versions[id], commit, contracts[id])
		if err != nil {
			return err
		}
		records = append(records, record)
	}
	if err := os.Rename(temporary, directory); err != nil {
		return err
	}
	return writePlanJSON(manifest, map[string]any{"schemaVersion": 1, "sourceCommit": commit, "packages": records}, "")
}

func publicPackage(transport http.RoundTripper, directory, id, version, commit string, contract dependencyContract,
) (map[string]string, error) {
	packageURL, registryDigest, err := registryRecord(transport, id, version, contract)
	var body []byte
	if err == nil {
		body, err = fetchBounded(transport, packageURL, maxPackageBytes, 60*time.Second, false)
	}
	if digest := sha512.Sum512(body); err == nil && !bytes.Equal(digest[:], registryDigest) {
		err = errPublicNuGet
	}
	name := id + "." + version + ".nupkg"
	if err == nil {
		err = os.WriteFile(filepath.Join(directory, name), body, 0o666)
	}
	content := ""
	if err == nil {
		content, err = validatePublicPackage(body, id, version, commit, contract)
	}
	if err != nil {
		return nil, err
	}
	return map[string]string{
		"id": id, "version": version, "file": name, "sha256": sha256Hex(body),
		"registrySha512": base64.StdEncoding.EncodeToString(registryDigest), "contentSha256": content,
	}, nil
}

// fetchBounded reads one registry response without following redirects. Only
// metadata may arrive gzip-compressed, and only as a single gzip member.
func fetchBounded(transport http.RoundTripper, url string, limit int64, timeout time.Duration, metadata bool,
) ([]byte, error) {
	response, err := getPublic(transport, url, timeout, map[bool]string{false: "identity", true: "gzip"}[metadata])
	if err != nil {
		return nil, errPublicNuGet
	}
	defer response.Body.Close()
	encoding := response.Header.Values("Content-Encoding")
	switch {
	case response.StatusCode != http.StatusOK:
	case len(encoding) == 0, metadata && slices.Equal(encoding, []string{"identity"}):
		return readBounded(response.Body, limit)
	case metadata && slices.Equal(encoding, []string{"gzip"}):
		compressed, err := readBounded(response.Body, maxMetadataCompressedBytes)
		source := bytes.NewReader(compressed)
		var reader *gzip.Reader
		if err == nil {
			reader, err = gzip.NewReader(source)
		}
		var body []byte
		if err == nil {
			reader.Multistream(false)
			body, err = readBounded(reader, limit)
		}
		if err == nil && source.Len() == 0 {
			return body, nil
		}
	}
	return nil, errPublicNuGet
}

// getPublic sends one registry request without following redirects.
func getPublic(transport http.RoundTripper, url string, timeout time.Duration, encoding string) (*http.Response, error) {
	client := &http.Client{Transport: transport, Timeout: timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return errPublicNuGet }}
	request, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", "LogBrew public package reconciliation")
	request.Header.Set("Accept-Encoding", encoding)
	return client.Do(request)
}

func readBounded(reader io.Reader, limit int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err == nil && int64(len(data)) > limit {
		err = errPublicNuGet
	}
	return data, err
}

func fetchJSON(transport http.RoundTripper, url string) (any, error) {
	data, err := fetchBounded(transport, url, maxMetadataBytes, 30*time.Second, true)
	if err != nil {
		return nil, err
	}
	return decodePlanJSON(bytes.TrimPrefix(data, []byte("\ufeff")))
}

// registryRecord reads the registration and catalog entries and returns the
// package URL and its SHA-512 digest.
func registryRecord(transport http.RoundTripper, id, version string, contract dependencyContract,
) (string, []byte, error) {
	lower := strings.ToLower(id)
	packageURL := nugetPackageRoot + lower + "/" + version + "/" + lower + "." + version + ".nupkg"
	registration, err := fetchJSON(transport, nugetRegistrationRoot+lower+"/"+version+".json")
	catalogURL, _ := field(registration, "catalogEntry").(string)
	timestamp, name, _ := strings.Cut(strings.TrimPrefix(catalogURL, nugetCatalogRoot), "/")
	if err != nil || field(registration, "packageContent") != packageURL ||
		!strings.HasPrefix(catalogURL, nugetCatalogRoot) || !validCatalogTimestamp(timestamp) ||
		name != lower+"."+version+".json" || strings.Contains(version, "+") {
		return "", nil, errPublicNuGet
	}
	catalog, err := fetchJSON(transport, catalogURL)
	text, _ := field(catalog, "packageHash").(string)
	digest, decodeError := base64.StdEncoding.DecodeString(text)
	if err != nil || field(catalog, "id") != id || field(catalog, "version") != version ||
		field(catalog, "packageHashAlgorithm") != "SHA512" ||
		!validDependencyGroups(field(catalog, "dependencyGroups"), contract, "range") ||
		strings.ContainsAny(text, "\r\n") || decodeError != nil || len(digest) != sha512.Size {
		return "", nil, errPublicNuGet
	}
	return packageURL, digest, nil
}

func validCatalogTimestamp(text string) bool {
	parsed, err := time.Parse("2006.01.02.15.04.05", text)
	return catalogTimestamp.MatchString(text) && err == nil && parsed.Year() > 0
}

// validDependencyGroups requires one group per target framework, each with
// exactly the source project's dependency ranges.
func validDependencyGroups(groups any, contract dependencyContract, rangeKey string) bool {
	list, ok := groups.([]any)
	if !ok || len(list) != len(contract.frameworks) {
		return false
	}
	seen := map[string]bool{}
	for _, group := range list {
		framework, named := field(group, "targetFramework").(string)
		dependencies, listed := field(group, "dependencies").([]any)
		framework = cmpOr(nugetFrameworkName[framework], framework)
		if !named || framework == "" || !listed || seen[framework] || !slices.Contains(contract.frameworks, framework) {
			return false
		}
		seen[framework] = true
		actual := map[string]string{}
		for _, dependency := range dependencies {
			id, named := field(dependency, "id").(string)
			versionRange, valid := canonicalDependencyRange(field(dependency, rangeKey))
			if _, duplicate := actual[id]; !named || duplicate || !valid {
				return false
			}
			actual[id] = versionRange
		}
		if !maps.Equal(actual, contract.dependencies) {
			return false
		}
	}
	return true
}

// canonicalDependencyRange writes a bare minimum version as "[version, )" and
// accepts only "[minimum, )" or "[minimum, maximum)" ranges.
func canonicalDependencyRange(raw any) (string, bool) {
	text, ok := raw.(string)
	if nugetPlanVersion.MatchString(text) {
		return "[" + text + ", )", true
	}
	inner, opened := strings.CutPrefix(text, "[")
	inner, closed := strings.CutSuffix(inner, ")")
	parts := strings.Split(inner, ", ")
	return text, ok && opened && closed && len(parts) == 2 && nugetPlanVersion.MatchString(parts[0]) &&
		(parts[1] == "" || nugetPlanVersion.MatchString(parts[1]))
}

// sourceDependencyContract reads the target frameworks and package and
// project references a package's source project declares.
func sourceDependencyContract(sourceRoot, id, coreRange string) (dependencyContract, bool) {
	var contract dependencyContract
	rootInfo, rootError := os.Lstat(sourceRoot)
	path := sourceRoot + "/" + nugetRelease{ID: id}.project()
	info, err := os.Lstat(path)
	if !filepath.IsAbs(sourceRoot) || rootError != nil || !rootInfo.IsDir() || err != nil || !info.Mode().IsRegular() ||
		info.Size() > maxProjectBytes {
		return contract, false
	}
	document, err := os.ReadFile(path)
	var project *xmlElement
	if err == nil && !declaresDocumentType(document) {
		project, err = parseUTF8XML(document)
	}
	frameworks := []string{}
	for _, element := range project.iter() {
		if element.name == "TargetFrameworks" && element.value != nil && pyStrip(*element.value) != "" {
			frameworks = append(frameworks, pyStrip(*element.value))
		}
	}
	if err != nil || len(frameworks) != 1 {
		return contract, false
	}
	contract.frameworks = strings.Split(frameworks[0], ";")
	if slices.Contains(contract.frameworks, "") ||
		len(slices.Compact(slices.Sorted(slices.Values(contract.frameworks)))) != len(contract.frameworks) {
		return contract, false
	}
	contract.dependencies = map[string]string{}
	references := []string{}
	for _, group := range project.iter() {
		for _, item := range group.children {
			if group.name != "ItemGroup" || item.name != "PackageReference" && item.name != "ProjectReference" {
				continue
			}
			include := item.attributes["Include"]
			if group.attributes["Condition"] != "" || item.attributes["Condition"] != "" || include == "" {
				return contract, false
			}
			if item.name == "ProjectReference" {
				references = append(references, include)
				continue
			}
			version := item.attributes["Version"]
			if _, duplicate := contract.dependencies[include]; duplicate || !nugetPlanVersion.MatchString(version) {
				return contract, false
			}
			contract.dependencies[include] = "[" + version + ", )"
		}
	}
	if id == "LogBrew" && len(references) > 0 ||
		id != "LogBrew" && !slices.Equal(references, []string{"../LogBrew/LogBrew.csproj"}) {
		return contract, false
	}
	if id != "LogBrew" {
		var valid bool
		if contract.dependencies["LogBrew"], valid = canonicalDependencyRange(coreRange); !valid {
			return contract, false
		}
	}
	return contract, len(contract.dependencies) > 0
}

// declaresDocumentType reports a DOCTYPE or ENTITY declaration in any ASCII case.
func declaresDocumentType(document []byte) bool {
	upper := bytes.Map(func(character rune) rune {
		if 'a' <= character && character <= 'z' {
			return character - 'a' + 'A'
		}
		return character
	}, document)
	return bytes.Contains(upper, []byte("<!DOCTYPE")) || bytes.Contains(upper, []byte("<!ENTITY"))
}

// validatePublicPackage binds a downloaded package's nuspec to the expected
// identity, source commit, and dependency contract, and returns its content
// digest.
func validatePublicPackage(body []byte, id, version, commit string, contract dependencyContract) (string, error) {
	err := errPublicNuGet
	var entries []zipEntry
	if preflightPackage(body, maxPackageBytes) {
		entries, err = openZip(body)
	}
	if err == nil {
		err = boundedEntries(entries)
	}
	nuspecs := slices.DeleteFunc(slices.Clone(entries), func(entry zipEntry) bool {
		return !strings.HasSuffix(entry.name, ".nuspec")
	})
	var document []byte
	if err == nil && len(nuspecs) == 1 && nuspecs[0].size <= maxNuspecBytes {
		document, err = readZipFile(nuspecs[0])
	} else {
		err = errPublicNuGet
	}
	var root *xmlElement
	if err == nil && !declaresDocumentType(document) {
		root, err = parseUTF8XML(document)
	}
	metadata := root.child("metadata")
	repository := metadata.child("repository")
	if err != nil || metadata == nil || metadata.text("id") != id || metadata.text("version") != version ||
		repository == nil || repository.attributes["type"] != "git" || repository.attributes["url"] != sdkRepoURL ||
		repository.attributes["commit"] != commit || !validNuspecDependencies(metadata, contract) {
		return "", errPublicNuGet
	}
	return packageContentSHA256(body, true)
}

func validNuspecDependencies(metadata *xmlElement, contract dependencyContract) bool {
	nodes := metadata.all("dependencies")
	if len(nodes) != 1 {
		return false
	}
	groups := []any{}
	for _, group := range nodes[0].children {
		dependencies := []any{}
		for _, dependency := range group.children {
			if dependency.name != "dependency" {
				return false
			}
			dependencies = append(dependencies,
				map[string]any{"id": dependency.attribute("id"), "version": dependency.attribute("version")})
		}
		if group.name != "group" {
			return false
		}
		groups = append(groups, map[string]any{"targetFramework": group.attribute("targetFramework"),
			"dependencies": dependencies})
	}
	return validDependencyGroups(groups, contract, "version")
}

// preflightPackage requires a single-disk ZIP whose central directory ends the
// file, within the public archive limits and the size limit.
func preflightPackage(data []byte, limit int) bool {
	tail := data[max(0, len(data)-maxZipTailBytes):]
	offset := bytes.LastIndex(tail, []byte("PK\x05\x06"))
	if len(data) == 0 || len(data) > limit || offset < 0 || len(tail)-offset < zipEndRecordBytes {
		return false
	}
	record := tail[offset+4:]
	field16 := func(at int) int { return int(binary.LittleEndian.Uint16(record[at:])) }
	end := len(data) - len(tail) + offset
	return field16(0) == 0 && field16(2) == 0 && field16(4) == field16(6) && field16(6) <= maxArchiveMembers &&
		int(binary.LittleEndian.Uint32(record[12:]))+int(binary.LittleEndian.Uint32(record[8:])) == end &&
		end+zipEndRecordBytes+field16(16) == len(data)
}

// boundedEntries rejects duplicate or unsafe names, special files, encrypted
// members, and archives over the member and size limits.
func boundedEntries(entries []zipEntry) error {
	names := map[string]bool{}
	total := uint64(0)
	for _, entry := range entries {
		directory := strings.HasSuffix(entry.name, "/")
		fileType := entry.attrs >> 16 & fileTypeMask
		expected := map[bool]uint32{false: regularFileType, true: directoryFileType}[directory]
		if !directory {
			total += uint64(entry.size)
		}
		if names[entry.name] || !safeArchiveName(entry.name) || entry.size > maxArchiveMemberBytes ||
			entry.flags&1 != 0 || fileType != 0 && fileType != expected || total > maxArchiveBytes {
			return errPublicNuGet
		}
		names[entry.name] = true
	}
	if len(entries) > maxArchiveMembers {
		return errPublicNuGet
	}
	return nil
}

// safeArchiveName accepts a relative POSIX name without parent references or
// backslashes, as Python's PurePosixPath reads it.
func safeArchiveName(name string) bool {
	parts := slices.DeleteFunc(strings.Split(name, "/"), func(part string) bool { return part == "" || part == "." })
	return len(parts) > 0 && !strings.HasPrefix(name, "/") && !strings.ContainsAny(name, "\\\x00") &&
		!slices.Contains(parts, "..")
}
