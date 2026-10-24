package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	maxPythonArtifactBytes = 25 << 20
	maxPythonMetadataBytes = 512 << 10
	pypiAPIRoot            = "https://pypi.org/pypi/"
	pypiFileOrigin         = "files.pythonhosted.org"
)

var (
	errPythonPublic = pythonFailure("public artifact verification failed")
	pythonDigest    = regexp.MustCompile(`^[0-9a-f]{64}$`)
	pythonKinds     = []string{"wheel", "sdist"}
)

// pythonFailure is a message the Python release check prints after its prefix.
type pythonFailure string

func (failure pythonFailure) Error() string { return string(failure) }

// pythonPackage is one public Python distribution: its PyPI name, its
// directory under the artifact root, and its file name prefix.
type pythonPackage struct{ id, directory, prefix string }

func (release pythonPackage) artifact(version, kind string) string {
	if kind == "wheel" {
		return release.prefix + "-" + version + "-py3-none-any.whl"
	}
	return release.prefix + "-" + version + ".tar.gz"
}

type pythonRelease struct {
	catalog   []pythonPackage
	transport http.RoundTripper
}

// pythonCatalog lists the public Python packages in repository release order.
func pythonCatalog() ([]pythonPackage, error) {
	catalog, err := loadReleaseCatalog(releaseCatalogText)
	packages := []pythonPackage{}
	for _, entry := range catalog.RepoWide {
		for _, candidate := range catalog.PyPI {
			if entry[0] == "pypi" && entry[1] == candidate.Name {
				packages = append(packages, pythonPackage{candidate.Name, path.Base(candidate.Dir), candidate.Package})
			}
		}
	}
	return packages, err
}

// checkPythonArtifacts runs one Python release artifact command.
func checkPythonArtifacts(command string, values map[string]*string, versions, paths []string, epoch int64,
	transport http.RoundTripper, output, diagnostic io.Writer,
) int {
	packages, err := pythonCatalog()
	release := pythonRelease{packages, transport}
	value := func(name string) string { return pyPath(*values[name]) }
	if err == nil {
		switch command {
		case "create":
			err = release.createCommand(value("directory"), versions, *values["source-commit"], value("manifest"))
		case "verify":
			var manifest map[string]any
			if manifest, err = loadPythonManifest(value("manifest")); err == nil {
				err = release.verify(value("directory"), manifest)
			}
		case "check-manifest":
			err = release.checkIdentity(value("manifest"), versions, *values["source-commit"])
		case "normalize-sdist":
			err = normalizeSdists(paths, epoch)
		default:
			err = release.resolvePublic(value("manifest"), value("directory"), value("output-directory"),
				value("public-manifest"), value("reconciliation"))
		}
	}
	if err != nil {
		return writeText(diagnostic, "Python release artifacts failed: "+err.Error()+"\n", exitFailure)
	}
	return writeText(output, "python release artifacts ok\n", exitOK)
}

func (release pythonRelease) createCommand(directory string, rawVersions []string, commit, manifestPath string) error {
	versions, err := release.selection(rawVersions)
	var manifest map[string]any
	if err == nil {
		manifest, err = release.create(directory, versions, commit)
	}
	if err == nil {
		err = writePlanJSON(manifestPath, manifest, "")
	}
	return err
}

func (release pythonRelease) checkIdentity(manifestPath string, rawVersions []string, commit string) error {
	manifest, err := loadPythonManifest(manifestPath)
	var versions, declared map[string]string
	if err == nil {
		versions, err = release.selection(rawVersions)
	}
	if err == nil {
		declared, err = release.manifestVersions(manifest)
	}
	if err == nil && (!maps.Equal(declared, versions) || manifest["sourceCommit"] != commit) {
		err = pythonFailure("Python release manifest identity mismatch")
	}
	return err
}

