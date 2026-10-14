package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"slices"
	"strings"
	"testing"
)

const (
	pythonFixtureRoot          = "logbrew_flask-0.1.5"
	pythonFixtureWheelMetadata = pythonFixtureRoot + ".dist-info/METADATA"
	pythonFixtureMetadata      = "Metadata-Version: 2.4\nName: logbrew-flask\nVersion: 0.1.5\n"
	pythonFixturePackage       = "logbrew-flask"
	pythonFixtureVersion       = "0.1.5"
	pythonFixtureMode          = 0o644
	pythonFixtureByteMask      = 0xff
	pythonFixtureShortHeader   = 100
)

func pythonFixtureFile(name, body string) pythonArchiveEntry {
	return pythonArchiveEntry{name: name, data: []byte(body), mode: pythonFixtureMode, directory: false}
}

func pythonFixtureArchive(tb testing.TB, kind string, entries []pythonArchiveEntry) []byte {
	tb.Helper()
	if kind == pythonWheel {
		return pythonFixtureZip(tb, entries)
	}
	var output bytes.Buffer
	writer := tar.NewWriter(&output)
	for _, entry := range entries {
		header := new(tar.Header)
		header.Name, header.Mode, header.Size = entry.name, int64(entry.mode), int64(len(entry.data))
		header.Typeflag, header.Format = tar.TypeReg, tar.FormatPAX
		if entry.directory {
			header.Typeflag = tar.TypeDir
		}
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
	return pythonFixtureGzip(tb, output.Bytes())
}

func pythonFixtureZip(tb testing.TB, entries []pythonArchiveEntry, extra ...byte) []byte {
	tb.Helper()
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	for _, entry := range entries {
		header := new(zip.FileHeader)
		header.Name, header.Method = entry.name, zip.Deflate
		header.Extra = extra
		header.ExternalAttrs = (uint32(pythonUnixRegular) | entry.mode) << pythonZipModeShift
		if entry.directory {
			header.ExternalAttrs = (uint32(pythonUnixDirectory) | entry.mode) << pythonZipModeShift
		}
		member, err := writer.CreateHeader(header)
		if err != nil {
			tb.Fatal(err)
		}
		if _, err = member.Write(entry.data); err != nil {
			tb.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		tb.Fatal(err)
	}
	return output.Bytes()
}

func pythonFixtureGzip(tb testing.TB, raw []byte) []byte {
	tb.Helper()
	var output bytes.Buffer
	writer, err := gzip.NewWriterLevel(&output, gzip.BestSpeed)
	if err != nil {
		tb.Fatal(err)
	}
	if _, err = writer.Write(raw); err != nil {
		tb.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		tb.Fatal(err)
	}
	return output.Bytes()
}

func TestPythonArchiveContentIdentity(t *testing.T) {
	t.Parallel()
	files := []pythonArchiveEntry{pythonFixtureFile("b", "yz"), pythonFixtureFile("a", "x")}
	framed, err := hex.DecodeString("0000000000000001610000000000000001780000000000000001620000000000000002797a")
	if err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("%x", sha256.Sum256(framed))
	for _, kind := range []string{pythonWheel, pythonSdist} {
		for range 2 {
			data := pythonFixtureArchive(t, kind, files)
			entries, valid := readPythonArchive(data, kind)
			if !valid || pythonArchiveDigest(entries) != want {
				t.Fatalf("%s content identity mismatch", kind)
			}
			slices.Reverse(files)
		}
	}
	files[0].data = []byte("changed")
	if pythonArchiveDigest(files) == want {
		t.Fatal("changed package content retained its digest")
	}
}

func TestPythonArchiveRejectsUnsafeNames(t *testing.T) {
	t.Parallel()
	for _, name := range []string{"../outside", "/outside", "a/../b", "a\\b", "a/./b", "a//b", "."} {
		for _, kind := range []string{pythonWheel, pythonSdist} {
			data := pythonFixtureArchive(t, kind, []pythonArchiveEntry{pythonFixtureFile(name, "x")})
			if _, valid := readPythonArchive(data, kind); valid {
				t.Errorf("%s accepted unsafe path %q", kind, name)
			}
		}
	}
	for _, name := range []string{"", "a\x00b", string([]byte{0xff}), "a\nb"} {
		if safePythonArchiveName(name) {
			t.Errorf("accepted malformed name %q", name)
		}
	}
}

func TestPythonArchiveRejectsDuplicateAndExcessEntries(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{pythonWheel, pythonSdist} {
		entry := pythonFixtureFile("a", "x")
		data := pythonFixtureArchive(t, kind, []pythonArchiveEntry{entry, entry})
		if _, valid := readPythonArchive(data, kind); valid {
			t.Errorf("%s accepted duplicate names", kind)
		}
		entries := make([]pythonArchiveEntry, pythonArchiveMemberLimit+1)
		for index := range entries {
			entries[index] = pythonFixtureFile(fmt.Sprintf("files/%d", index), "")
		}
		if _, valid := readPythonArchive(pythonFixtureArchive(t, kind, entries), kind); valid {
			t.Errorf("%s accepted excessive entries", kind)
		}
	}
}

func TestPythonZipPreflight(t *testing.T) {
	t.Parallel()
	data := pythonFixtureArchive(t, pythonWheel, []pythonArchiveEntry{pythonFixtureFile("a", "x")})
	end := len(data) - pythonZipEndSize
	const (
		directoryDiskOffset     = 6
		directorySizeOffset     = 12
		directoryLocationOffset = 16
		commentLengthOffset     = 20
	)
	for _, offset := range []int{
		4, directoryDiskOffset, 8, 10,
		directorySizeOffset, directoryLocationOffset, commentLengthOffset,
	} {
		mutated := bytes.Clone(data)
		mutated[end+offset] ^= pythonFixtureByteMask
		if _, valid := readPythonArchive(mutated, pythonWheel); valid {
			t.Errorf("accepted invalid ZIP end field at %d", offset)
		}
	}
	for _, body := range [][]byte{nil, data[:end], append(bytes.Clone(data), 'x')} {
		if _, valid := readPythonArchive(body, pythonWheel); valid {
			t.Error("accepted missing end or trailing ZIP data")
		}
	}
	commented := bytes.Clone(data)
	binary.LittleEndian.PutUint16(commented[len(commented)-2:], 1)
	commented = append(commented, 'x')
	entries, valid := readPythonArchive(commented, pythonWheel)
	if !valid || pythonArchiveDigest(entries) == "" {
		t.Fatal("valid ZIP comment rejected")
	}
}

func TestPythonTarRawPreflight(t *testing.T) {
	t.Parallel()
	data := pythonFixtureArchive(t, pythonSdist, []pythonArchiveEntry{pythonFixtureFile("a", "x")})
	reader, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := io.ReadAll(reader)
	closeError := reader.Close()
	if err != nil || closeError != nil {
		t.Fatal("fixture decompression failed")
	}
	for _, mutation := range []struct {
		name string
		body []byte
	}{
		{"truncated header", raw[:pythonFixtureShortHeader]},
		{"truncated body", raw[:pythonTarBlockSize]},
		{"one zero block", raw[:len(raw)-pythonTarBlockSize]},
		{"trailing payload", append(bytes.Clone(raw), 'x')},
	} {
		if _, valid := readPythonArchive(pythonFixtureGzip(t, mutation.body), pythonSdist); valid {
			t.Errorf("accepted %s", mutation.name)
		}
	}
	for _, field := range []string{"-0000000001\x00", "00000000009\x00", "           \x00", "\x8000000000000"} {
		mutated := bytes.Clone(raw)
		copy(mutated[124:136], field)
		if validPythonTarStream(mutated) {
			t.Errorf("accepted invalid size %q", field)
		}
	}
	corrupt := bytes.Clone(data)
	corrupt[len(corrupt)-1] ^= 1
	if _, valid := readPythonArchive(corrupt, pythonSdist); valid {
		t.Error("accepted invalid gzip checksum/size")
	}
}

func TestPythonArchiveMetadataIdentity(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{pythonWheel, pythonSdist} {
		name := pythonFixtureWheelMetadata
		if kind == pythonSdist {
			name = pythonFixtureRoot + "/PKG-INFO"
		}
		for _, body := range []string{
			pythonFixtureMetadata,
			strings.ReplaceAll(pythonFixtureMetadata, "\n", "\r\n") + "\r\nDescription",
		} {
			entries := []pythonArchiveEntry{pythonFixtureFile(name, body)}
			if !pythonArchiveIdentity(entries, kind, pythonFixtureRoot, pythonFixturePackage, pythonFixtureVersion) {
				t.Errorf("%s rejected matching metadata", kind)
			}
		}
		for _, body := range []string{
			strings.Replace(pythonFixtureMetadata, pythonFixtureVersion, "0.1.6", 1),
			strings.Replace(pythonFixtureMetadata, pythonFixturePackage, "logbrew-sdk", 1),
			pythonFixtureMetadata + "Name: logbrew-flask\n",
			pythonFixtureMetadata + "Version: 0.1.5\n",
			pythonFixtureMetadata + string([]byte{0xff}),
			strings.Repeat("x", pythonMetadataLimit+1),
		} {
			if pythonArchiveIdentity([]pythonArchiveEntry{pythonFixtureFile(name, body)},
				kind, pythonFixtureRoot, pythonFixturePackage, pythonFixtureVersion) {
				t.Errorf("%s accepted malformed or mismatched metadata", kind)
			}
		}
		if pythonArchiveIdentity(nil, kind, pythonFixtureRoot, pythonFixturePackage, pythonFixtureVersion) {
			t.Errorf("%s accepted missing metadata", kind)
		}
	}
}

func TestPythonArchiveLongNamesAndDirectories(t *testing.T) {
	t.Parallel()
	const longNameLength = 200
	directory := pythonArchiveEntry{name: "pkg/", data: nil, mode: pythonFixtureMode, directory: true}
	file := pythonFixtureFile("pkg/"+strings.Repeat("x", longNameLength), "body")
	for _, kind := range []string{pythonWheel, pythonSdist} {
		data := pythonFixtureArchive(t, kind, []pythonArchiveEntry{directory, file})
		entries, valid := readPythonArchive(data, kind)
		expectedDigest := pythonArchiveDigest([]pythonArchiveEntry{file})
		if !valid || len(entries) != 2 || pythonArchiveDigest(entries) != expectedDigest {
			t.Errorf("%s did not preserve directories and extended file names", kind)
		}
	}
}

func FuzzPythonArchive(f *testing.F) {
	for _, kind := range []string{pythonWheel, pythonSdist} {
		f.Add(pythonFixtureArchive(f, kind, []pythonArchiveEntry{pythonFixtureFile("pkg/entry", "body")}))
	}
	for _, kind := range []byte{tar.TypeXGlobalHeader, tar.TypeXHeader} {
		f.Add(pythonTarSequence(f,
			pythonTarFixtureRecord(f, kind, "extension", "", map[string]string{pythonPAXPath: "pkg/entry"}),
			pythonTarFixtureRecord(f, tar.TypeReg, pythonTarEntry, "body", nil),
		))
	}
	f.Add([]byte(pythonZipEndSignature))
	f.Add(make([]byte, pythonTarBlockSize*pythonTarEndBlocks))
	f.Add([]byte("not an archive"))
	f.Fuzz(func(t *testing.T, data []byte) {
		for _, kind := range []string{pythonWheel, pythonSdist} {
			entries, valid := readPythonArchive(data, kind)
			if valid && (len(entries) > pythonArchiveMemberLimit || pythonArchiveDigest(entries) == "") {
				t.Fatal("accepted archive violated its bounded identity contract")
			}
		}
	})
}
