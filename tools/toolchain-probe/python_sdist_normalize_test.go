package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"testing"
	"time"
)

const (
	pythonReleaseEpoch         = 1700000000
	pythonFixtureOwner         = 501
	pythonFixtureGroup         = 20
	pythonFixtureExecutable    = 0o4755
	pythonNormalizedExecutable = 0o755
	pythonFixtureSdistPath     = "/package.tar.gz"
)

func pythonSdistFiles() []pythonArchiveEntry {
	return []pythonArchiveEntry{
		{name: "pkg/", data: nil, mode: pythonFixtureMode, directory: true},
		pythonFixtureFile("pkg/PKG-INFO", "metadata"),
		pythonFixtureFile("pkg/src/main.py", "code"),
	}
}

func pythonSdistVariant(tb testing.TB, epoch int64, entries []pythonArchiveEntry) []byte {
	tb.Helper()
	var raw bytes.Buffer
	writer := tar.NewWriter(&raw)
	for _, entry := range entries {
		header := new(tar.Header)
		header.Name, header.Size = entry.name, int64(len(entry.data))
		header.Mode, header.Typeflag, header.Format = pythonFixtureExecutable, tar.TypeReg, tar.FormatPAX
		if entry.directory {
			header.Typeflag = tar.TypeDir
		}
		header.Uid, header.Gid, header.Uname, header.Gname = pythonFixtureOwner, pythonFixtureGroup, "builder", "staff"
		header.ModTime, header.AccessTime = time.Unix(epoch, 0), time.Unix(epoch, 0)
		if err := writer.WriteHeader(header); err != nil {
			tb.Fatal(err)
		}
		if _, err := writer.Write(entry.data); err != nil {
			tb.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		tb.Fatal(err)
	}
	return pythonFixtureGzip(tb, raw.Bytes())
}

func TestPythonSdistNormalizationIsReproducible(t *testing.T) {
	t.Parallel()
	entries := pythonSdistFiles()
	first := pythonSdistVariant(t, pythonReleaseEpoch+1, entries)
	slices.Reverse(entries)
	second := pythonSdistVariant(t, pythonReleaseEpoch+2, entries)
	if bytes.Equal(first, second) {
		t.Fatal("normalization fixtures did not vary")
	}
	normalized, valid := normalizePythonSdist(first, pythonReleaseEpoch)
	repeated, secondValid := normalizePythonSdist(second, pythonReleaseEpoch)
	if !valid || !secondValid || !bytes.Equal(normalized, repeated) {
		t.Fatal("equivalent source packages did not normalize to the same bytes")
	}
	repeated, valid = normalizePythonSdist(normalized, pythonReleaseEpoch)
	if !valid || !bytes.Equal(normalized, repeated) {
		t.Fatal("normalization is not idempotent")
	}
	before, beforeValid := readPythonArchive(first, pythonSdist)
	after, afterValid := readPythonArchive(normalized, pythonSdist)
	if !beforeValid || !afterValid || pythonArchiveDigest(before) != pythonArchiveDigest(after) {
		t.Fatal("normalization changed package content")
	}
	assertPythonNormalizedHeaders(t, normalized)
}

func assertPythonNormalizedHeaders(t *testing.T, data []byte) {
	t.Helper()
	reader, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := reader.Close(); err != nil {
			t.Error(err)
		}
	})
	if reader.ModTime.Unix() != pythonReleaseEpoch ||
		reader.Name != "" || reader.Comment != "" || len(reader.Extra) != 0 {
		t.Fatal("gzip retained variable metadata")
	}
	archive := tar.NewReader(reader)
	var names []string
	for {
		header, nextError := archive.Next()
		if errors.Is(nextError, io.EOF) {
			break
		}
		if nextError != nil {
			t.Fatal(nextError)
		}
		names = append(names, header.Name)
		assertPythonNormalizedHeader(t, header)
	}
	if len(names) != len(pythonSdistFiles()) || !slices.IsSorted(names) {
		t.Fatal("normalized file order is not canonical")
	}
}

func assertPythonNormalizedHeader(t *testing.T, header *tar.Header) {
	t.Helper()
	if header.ModTime.Unix() != pythonReleaseEpoch || header.Uid != 0 || header.Gid != 0 ||
		header.Uname != "" || header.Gname != "" || header.Mode != pythonNormalizedExecutable ||
		!header.AccessTime.IsZero() || !header.ChangeTime.IsZero() {
		t.Fatal("tar retained variable metadata or changed executable permissions")
	}
}