// selection parses one PACKAGE=VERSION value for every public package.
func (release pythonRelease) selection(raw []string) (map[string]string, error) {
	versions := map[string]string{}
	for _, text := range raw {
		id, version, found := strings.Cut(text, "=")
		id, version = pyStrip(id), pyStrip(version)
		known := slices.ContainsFunc(release.catalog, func(candidate pythonPackage) bool { return candidate.id == id })
		if !found || !known || !nugetPlanVersion.MatchString(version) {
			return nil, pythonFailure("invalid Python package version selection")
		}
		if _, duplicate := versions[id]; duplicate {
			return nil, pythonFailure("duplicate Python package version selection")
		}
		versions[id] = version
	}
	if len(versions) != len(release.catalog) {
		return nil, pythonFailure("Python release validation requires every public package version")
	}
	return versions, nil
}

// create validates the exact wheel and source archive of every package and
// returns their manifest.
func (release pythonRelease) create(directory string, versions map[string]string, commit string,
) (map[string]any, error) {
	if !sourceCommitSHA.MatchString(commit) {
		return nil, pythonFailure("source commit must be 40 lowercase hexadecimal characters")
	}
	missing, unexpected, records := []string{}, []string{}, []any{}
	for _, candidate := range release.catalog {
		version := versions[candidate.id]
		root := directory + "/" + candidate.directory
		expected := []string{candidate.artifact(version, "wheel"), candidate.artifact(version, "sdist")}
		actual := map[string]bool{}
		if info, err := os.Stat(root); err == nil && info.IsDir() {
			entries, _ := os.ReadDir(root)
			for _, entry := range entries {
				name := entry.Name()
				if regularFile(root+"/"+name) && (len(name) > 4 && strings.HasSuffix(name, ".whl") ||
					strings.HasSuffix(name, ".tar.gz")) {
					actual[name] = true
				}
			}
		}
		for _, name := range slices.Sorted(slices.Values(expected)) {
			if !actual[name] {
				missing = append(missing, "missing artifact: "+candidate.directory+"/"+name)
			}
		}
		for _, name := range slices.Sorted(maps.Keys(actual)) {
			if !slices.Contains(expected, name) {
				unexpected = append(unexpected, "unexpected artifact: "+candidate.directory+"/"+name)
			}
		}
		if !regularFile(root+"/"+expected[0]) || !regularFile(root+"/"+expected[1]) {
			continue
		}
		record := map[string]any{"id": candidate.id, "version": version}
		for index, kind := range pythonKinds {
			data, err := readArtifact(root + "/" + expected[index])
			if kind == "wheel" {
				err = validateWheel(data, err, candidate.id, version)
			} else {
				err = validateSdist(data, err, candidate.id, version, expected[index])
			}
			if err != nil {
				return nil, err
			}
			record[kind] = map[string]any{"file": candidate.directory + "/" + expected[index], "sha256": sha256Hex(data)}
		}
		records = append(records, record)
	}
	if failures := append(missing, unexpected...); len(failures) > 0 {
		return nil, pythonFailure(strings.Join(failures, "\n"))
	}
	return map[string]any{"schemaVersion": json.Number("1"), "sourceCommit": commit, "packages": records}, nil
}

// readArtifact reads a file up to one byte past the artifact limit.
func readArtifact(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return io.ReadAll(io.LimitReader(file, maxPythonArtifactBytes+1))
}

func validateWheel(data []byte, err error, id, version string) error {
	var entries []zipEntry
	if err == nil && preflightPackage(data, maxPythonArtifactBytes) {
		entries, err = openZip(data)
	} else {
		err = errZipEntry
	}
	if err != nil {
		return pythonFailure(id + ": invalid wheel archive")
	}
	if boundedEntries(entries) != nil {
		return pythonFailure(id + ": invalid wheel entries")
	}
	metadata := slices.DeleteFunc(entries, func(entry zipEntry) bool {
		return !strings.HasSuffix(entry.name, ".dist-info/METADATA")
	})
	if len(metadata) != 1 {
		return pythonFailure(id + ": expected one wheel metadata file")
	}
	if metadata[0].size > maxPythonMetadataBytes {
		return pythonFailure(id + ": invalid wheel entries")
	}
	raw, err := readZipFile(metadata[0])
	if err != nil {
		return pythonFailure(id + ": invalid wheel archive")
	}
	if len(raw) != int(metadata[0].size) {
		return pythonFailure(id + ": invalid wheel entries")
	}
	return validatePackageMetadata(raw, id, version)
}

