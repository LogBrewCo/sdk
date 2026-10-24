package main

import (
	"archive/zip"
	"bytes"
	"compress/bzip2"
	"compress/flate"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"hash/crc32"
	"io"
	"maps"
	"net/http"
	"os"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/charmap"
)

const (
	releaseArtifactsMode  = "release-artifacts"
	releaseArtifactsUsage = "usage: release-artifacts dotnet|nuget-public [flags] | release-artifacts nuget-content PACKAGE\n"
	packageSignature      = ".signature.p7s"
	sourceLinkRoot        = "raw.githubusercontent.com/LogBrewCo/sdk"
)

var (
	errZipEntry            = errors.New("invalid ZIP entry")
	dependencyRangePattern = regexp.MustCompile(`^\[([^,\s]+), ([^)\s]+)\)$`)
	// Each command's required and optional flags.
	releaseArtifactFlags = map[string][2][]string{
		"dotnet":       {{"directory", "source-commit", "manifest"}, {"nuget-version", "dependency-range"}},
		"nuget-public": {{"source-commit", "dependency-range", "source-root", "output-directory", "manifest"}, {"nuget-version"}},
	}
)

// checkReleaseArtifacts validates exact .NET packages before publication, the
// public NuGet bytes for reconciliation, or prints one package's content digest.
func checkReleaseArtifacts(arguments []string, transport http.RoundTripper, output, diagnostic io.Writer) int {
	if len(arguments) == 2 && arguments[0] == "nuget-content" {
		data, err := os.ReadFile(arguments[1])
		digest := ""
		if err == nil {
			digest, err = packageContentSHA256(data, false)
		}
		if err != nil {
			return writeText(diagnostic, "invalid package content\n", exitFailure)
		}
		return writeText(output, digest+"\n", exitOK)
	}
	flags := flag.NewFlagSet(releaseArtifactsMode, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	values := map[string]*string{}
	for _, name := range []string{"directory", "source-commit", "manifest", "source-root", "output-directory"} {
		values[name] = flags.String(name, "", "")
	}
	var versions, ranges versionFlags
	flags.Var(&versions, "nuget-version", "")
	flags.Var(&ranges, "dependency-range", "")
	var spec [2][]string
	if len(arguments) > 0 && flags.Parse(arguments[1:]) == nil && flags.NArg() == 0 {
		spec = releaseArtifactFlags[arguments[0]]
	}
	set := map[string]bool{}
	flags.Visit(func(used *flag.Flag) { set[used.Name] = true })
	valid := len(spec[0]) > 0
	for name := range set {
		valid = valid && (slices.Contains(spec[0], name) || slices.Contains(spec[1], name))
	}
	for _, name := range spec[0] {
		valid = valid && set[name]
	}
	if !valid {
		return writeText(diagnostic, releaseArtifactsUsage, exitUsage)
	}
	if arguments[0] == "dotnet" {
		return checkDotnetArtifacts(values, versions, ranges, output, diagnostic)
	}
	return checkPublicNuGet(values, versions, ranges[len(ranges)-1], transport, output, diagnostic)
}

func checkDotnetArtifacts(values map[string]*string, rawVersions, rawRanges []string, output, diagnostic io.Writer) int {
	commit := *values["source-commit"]
	versions, ranges, err := dotnetSelection(commit, rawVersions, rawRanges)
	if err != nil {
		return writeText(diagnostic, err.Error()+"\n", exitUsage)
	}
	failures, records := validateDotnetArtifacts(pyPath(*values["directory"]), versions, commit, ranges)
	if len(failures) > 0 {
		return writeText(diagnostic, strings.Join(failures, "\n")+"\n", exitFailure)
	}
	err = writePlanJSON(pyPath(*values["manifest"]), map[string]any{"sourceCommit": commit, "packages": records}, "")
	if err != nil {
		return writeText(diagnostic, "cannot write the release artifact manifest\n", exitFailure)
	}
	var text strings.Builder
	for _, record := range records {
		fmt.Fprintf(&text, "%s@%s nupkg_sha256=%s content_sha256=%s snupkg_sha256=%s\n", record["id"],
			record["version"], record["nupkgSha256"], record["nupkgContentSha256"], record["snupkgSha256"])
	}
	return writeText(output, text.String()+"dotnet release artifacts ok\n", exitOK)
}

// dotnetSelection parses the package versions and dependency ranges to check.
func dotnetSelection(commit string, rawVersions, rawRanges []string,
) (map[string]string, map[string]map[string]string, error) {
	catalog, err := loadReleaseCatalog(releaseCatalogText)
	if err == nil && !sourceCommitSHA.MatchString(commit) {
		err = errors.New("--source-commit must be 40 lowercase hexadecimal characters")
	}
	if err != nil {
		return nil, nil, err
	}
	allowed := catalog.nugetIDs()
	versions := map[string]string{}
	for _, raw := range rawVersions {
		id, version, found := strings.Cut(raw, "=")
		id, version = pyStrip(id), pyStrip(version)
		if !found || !slices.Contains(allowed, id) || !publicSemver.MatchString(version) {
			return nil, nil, errors.New("invalid NuGet package version selection")
		}
		if _, duplicate := versions[id]; duplicate {
			return nil, nil, errors.New("duplicate NuGet package selection: " + id)
		}
		versions[id] = version
	}
	if len(versions) == 0 {
		return nil, nil, errors.New("missing NuGet package version selection")
	}
	ranges := map[string]map[string]string{}
	for _, raw := range rawRanges {
		selection, versionRange, found := strings.Cut(raw, "=")
		id, dependency, separated := strings.Cut(selection, ":")
		id, dependency, versionRange = pyStrip(id), pyStrip(dependency), pyStrip(versionRange)
		match := dependencyRangePattern.FindStringSubmatch(versionRange)
		if !found || !separated || !slices.Contains(allowed, id) || !slices.Contains(allowed, dependency) ||
			match == nil || !publicSemver.MatchString(match[1]) || !publicSemver.MatchString(match[2]) {
			return nil, nil, errors.New("invalid NuGet dependency range selection")
		}
		if ranges[id] == nil {
			ranges[id] = map[string]string{}
		}
		if _, duplicate := ranges[id][dependency]; duplicate {
			return nil, nil, errors.New("duplicate NuGet dependency range selection")
		}
		ranges[id][dependency] = versionRange
	}
	for id := range ranges {
		if _, selected := versions[id]; !selected {
			return nil, nil, errors.New("dependency range package must be selected for validation")
		}
	}
	if _, selected := versions["LogBrew.HttpClient"]; selected {
		core, found := ranges["LogBrew.HttpClient"]["LogBrew"]
		if len(ranges["LogBrew.HttpClient"]) != 1 || !found {
			return nil, nil, errors.New("missing HttpClient core dependency range")
		}
		if version, selected := versions["LogBrew"]; selected && core != compatibleDependencyRange(version) {
			return nil, nil, errors.New("HttpClient core dependency range does not match selected core version")
		}
	}
	return versions, ranges, nil
}

func validateDotnetArtifacts(directory string, versions map[string]string, commit string,
	ranges map[string]map[string]string,
) ([]string, []map[string]string) {
	expected := [2]map[string]bool{{}, {}}
	for id, version := range versions {
		expected[0][id+"."+version+".nupkg"] = true
		expected[1][id+"."+version+".snupkg"] = true
	}
	actual := [2]map[string]bool{{}, {}}
	entries, _ := os.ReadDir(directory)
	for _, entry := range entries {
		if name := entry.Name(); strings.HasSuffix(name, ".snupkg") {
			actual[1][name] = true
		} else if strings.HasSuffix(name, ".nupkg") {
			actual[0][name] = true
		}
	}
	failures := []string{}
	for index, label := range []string{"nupkg", "snupkg"} {
		for _, name := range slices.Sorted(maps.Keys(expected[index])) {
			if !actual[index][name] {
				failures = append(failures, "missing "+label+": "+name)
			}
		}
		for _, name := range slices.Sorted(maps.Keys(actual[index])) {
			if !expected[index][name] {
				failures = append(failures, "unexpected "+label+": "+name)
			}
		}
	}
	if len(failures) > 0 {
		return failures, nil
	}
	records := []map[string]string{}
	for _, id := range sortedKeys(versions) {
		record := map[string]string{"id": id, "version": versions[id]}
		paths := [2]string{}
		names := [2]map[string]bool{}
		for index, extension := range []string{".nupkg", ".snupkg"} {
			paths[index] = directory + "/" + id + "." + versions[id] + extension
			data, err := os.ReadFile(paths[index])
			names[index] = validateDotnetArchive(data, err, id, versions[id], commit, ranges[id], &failures)
			if err == nil {
				record[strings.TrimPrefix(extension, ".")+"Sha256"] = sha256Hex(data)
			}
		}
		assemblies, documentation, symbols := archiveStems(names[0], ".dll"), archiveStems(names[0], ".xml"),
			archiveStems(names[1], ".pdb")
		for _, missing := range []struct {
			message string
			failed  bool
		}{
			{"missing package assemblies", len(assemblies) == 0},
			{"missing XML documentation for package assemblies", !maps.Equal(assemblies, documentation)},
			{"missing portable symbols for package assemblies", !maps.Equal(assemblies, symbols)},
		} {
			if missing.failed {
				failures = append(failures, id+": "+missing.message)
			}
		}
		symbolNames := []string{}
		for stem := range symbols {
			symbolNames = append(symbolNames, stem+".pdb")
		}
		slices.Sort(symbolNames)
		failures = validateSourceLink(paths[1], id, symbolNames, commit, failures)
		data, err := os.ReadFile(paths[0])
		if err == nil {
			record["nupkgContentSha256"], err = packageContentSHA256(data, false)
		}
		if err != nil {
			failures = append(failures, id+": invalid package content")
		}
		records = append(records, record)
	}
	return failures, records
}

// validateDotnetArchive checks one package's nuspec and returns its member
// names, or none when the archive cannot be read.
func validateDotnetArchive(data []byte, err error, id, version, commit string, expected map[string]string,
	failures *[]string,
) map[string]bool {
	var entries []zipEntry
	if err == nil {
		entries, err = openZip(data)
	}
	names := map[string]bool{}
	nuspecs := []string{}
	for _, entry := range entries {
		if !names[entry.name] && strings.HasSuffix(entry.name, ".nuspec") {
			nuspecs = append(nuspecs, entry.name)
		}
		names[entry.name] = true
	}
	var root *xmlElement
	if err == nil && len(nuspecs) == 1 {
		var document []byte
		document, err = readZipFile(lastEntry(entries, nuspecs[0]))
		if err == nil {
			root, err = parseUTF8XML(document)
		}
	}
	metadata := root.child("metadata")
	repository := metadata.child("repository")
	switch {
	case err != nil:
		*failures = append(*failures, id+": invalid package archive")
		return nil
	case len(nuspecs) != 1:
		*failures = append(*failures, id+": expected one nuspec")
		return names
	case metadata == nil:
		*failures = append(*failures, id+": missing package metadata")
		return names
	}
	for _, mismatch := range []struct {
		message string
		failed  bool
	}{
		{"package id mismatch", metadata.rawText("id") != id},
		{"package version mismatch", metadata.rawText("version") != version},
		{"repository source mismatch", repository == nil || repository.attributes["type"] != "git" ||
			repository.attributes["url"] != sdkRepoURL},
		{"source commit mismatch", repository != nil && repository.attributes["type"] == "git" &&
			repository.attributes["url"] == sdkRepoURL && repository.attributes["commit"] != commit},
	} {
		if mismatch.failed {
			*failures = append(*failures, id+": "+mismatch.message)
		}
	}
	dependencies := metadata.child("dependencies")
	if len(expected) > 0 && dependencies == nil {
		*failures = append(*failures, id+": missing dependency range metadata")
		return names
	}
	containers := dependencies.all("group")
	if len(containers) == 0 {
		containers = []*xmlElement{dependencies}
	}
	for _, dependency := range sortedKeys(expected) {
		for _, container := range containers {
			matches := slices.DeleteFunc(container.all("dependency"), func(child *xmlElement) bool {
				return child.attributes["id"] != dependency
			})
			if len(matches) != 1 || matches[0].attributes["version"] != expected[dependency] {
				*failures = append(*failures, id+": "+dependency+" dependency range mismatch")
				break
			}
		}
	}
	return names
}

// archiveStems returns the lib/ member names with the extension, without it.
func archiveStems(names map[string]bool, extension string) map[string]bool {
	stems := map[string]bool{}
	for name := range names {
		if strings.HasPrefix(name, "lib/") && strings.HasSuffix(name, extension) {
			stems[strings.TrimSuffix(name, extension)] = true
		}
	}
	return stems
}

// validateSourceLink requires every portable symbol file to name the exact
// source repository and commit.
func validateSourceLink(path, id string, names []string, commit string, failures []string) []string {
	data, err := os.ReadFile(path)
	var entries []zipEntry
	if err == nil {
		entries, err = openZip(data)
	}
	for _, name := range names {
		var symbols []byte
		if err == nil {
			symbols, err = readZipFile(lastEntry(entries, name))
		}
		if err == nil && (!bytes.Contains(symbols, []byte(sourceLinkRoot)) || !bytes.Contains(symbols, []byte(commit))) {
			return append(failures, id+": portable symbols are missing exact Source Link")
		}
	}
	if err != nil {
		return append(failures, id+": invalid portable symbols")
	}
	return failures
}

// zipEntry is an archive member as Python's zipfile reads it: its name cut
// at the first NUL, its full directory name, its directory fields, and the
// offset its data must end before.
type zipEntry struct {
	name, directory              string
	archive                      []byte
	header, end                  int
	crc, compressed, size, attrs uint32
	flags, method                uint16
}

// openZip reads an archive's central directory the way Python's zipfile does.
// ZIP64 archives are not read.
func openZip(data []byte) ([]zipEntry, error) {
	signature := []byte("PK\x05\x06")
	end := len(data) - zipEndRecordBytes
	if end >= 0 && (!bytes.HasPrefix(data[end:], signature) || !bytes.HasSuffix(data, []byte{0, 0})) {
		search := max(0, end-1<<16)
		found := bytes.LastIndex(data[search:], signature)
		end = search + found
		if found < 0 || end > len(data)-zipEndRecordBytes {
			end = -1
		}
	}
	if end < 0 || end >= 20 && bytes.HasPrefix(data[end-20:], []byte("PK\x06\x07")) {
		return nil, errZipEntry
	}
	start := end - int(binary.LittleEndian.Uint32(data[end+12:]))
	concat := start - int(binary.LittleEndian.Uint32(data[end+16:]))
	if start < 0 {
		return nil, errZipEntry
	}
	entries := []zipEntry{}
	for directory := data[start:end]; len(directory) > 0; {
		if len(directory) < 46 || !bytes.HasPrefix(directory, []byte("PK\x01\x02")) || directory[6] > 63 {
			return nil, errZipEntry
		}
		field16 := func(at int) int { return int(binary.LittleEndian.Uint16(directory[at:])) }
		field32 := func(at int) uint32 { return binary.LittleEndian.Uint32(directory[at:]) }
		nameEnd := 46 + field16(28)
		record := directory[:min(len(directory), nameEnd+field16(30))]
		extra := record[min(len(record), nameEnd):]
		for len(extra) >= 4 && int(binary.LittleEndian.Uint16(extra[2:]))+4 <= len(extra) {
			extra = extra[4+binary.LittleEndian.Uint16(extra[2:]):]
		}
		name, err := zipName(record[46:min(len(record), nameEnd)], uint16(field16(8)))
		if err != nil || len(extra) >= 4 || slices.Contains([]uint32{field32(20), field32(24), field32(42)}, 0xffffffff) {
			return nil, errZipEntry
		}
		short, _, _ := strings.Cut(name, "\x00")
		entries = append(entries, zipEntry{short, name, data, int(field32(42)) + concat, 0, field32(16),
			field32(20), field32(24), field32(38), uint16(field16(8)), uint16(field16(10))})
		directory = directory[min(len(directory), len(record)+field16(32)):]
	}
	order := make([]int, len(entries))
	for index := range order {
		order[index] = index
	}
	slices.SortStableFunc(order, func(left, right int) int { return entries[left].header - entries[right].header })
	for _, index := range slices.Backward(order) {
		entries[index].end, start = start, entries[index].header
	}
	return entries, nil
}

// zipName decodes a member name from CP437, or from UTF-8 when the flag says so.
func zipName(raw []byte, flags uint16) (string, error) {
	if flags&0x800 == 0 {
		return charmap.CodePage437.NewDecoder().String(string(raw))
	}
	if !utf8.Valid(raw) {
		return "", errZipEntry
	}
	return string(raw), nil
}

// lastEntry returns the last member with the name, as Python's zipfile reads it.
func lastEntry(entries []zipEntry, name string) zipEntry {
	index := len(entries) - 1
	for entries[index].name != name {
		index--
	}
	return entries[index]
}

// readZipFile reads a member like Python's zipfile: its local header must name
// it, its data must not overlap the next member, it must not be encrypted,
// and its CRC must match the directory.
func readZipFile(entry zipEntry) ([]byte, error) {
	local := entry.archive[min(len(entry.archive), max(0, entry.header)):]
	if entry.header < 0 || len(local) < 30 || !bytes.HasPrefix(local, []byte("PK\x03\x04")) {
		return nil, errZipEntry
	}
	nameEnd := 30 + int(binary.LittleEndian.Uint16(local[26:]))
	name, err := zipName(local[30:min(len(local), nameEnd)], binary.LittleEndian.Uint16(local[6:]))
	start := min(len(entry.archive), entry.header+nameEnd+int(binary.LittleEndian.Uint16(local[28:])))
	if err != nil || name != entry.directory || entry.flags&0x61 != 0 ||
		entry.end != entry.header && start+int(entry.compressed) > entry.end {
		return nil, errZipEntry
	}
	compressed := entry.archive[start:min(len(entry.archive), start+int(entry.compressed))]
	readers := map[uint16]io.Reader{
		zip.Store: bytes.NewReader(compressed), zip.Deflate: flate.NewReader(bytes.NewReader(compressed)),
		12: bzip2.NewReader(bytes.NewReader(compressed)),
	}
	reader, supported := readers[entry.method]
	if !supported {
		return nil, zip.ErrAlgorithm
	}
	data, err := io.ReadAll(io.LimitReader(reader, int64(entry.size)))
	if err == nil && (crc32.ChecksumIEEE(data) != entry.crc ||
		len(compressed) < int(entry.compressed) && len(data) < int(entry.size)) {
		err = errZipEntry
	}
	return data, err
}

// packageContentSHA256 digests every member except the repository signature
// by name, size, and bytes, so signing does not change the digest. A bounded
// digest also applies the public package limits.
func packageContentSHA256(data []byte, bounded bool) (string, error) {
	var err error
	if bounded && !preflightPackage(data) {
		err = errPublicNuGet
	}
	var entries []zipEntry
	if err == nil {
		entries, err = openZip(data)
	}
	if err == nil && bounded {
		err = boundedEntries(entries)
	}
	entries = slices.DeleteFunc(entries, func(entry zipEntry) bool { return entry.name == packageSignature })
	slices.SortStableFunc(entries, func(left, right zipEntry) int { return strings.Compare(left.name, right.name) })
	digest := sha256.New()
	for index := 0; err == nil && index < len(entries); index++ {
		entry := entries[index]
		if index > 0 && entries[index-1].name == entry.name {
			err = errZipEntry
		}
		var member []byte
		if err == nil {
			member, err = readZipFile(entry)
		}
		if err == nil && bounded && len(member) != int(entry.size) {
			err = errPublicNuGet
		}
		digest.Write(binary.BigEndian.AppendUint64(nil, uint64(len(entry.name))))
		digest.Write([]byte(entry.name))
		digest.Write(binary.BigEndian.AppendUint64(nil, uint64(entry.size)))
		digest.Write(member)
	}
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func sha256Hex(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

// pyPath spells a path the way Python's pathlib does: empty and "."
// components drop, and an empty path is ".".
func pyPath(path string) string {
	parts := slices.DeleteFunc(strings.Split(path, "/"), func(part string) bool { return part == "" || part == "." })
	joined := strings.Join(parts, "/")
	if strings.HasPrefix(path, "/") {
		return "/" + joined
	}
	return cmpOr(joined, ".")
}