func TestPythonSdistNormalizationRejectsInvalidInputs(t *testing.T) {
	t.Parallel()
	data := pythonSdistVariant(t, pythonReleaseEpoch, pythonSdistFiles())
	for _, epoch := range []int64{-1, pythonMaximumEpoch + 1} {
		if _, valid := normalizePythonSdist(data, epoch); valid {
			t.Error("accepted an out-of-range source epoch")
		}
	}
	for _, epoch := range []int64{0, pythonMaximumEpoch} {
		if _, valid := normalizePythonSdist(data, epoch); !valid {
			t.Error("rejected a valid source epoch boundary")
		}
	}
	for _, invalid := range [][]byte{nil, []byte("sensitive-marker"), data[:len(data)-1]} {
		if _, valid := normalizePythonSdist(invalid, pythonReleaseEpoch); valid {
			t.Error("accepted invalid source archive")
		}
	}
}

func TestPythonSdistNormalizationFileReplacement(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	filename := filepath.Join(directory, "package.tar.gz")
	data := pythonSdistVariant(t, pythonReleaseEpoch, pythonSdistFiles())
	if err := os.WriteFile(filename, data, fixtureReceiptMode); err != nil {
		t.Fatal(err)
	}
	var output, diagnostic bytes.Buffer
	arguments := []string{pythonNormalizeMode, filename, strconv.Itoa(pythonReleaseEpoch)}
	if code := runPythonArchive(arguments, &output, &diagnostic); code != exitOK || diagnostic.Len() != 0 {
		t.Fatal("source package normalization failed")
	}
	if output.String() != "{\"scope\":\"python_sdist_normalized\",\"valid\":true}\n" {
		t.Fatal("missing normalization receipt")
	}
	expected, valid := normalizePythonSdist(data, pythonReleaseEpoch)
	actual, readable := readCheckFile(filename)
	if !readable || !valid || !bytes.Equal(expected, actual) {
		t.Fatal("replacement file does not contain verified normalized bytes")
	}
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 1 {
		t.Fatal("normalization leaked a temporary file")
	}
	info, err := os.Lstat(filename)
	if err != nil || info.Mode().Perm() != pythonNormalizedFileMode {
		t.Fatal("normalized package permissions are not canonical")
	}
	if normalizePythonSdistFile(filename, -1) {
		t.Fatal("invalid normalization request succeeded")
	}
	unchanged, readable := readCheckFile(filename)
	if !readable || !bytes.Equal(actual, unchanged) {
		t.Fatal("failed normalization changed the original package")
	}
}

func TestPythonSdistNormalizationRejectsLinksAndNonfiles(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	filename := filepath.Join(directory, "package.tar.gz")
	data := pythonSdistVariant(t, pythonReleaseEpoch, pythonSdistFiles())
	if err := os.WriteFile(filename, data, fixtureReceiptMode); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(directory, "linked.tar.gz")
	if err := os.Symlink(filename, link); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{link, directory, filepath.Join(directory, "missing.tar.gz")} {
		if normalizePythonSdistFile(target, pythonReleaseEpoch) {
			t.Fatal("normalization accepted a symlink or nonfile")
		}
	}
	actual, readable := readCheckFile(filename)
	if !readable || !bytes.Equal(actual, data) {
		t.Fatal("rejected normalization changed the target")
	}
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 2 {
		t.Fatal("rejected normalization leaked files")
	}
}

func TestPythonSdistNormalizationRootCannotEscape(t *testing.T) {
	t.Parallel()
	const directoryMode = 0o700
	parent := t.TempDir()
	directory := filepath.Join(parent, "scope")
	if err := os.Mkdir(directory, directoryMode); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(parent, "outside.tar.gz")
	data := pythonSdistVariant(t, pythonReleaseEpoch, pythonSdistFiles())
	if err := os.WriteFile(outside, data, fixtureReceiptMode); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := root.Close(); err != nil {
			t.Error(err)
		}
	})
	for _, name := range []string{"../outside.tar.gz", outside} {
		if normalizePythonSdistAtRoot(root, name, pythonReleaseEpoch) {
			t.Fatal("normalization escaped its opened directory")
		}
	}
	actual, readable := readCheckFile(outside)
	if !readable || !bytes.Equal(actual, data) {
		t.Fatal("scoped normalization changed an existing outside package")
	}
}

func TestPythonSdistNormalizationCommandRejectsBadSelection(t *testing.T) {
	t.Parallel()
	for _, arguments := range [][]string{
		{pythonNormalizeMode},
		{pythonNormalizeMode, "relative.tar.gz", "0"},
		{pythonNormalizeMode, pythonFixtureSdistPath, "invalid"},
		{pythonNormalizeMode, pythonFixtureSdistPath, "-1"},
		{pythonNormalizeMode, pythonFixtureSdistPath, "4294967296"},
	} {
		var output, diagnostic bytes.Buffer
		if code := runPythonArchive(arguments, &output, &diagnostic); code != exitUsage || output.Len() != 0 {
			t.Fatal("invalid normalization selection was not rejected before writing")
		}
	}
}