func validateSdist(data []byte, err error, id, version, name string) error {
	var stream []byte
	var members []tarMember
	if err == nil {
		stream, members, err = readSdist(data)
	}
	if errors.Is(err, errTarEntries) {
		return pythonFailure(id + ": invalid source archive entries")
	}
	if err != nil {
		return pythonFailure(id + ": invalid source archive")
	}
	metadataName := strings.TrimSuffix(name, ".tar.gz") + "/PKG-INFO"
	members = slices.DeleteFunc(members, func(member tarMember) bool {
		return !member.regular() || member.name != metadataName
	})
	if len(members) != 1 {
		return pythonFailure(id + ": expected one source metadata file")
	}
	if members[0].size > maxPythonMetadataBytes {
		return pythonFailure(id + ": invalid source archive entries")
	}
	raw, err := members[0].contents(stream)
	if err != nil {
		return pythonFailure(id + ": invalid source archive")
	}
	return validatePackageMetadata(raw, id, version)
}

// validatePackageMetadata requires UTF-8 core metadata whose first Name and
// Version headers match the package.
func validatePackageMetadata(raw []byte, id, version string) error {
	if !utf8.Valid(raw) {
		return pythonFailure(id + ": invalid package metadata")
	}
	name, named := metadataHeader(string(raw), "name")
	declared, versioned := metadataHeader(string(raw), "version")
	if !named || !versioned || name != id || declared != version {
		return pythonFailure(id + ": package metadata mismatch")
	}
	return nil
}

// metadataHeader returns the first header with the lowercase name, as
// Python's email parser reads it with the compat32 policy.
func metadataHeader(text, wanted string) (string, bool) {
	lines := []string{}
	for text != "" {
		end := strings.IndexAny(text, "\r\n") + 1
		if end == 0 {
			end = len(text)
		} else if strings.HasPrefix(text[end-1:], "\r\n") {
			end++
		}
		lines, text = append(lines, text[:end]), text[end:]
	}
	name, value := "", []string{}
	for _, line := range lines {
		colon := strings.IndexFunc(line, func(character rune) bool {
			return character < '!' || character > '~' || character == ':'
		})
		continuation := line[0] == ' ' || line[0] == '\t'
		if !continuation && !strings.HasPrefix(line, "From ") && (colon < 0 || line[colon] != ':') {
			break
		}
		if continuation {
			if name != "" {
				value = append(value, line)
			}
			continue
		}
		if strings.ToLower(name) == wanted {
			break
		}
		name, value = "", nil
		if !strings.HasPrefix(line, "From ") && colon > 0 {
			name, value = line[:colon], []string{strings.TrimLeft(line[colon+1:], " \t")}
		}
	}
	if strings.ToLower(name) != wanted {
		return "", false
	}
	return strings.TrimRight(strings.Join(value, ""), "\r\n"), true
}

func loadPythonManifest(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	var value any
	if err == nil {
		value, err = decodePlanJSON(data)
	}
	manifest, ok := value.(map[string]any)
	if err != nil || !ok {
		return nil, pythonFailure("invalid Python release manifest")
	}
	return manifest, nil
}

