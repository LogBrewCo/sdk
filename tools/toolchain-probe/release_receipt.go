package main

import (
	"bytes"
	"compress/bzip2"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
)

const receiptUsage = "usage: release-artifacts receipt ids|bind|attest|extract --family FAMILY [--output-dir DIR] " +
	"[--metadata FILE] [--index N]\n"

var (
	receiptMaxArtifact  int64 = 128 << 20
	receiptMaxExtracted int64 = 512 << 20
	receiptMaxEntries         = 20_000
	errReceipt                = errors.New("release artifact binding failed")
	// Each family's artifact IDs and bound file names, in receipt order.
	receiptFamilies = map[string][][2]string{
		"crates":     {{"crates:logbrew", "0.crate"}},
		"go":         {{"go:github.com/LogBrewCo/sdk/go/logbrew", "0.zip"}},
		"maven":      {{"maven:co.logbrew:logbrew-sdk", "0.jar"}},
		"npm-nestjs": {{"npm:@logbrew/nestjs", "0.tgz"}},
		"nuget":      {{"nuget:LogBrew", "0.nupkg"}, {"nuget:LogBrew.HttpClient", "1.nupkg"}},
		"packagist":  {{"packagist:logbrew/sdk", "0.zip"}},
		"pypi": {{"pypi:logbrew-sdk", "0.whl"}, {"pypi:logbrew-fastapi", "1.whl"}, {"pypi:logbrew-flask", "2.whl"},
			{"pypi:logbrew-django", "3.whl"}},
		"rubygems": {{"rubygems:logbrew-sdk", "0.gem"}},
		"swiftpm":  {{"swiftpm:LogBrewCo/sdk", "0.archive"}},
	}
	// Each command's flags.
	receiptFlags = map[string][]string{"ids": {"family"}, "bind": {"family", "output-dir", "metadata"},
		"attest": {"family", "metadata"}, "extract": {"family", "metadata", "index", "output-dir"}}
)

// receiptEntry is one bound artifact in receipt metadata.
type receiptEntry struct {
	ID     string `json:"id"`
	Digest string `json:"digest"`
	File   string `json:"file,omitempty"`
}