// manifestVersions checks a manifest's shape and returns its package versions.
func (release pythonRelease) manifestVersions(manifest map[string]any) (map[string]string, error) {
	if !pyEqual(manifest["schemaVersion"], json.Number("1")) {
		return nil, pythonFailure("invalid Python release manifest schema")
	}
	commit, _ := manifest["sourceCommit"].(string)
	packages, ok := manifest["packages"].([]any)
	if !sourceCommitSHA.MatchString(commit) || !ok || len(packages) != len(release.catalog) {
		return nil, pythonFailure("invalid Python release manifest")
	}
	versions := map[string]string{}
	for index, candidate := range release.catalog {
		entry, ok := packages[index].(map[string]any)
		if !ok || !slices.Equal(slices.Sorted(maps.Keys(entry)), []string{"id", "sdist", "version", "wheel"}) {
			return nil, pythonFailure("invalid Python release manifest package order")
		}
		version, _ := entry["version"].(string)
		if entry["id"] != candidate.id || !nugetPlanVersion.MatchString(version) {
			return nil, pythonFailure("invalid Python release manifest package")
		}
		for _, kind := range pythonKinds {
			artifact, ok := entry[kind].(map[string]any)
			file := candidate.directory + "/" + candidate.artifact(version, kind)
			if !ok || !slices.Equal(slices.Sorted(maps.Keys(artifact)), []string{"file", "sha256"}) ||
				artifact["file"] != file || !manifestDigest(artifact["sha256"]) {
				return nil, pythonFailure("invalid Python release manifest artifact")
			}
		}
		versions[candidate.id] = version
	}
	return versions, nil
}

// manifestDigest accepts what Python's str() prints as 64 lowercase
// hexadecimal characters: such a string, or a 64-digit integer.
func manifestDigest(value any) bool {
	switch value := value.(type) {
	case string:
		return pythonDigest.MatchString(value)
	case json.Number:
		return len(value) == 64 && strings.Trim(string(value), "0123456789") == ""
	}
	return false
}

// verify requires the artifacts to match the manifest digests and the
// manifest to equal the one their contents produce.
func (release pythonRelease) verify(directory string, manifest map[string]any) error {
	versions, err := release.manifestVersions(manifest)
	if err != nil {
		return err
	}
	mismatch := pythonFailure("Python release artifact digest or metadata mismatch")
	for index, candidate := range release.catalog {
		entry := manifest["packages"].([]any)[index].(map[string]any)
		for _, kind := range pythonKinds {
			path := directory + "/" + candidate.directory + "/" + candidate.artifact(versions[candidate.id], kind)
			if !regularFile(path) {
				return mismatch
			}
			if digest, err := fileSHA256(path); err != nil || entry[kind].(map[string]any)["sha256"] != digest {
				return mismatch
			}
		}
	}
	expected, err := release.create(directory, versions, manifest["sourceCommit"].(string))
	if err == nil && !pyEqual(manifest, expected) {
		err = mismatch
	}
	return err
}

// normalizeSdists rewrites each source archive in place in a fixed form.
func normalizeSdists(paths []string, epoch int64) error {
	if epoch < 0 || epoch > 0xffffffff {
		return pythonFailure("invalid source date epoch")
	}
	for _, path := range paths {
		path = pyPath(path)
		data, err := readArtifact(path)
		var stream []byte
		var members []tarMember
		if err == nil {
			stream, members, err = readSdist(data)
		}
		if err == nil {
			stream, err = normalizedTar(stream, members, epoch)
		}
		if errors.Is(err, errTarEntries) {
			return pythonFailure("invalid source archive entries")
		}
		if err != nil {
			return pythonFailure("invalid source archive")
		}
		compressed := gzipSdist(stream, epoch)
		if len(stream) > maxTarStreamBytes || !preflightTar(stream) || len(compressed) > maxPythonArtifactBytes {
			return pythonFailure("invalid normalized source archive")
		}
		if replaceFile(path, compressed) != nil {
			return pythonFailure("invalid source archive")
		}
	}
	return nil
}

// replaceFile atomically replaces a file with world-readable contents.
func replaceFile(path string, data []byte) error {
	temporary, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*.tar.gz")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	_, err = temporary.Write(data)
	if err == nil {
		err = temporary.Sync()
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Chmod(temporary.Name(), 0o644)
	}
	if err == nil {
		err = os.Rename(temporary.Name(), path)
	}
	return err
}

// resolvePublic downloads the public PyPI files of a verified build, requires
// the same archive contents, and records which bytes were published.
func (release pythonRelease) resolvePublic(manifestPath, built, outputDirectory, publicManifest, reconciliation string,
) error {
	manifest, err := loadPythonManifest(manifestPath)
	var versions map[string]string
	if err == nil {
		versions, err = release.manifestVersions(manifest)
	}
	if err == nil {
		err = release.verify(built, manifest)
	}
	if err != nil {
		return err
	}
	if _, err := os.Lstat(outputDirectory); err == nil {
		return errPythonPublic
	}
	parent := filepath.Dir(outputDirectory)
	err = os.MkdirAll(parent, 0o777)
	var temporary string
	if err == nil {
		temporary, err = os.MkdirTemp(parent, ".python-public.")
	}
	if err != nil {
		return errPythonPublic
	}
	defer os.RemoveAll(temporary)
	commit := manifest["sourceCommit"].(string)
	records := []any{}
	for index, candidate := range release.catalog {
		version := versions[candidate.id]
		files, err := release.publicFiles(candidate, version)
		if err == nil {
			err = os.Mkdir(temporary+"/"+candidate.directory, 0o777)
		}
		if err != nil {
			return errPythonPublic
		}
		record := map[string]any{"id": candidate.id, "version": version}
		for _, kind := range pythonKinds {
			name := candidate.artifact(version, kind)
			registry := files[name]
			body, err := fetchPython(release.transport, registry[1], maxPythonArtifactBytes, 60*time.Second)
			if err == nil && sha256Hex(body) != registry[0] {
				err = errPythonPublic
			}
			if err == nil {
				err = os.WriteFile(temporary+"/"+candidate.directory+"/"+name, body, 0o666)
			}
			builtData, builtErr := readArtifact(built + "/" + candidate.directory + "/" + name)
			builtContent, publicContent := "", ""
			if err == nil && builtErr == nil {
				builtContent, err = archiveContentSHA256(builtData, kind)
			}
			if err == nil && builtErr == nil {
				publicContent, err = archiveContentSHA256(body, kind)
			}
			if err != nil || builtErr != nil || builtContent != publicContent {
				return errPythonPublic
			}
			state := "existing"
			if registry[0] == manifest["packages"].([]any)[index].(map[string]any)[kind].(map[string]any)["sha256"] {
				state = "source-build"
			}
			record[kind] = map[string]any{"file": candidate.directory + "/" + name, "sha256": registry[0],
				"registrySha256": registry[0], "contentSha256": publicContent, "publicationState": state}
		}
		records = append(records, record)
	}
	public, err := release.create(temporary, versions, commit)
	if err == nil {
		err = os.Rename(temporary, outputDirectory)
	}
	if err == nil {
		err = writePlanJSON(publicManifest, public, "")
	}
	if err == nil {
		err = writePlanJSON(reconciliation, map[string]any{"schemaVersion": json.Number("1"), "sourceCommit": commit,
			"packages": records}, "")
	}
	return err
}

// publicFiles reads a release's PyPI metadata and returns each expected
// file's SHA-256 digest and download URL.
func (release pythonRelease) publicFiles(candidate pythonPackage, version string) (map[string][2]string, error) {
	body, err := fetchPython(release.transport,
		pypiAPIRoot+url.QueryEscape(candidate.id)+"/"+url.QueryEscape(version)+"/json", maxMetadataBytes,
		30*time.Second)
	var value any
	if err == nil {
		value, err = decodePlanJSON(bytes.TrimPrefix(body, []byte("\ufeff")))
	}
	payload, _ := value.(map[string]any)
	info, _ := payload["info"].(map[string]any)
	entries, ok := payload["urls"].([]any)
	if err != nil || info == nil || info["name"] != candidate.id || info["version"] != version || !ok {
		return nil, errPythonPublic
	}
	expected := map[string]string{
		candidate.artifact(version, "wheel"): "bdist_wheel", candidate.artifact(version, "sdist"): "sdist",
	}
	files := map[string][2]string{}
	for _, item := range entries {
		entry, _ := item.(map[string]any)
		filename, _ := entry["filename"].(string)
		packageType, known := expected[filename]
		_, duplicate := files[filename]
		digests, _ := entry["digests"].(map[string]any)
		digest, _ := digests["sha256"].(string)
		address, valid := publicFileURL(entry["url"], filename)
		if !known || duplicate || entry["packagetype"] != packageType || !pythonDigest.MatchString(digest) || !valid {
			return nil, errPythonPublic
		}
		files[filename] = [2]string{digest, address}
	}
	if len(files) != len(expected) {
		return nil, errPythonPublic
	}
	return files, nil
}