// checkReceipt binds the exact release artifacts a receipt smoke installs,
// attests their digests, or extracts one of them.
func checkReceipt(arguments []string, output, diagnostic io.Writer) int {
	flags := flag.NewFlagSet("receipt", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	values := map[string]*string{}
	for _, name := range receiptFlags["extract"] {
		values[name] = flags.String(name, "", "")
	}
	command := ""
	if len(arguments) > 0 {
		command, arguments = arguments[0], arguments[1:]
	}
	err := flags.Parse(arguments)
	set := map[string]bool{}
	flags.Visit(func(used *flag.Flag) { set[used.Name] = true })
	index, parsed := pyInt(*values["index"], 10, false)
	valid := err == nil && flags.NArg() == 0 && receiptFlags[command] != nil && receiptFamilies[*values["family"]] != nil &&
		(parsed || command != "extract")
	for name := range values {
		valid = valid && set[name] == slices.Contains(receiptFlags[command], name)
	}
	if errors.Is(err, flag.ErrHelp) || command == "-h" || command == "--help" {
		return writeText(output, receiptUsage, exitOK)
	}
	if !valid {
		return writeText(diagnostic, receiptUsage, exitUsage)
	}
	family := *values["family"]
	switch command {
	case "ids":
		for _, artifact := range receiptFamilies[family] {
			_, _ = io.WriteString(output, artifact[0]+"\n")
		}
		return exitOK
	case "bind":
		err = bindReceipt(family, *values["output-dir"], *values["metadata"])
	case "attest":
		var entries []receiptEntry
		if entries, err = receiptMetadata(family, *values["metadata"]); err == nil {
			for position := range entries {
				entries[position].File = ""
			}
			text, _ := pyJSONText(struct {
				SchemaVersion int            `json:"schema_version"`
				Status        string         `json:"status"`
				Artifacts     []receiptEntry `json:"artifacts"`
			}{1, "passed", entries}, "")
			return writeText(output, text, exitOK)
		}
	default:
		err = extractReceipt(family, *values["metadata"], index, *values["output-dir"])
	}
	if err != nil {
		return writeText(diagnostic, errReceipt.Error()+"\n", exitFailure)
	}
	return exitOK
}

// bindReceipt copies each supplied artifact into a new directory and writes
// their digests.
func bindReceipt(family, directory, metadata string) error {
	artifacts := receiptFamilies[family]
	supplied, valid := receiptSupplied(artifacts)
	if !valid || os.Mkdir(directory, 0o700) != nil {
		return errReceipt
	}
	if !strings.HasPrefix(directory, "/") {
		working, _ := syscall.Getwd()
		directory = strings.TrimSuffix(working, "/") + "/" + directory
	}
	bound := []receiptEntry{}
	for _, artifact := range artifacts {
		destination := pyPurePath(directory + "/" + artifact[1])
		digest, err := copyReceiptArtifact(pyPurePath(supplied[artifact[0]]), destination)
		if err != nil {
			return err
		}
		bound = append(bound, receiptEntry{artifact[0], digest, destination})
	}
	return writePlanJSON(metadata, struct {
		SchemaVersion int            `json:"schema_version"`
		Family        string         `json:"family"`
		Artifacts     []receiptEntry `json:"artifacts"`
	}{1, family, bound}, "")
}

// receiptSupplied reads the artifact paths, which must name exactly the
// family's artifacts in order.
func receiptSupplied(artifacts [][2]string) (map[string]string, bool) {
	data := []byte(os.Getenv("LOGBREW_RELEASE_ARTIFACT_FILES_JSON"))
	decoder := json.NewDecoder(bytes.NewReader(data))
	value, err := decodePlanJSON(data)
	object, _ := value.(map[string]any)
	if token, _ := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil, false
	}
	// Keys keep their first position, as in a Python dict.
	keys, supplied := []string{}, map[string]string{}
	for decoder.More() {
		key, _ := decoder.Token()
		var ignored any
		_ = decoder.Decode(&ignored)
		if !slices.Contains(keys, key.(string)) {
			keys = append(keys, key.(string))
		}
	}
	valid := len(keys) == len(artifacts)
	for position, artifact := range artifacts {
		path, isString := object[artifact[0]].(string)
		supplied[artifact[0]], valid = path, valid && isString && keys[position] == artifact[0]
	}
	return supplied, valid
}

// copyReceiptArtifact copies one regular file that stays the same file while
// it is opened, returning its digest.
func copyReceiptArtifact(source, destination string) (string, error) {
	info, err := os.Lstat(source)
	if err != nil || !strings.HasPrefix(source, "/") || !info.Mode().IsRegular() {
		return "", errReceipt
	}
	input, err := os.Open(source)
	if err != nil {
		return "", errReceipt
	}
	defer input.Close()
	opened, err := input.Stat()
	if err != nil || !opened.Mode().IsRegular() || !os.SameFile(info, opened) || opened.Size() <= 0 ||
		opened.Size() > receiptMaxArtifact {
		return "", errReceipt
	}
	target, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	digest, copied := sha256.New(), int64(-1)
	if err == nil {
		copied, err = io.Copy(io.MultiWriter(target, digest), io.LimitReader(input, receiptMaxArtifact+1))
		err = errors.Join(err, target.Sync(), target.Close())
	}
	if err != nil || copied != opened.Size() {
		return "", errReceipt
	}
	return "sha256:" + hex.EncodeToString(digest.Sum(nil)), nil
}

// receiptMetadata reads bound metadata and checks every file still has its
// digest.
func receiptMetadata(family, path string) ([]receiptEntry, error) {
	artifacts := receiptFamilies[family]
	data, err := os.ReadFile(path)
	var value any
	if err == nil {
		value, err = decodePlanJSON(data)
	}
	payload, _ := value.(map[string]any)
	entries, _ := payload["artifacts"].([]any)
	if err != nil || !receiptKeys(payload, "schema_version", "family", "artifacts") ||
		!pyEqual(payload["schema_version"], json.Number("1")) || payload["family"] != family ||
		len(entries) != len(artifacts) {
		return nil, errReceipt
	}
	validated := []receiptEntry{}
	for position, value := range entries {
		entry, _ := value.(map[string]any)
		digest, _ := entry["digest"].(string)
		file, _ := entry["file"].(string)
		file = pyPurePath(file)
		if !receiptKeys(entry, "id", "digest", "file") || entry["id"] != artifacts[position][0] ||
			!strings.HasPrefix(file, "/") || digest == "" || receiptDigest(file) != digest {
			return nil, errReceipt
		}
		validated = append(validated, receiptEntry{artifacts[position][0], digest, file})
	}
	return validated, nil
}