// publicFileURL accepts an HTTPS file URL on the PyPI file host that names the
// file, read the way Python's urlsplit and PurePosixPath read it, and returns
// the URL to request.
func publicFileURL(raw any, filename string) (string, bool) {
	text, ok := raw.(string)
	rest := strings.NewReplacer("\t", "", "\r", "", "\n", "").Replace(
		strings.TrimLeftFunc(text, func(character rune) bool { return character <= ' ' }))
	scheme := ""
	if colon := strings.IndexByte(rest, ':'); colon > 0 && (rest[0]|0x20) >= 'a' && (rest[0]|0x20) <= 'z' &&
		strings.Trim(rest[:colon], "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+-.") == "" {
		scheme, rest = strings.ToLower(rest[:colon]), rest[colon+1:]
	}
	netloc := ""
	if strings.HasPrefix(rest, "//") {
		end := strings.IndexAny(rest[2:], "/?#")
		if end < 0 {
			end = len(rest) - 2
		}
		netloc, rest = rest[2:2+end], rest[2+end:]
	}
	rest, fragment, _ := strings.Cut(rest, "#")
	filePath, query, _ := strings.Cut(rest, "?")
	parts := slices.DeleteFunc(strings.Split(filePath, "/"), func(part string) bool { return part == "" || part == "." })
	address := pyStrip(text)
	parsed, err := url.Parse(address)
	return address, ok && scheme == "https" && netloc == pypiFileOrigin && query == "" && fragment == "" &&
		strings.HasPrefix(filePath, "/") && !strings.Contains(filePath, "%") && !slices.Contains(parts, "..") &&
		len(parts) > 0 && parts[len(parts)-1] == filename &&
		!strings.ContainsFunc(address, func(character rune) bool { return character <= ' ' || character >= 0x7f }) &&
		err == nil && parsed.EscapedPath() == filePath
}

// fetchPython reads one response body the way Python's urllib does: no
// redirects, no content decoding, and only status 200.
func fetchPython(transport http.RoundTripper, address string, limit int64, timeout time.Duration) ([]byte, error) {
	response, err := getPublic(transport, address, timeout, "identity")
	if err != nil {
		return nil, errPythonPublic
	}
	defer response.Body.Close()
	var body []byte
	if response.StatusCode == http.StatusOK {
		body, err = readBounded(response.Body, limit)
	}
	if response.StatusCode != http.StatusOK || err != nil {
		return nil, errPythonPublic
	}
	return body, nil
}

// archiveContentSHA256 digests a wheel's files or a source archive's regular
// members by name, size, and bytes, in name order.
func archiveContentSHA256(data []byte, kind string) (string, error) {
	if kind == "wheel" {
		return zipContentSHA256(data, maxPythonArtifactBytes, func(name string) bool { return !strings.HasSuffix(name, "/") })
	}
	stream, members, err := readSdist(data)
	members = slices.DeleteFunc(members, func(member tarMember) bool { return !member.regular() })
	slices.SortFunc(members, func(left, right tarMember) int {
		return slices.Compare(pyCodePoints(left.name), pyCodePoints(right.name))
	})
	digest := sha256.New()
	for _, member := range members {
		contents, readErr := member.contents(stream)
		if !utf8.ValidString(member.name) || readErr != nil {
			err = errPythonPublic
		}
		digest.Write(binary.BigEndian.AppendUint64(nil, uint64(len(member.name))))
		digest.Write([]byte(member.name))
		digest.Write(binary.BigEndian.AppendUint64(nil, uint64(member.size)))
		digest.Write(contents)
	}
	if err != nil {
		return "", errPythonPublic
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}