func receiptKeys(object map[string]any, keys ...string) bool {
	for _, key := range keys {
		if _, found := object[key]; !found {
			return false
		}
	}
	return len(object) == len(keys)
}

// receiptDigest returns the digest of a regular file within the size limit,
// or "" when it is not one.
func receiptDigest(path string) string {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > receiptMaxArtifact {
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// extractReceipt extracts one bound archive, a ZIP archive or a tar archive
// that may be gzip or bzip2 compressed, into a new directory.
func extractReceipt(family, metadata string, index int64, directory string) error {
	entries, err := receiptMetadata(family, metadata)
	valid := err == nil && index >= 0 && index < int64(len(entries))
	var data []byte
	if valid {
		data, err = os.ReadFile(entries[index].File)
	}
	if !valid || err != nil || os.Mkdir(directory, 0o700) != nil {
		return errReceipt
	}
	if members, err := openZip(data); err == nil {
		return extractReceiptZip(members, directory)
	}
	// A tar stream holds the extracted bytes plus headers and padding.
	limit, stream := receiptMaxExtracted+int64(receiptMaxEntries+2)*4*tarBlock, data
	switch {
	case bytes.HasPrefix(data, []byte{0x1f, 0x8b}):
		stream, err = gunzip(data, int(limit))
	case bytes.HasPrefix(data, []byte("BZh")):
		stream, err = io.ReadAll(io.LimitReader(bzip2.NewReader(bytes.NewReader(data)), limit+1))
		if int64(len(stream)) > limit {
			err = errReceipt
		}
	}
	reader := &tarReader{stream: stream, global: map[string]string{}}
	members := []tarMember{}
	for err == nil {
		var member *tarMember
		if member, err = reader.next(); member == nil {
			break
		}
		members = append(members, *member)
	}
	if err != nil || len(members) == 0 || len(members) > receiptMaxEntries {
		return errReceipt
	}
	total := int64(0)
	for _, member := range members {
		path, valid := receiptMemberPath(directory, member.name)
		if member.kind == '5' && valid {
			if os.MkdirAll(path, 0o700) != nil {
				return errReceipt
			}
			continue
		}
		total += member.size
		data, err := member.contents(stream)
		if !valid || !member.regular() || total > receiptMaxExtracted || err != nil ||
			writeReceiptMember(path, data, member.size) != nil {
			return errReceipt
		}
	}
	return nil
}

func extractReceiptZip(members []zipEntry, directory string) error {
	if len(members) == 0 || len(members) > receiptMaxEntries {
		return errReceipt
	}
	total := int64(0)
	for _, member := range members {
		path, valid := receiptMemberPath(directory, member.name)
		if mode := member.attrs >> 16; !valid || mode&syscall.S_IFMT == syscall.S_IFLNK {
			return errReceipt
		}
		if strings.HasSuffix(member.name, "/") {
			if os.MkdirAll(path, 0o700) != nil {
				return errReceipt
			}
			continue
		}
		if total += int64(member.size); total > receiptMaxExtracted {
			return errReceipt
		}
		data, err := readZipFile(member)
		if err != nil || writeReceiptMember(path, data, int64(member.size)) != nil {
			return errReceipt
		}
	}
	return nil
}

// receiptMemberPath places an archive member name under directory, rejecting
// empty, absolute, backslash, and parent names.
func receiptMemberPath(directory, name string) (string, bool) {
	parts := slices.DeleteFunc(strings.Split(name, "/"), func(part string) bool { return part == "" || part == "." })
	return strings.Join(append([]string{directory}, parts...), "/"), name != "" && !strings.HasPrefix(name, "/") &&
		!strings.Contains(name, `\`) && !slices.Contains(parts, "..")
}

// writeReceiptMember creates one extracted file that must not exist yet.
func writeReceiptMember(path string, data []byte, size int64) error {
	if int64(len(data)) != size || os.MkdirAll(filepath.Dir(path), 0o700) != nil {
		return errReceipt
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return errReceipt
	}
	_, err = file.Write(data)
	return errors.Join(err, file.Close())
}
