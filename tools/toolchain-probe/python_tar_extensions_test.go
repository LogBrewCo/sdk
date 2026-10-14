package main

import (
	"archive/tar"
	"bytes"
	"fmt"
	"testing"
)

const (
	pythonTarChecksumOffset = 148
	pythonTarFirst          = "first"
	pythonTarSecond         = "second"
	pythonTarGlobal         = "global"
	pythonTarEntry          = "entry"
)

func pythonTarFixtureRecord(tb testing.TB, kind byte, name, body string, records map[string]string) []byte {
	tb.Helper()
	var output bytes.Buffer
	writer := tar.NewWriter(&output)
	header := new(tar.Header)
	header.Name, header.Typeflag, header.Mode = name, kind, pythonFixtureMode
	header.Size, header.PAXRecords = int64(len(body)), records
	if kind == tar.TypeXHeader {
		header.Typeflag = tar.TypeXGlobalHeader
	}
	if header.Typeflag == tar.TypeXGlobalHeader {
		header.Mode = 0
	}
	if err := writer.WriteHeader(header); err != nil {
		tb.Fatal(err)
	}
	if _, err := writer.Write([]byte(body)); err != nil {
		tb.Fatal(err)
	}
	if err := writer.Flush(); err != nil {
		tb.Fatal(err)
	}
	result := output.Bytes()
	if kind == tar.TypeXHeader {
		result[pythonTarTypeOffset] = kind
		pythonTarFixtureChecksum(result)
	}
	return result
}

func pythonTarFixtureChecksum(raw []byte) {
	copy(raw[pythonTarChecksumOffset:pythonTarTypeOffset], "        ")
	var sum int
	for _, value := range raw[:pythonTarBlockSize] {
		sum += int(value)
	}
	copy(raw[pythonTarChecksumOffset:pythonTarTypeOffset], fmt.Sprintf("%06o\x00 ", sum))
}

func pythonTarSequence(tb testing.TB, records ...[]byte) []byte {
	tb.Helper()
	data := bytes.Join(records, nil)
	data = append(data, make([]byte, pythonTarEndBlocks*pythonTarBlockSize)...)
	return pythonFixtureGzip(tb, data)
}

func TestPythonTarGlobalPAXScope(t *testing.T) {
	t.Parallel()
	data := pythonTarSequence(t,
		pythonTarFixtureRecord(t, tar.TypeXGlobalHeader, pythonTarGlobal, "",
			map[string]string{pythonPAXPath: "pkg/global"}),
		pythonTarFixtureRecord(t, tar.TypeReg, pythonTarFirst, "a", nil),
		pythonTarFixtureRecord(t, tar.TypeXHeader, "local", "", map[string]string{pythonPAXPath: "pkg/local"}),
		pythonTarFixtureRecord(t, tar.TypeReg, pythonTarSecond, "b", nil),
		pythonTarFixtureRecord(t, tar.TypeXGlobalHeader, pythonTarGlobal, "",
			map[string]string{pythonPAXPath: "pkg/changed"}),
		pythonTarFixtureRecord(t, tar.TypeReg, "third", "c", nil),
		pythonTarFixtureRecord(t, tar.TypeXGlobalHeader, pythonTarGlobal, "",
			map[string]string{pythonPAXPath: "fourth"}),
		pythonTarFixtureRecord(t, tar.TypeReg, "fourth", "d", nil),
	)
	want := []pythonArchiveEntry{
		pythonFixtureFile("pkg/global", "a"), pythonFixtureFile("pkg/local", "b"),
		pythonFixtureFile("pkg/changed", "c"), pythonFixtureFile("fourth", "d"),
	}
	entries, valid := readPythonArchive(data, pythonSdist)
	if !valid || len(entries) != len(want) || pythonArchiveDigest(entries) != pythonArchiveDigest(want) {
		t.Fatal("global/local PAX inheritance changed package contents")
	}
	normalized, valid := normalizePythonSdist(data, 0)
	if !valid {
		t.Fatal("normalization rejected supported PAX inheritance")
	}
	entries, valid = readPythonArchive(normalized, pythonSdist)
	if !valid || pythonArchiveDigest(entries) != pythonArchiveDigest(want) {
		t.Fatal("normalization changed inherited package contents")
	}
}

func TestPythonTarGlobalPAXSize(t *testing.T) {
	t.Parallel()
	data := pythonTarSequence(t,
		pythonTarFixtureRecord(t, tar.TypeXGlobalHeader, pythonTarGlobal, "", map[string]string{pythonPAXSize: "2"}),
		pythonTarFixtureRecord(t, tar.TypeReg, pythonTarFirst, "abc", nil),
		pythonTarFixtureRecord(t, tar.TypeXHeader, "local", "",
			map[string]string{pythonPAXPath: pythonTarSecond, pythonPAXSize: "1"}),
		pythonTarFixtureRecord(t, tar.TypeReg, pythonTarSecond, "x", nil),
		pythonTarFixtureRecord(t, tar.TypeReg, "third", "cd", nil),
	)
	entries, valid := readPythonArchive(data, pythonSdist)
	want := []pythonArchiveEntry{
		pythonFixtureFile(pythonTarFirst, "ab"), pythonFixtureFile(pythonTarSecond, "x"),
		pythonFixtureFile("third", "cd"),
	}
	if !valid || pythonArchiveDigest(entries) != pythonArchiveDigest(want) {
		t.Fatal("global size inheritance or local override changed file bodies")
	}
}

func TestPythonTarInheritedMetadataCannotBypassBounds(t *testing.T) {
	t.Parallel()
	for _, records := range []map[string]string{
		{pythonPAXPath: "../outside"},
		{pythonPAXPath: "/outside"},
		{pythonPAXPath: ""},
		{pythonPAXSize: "8388609"},
		{pythonPAXSize: "-1"},
	} {
		data := pythonTarSequence(t,
			pythonTarFixtureRecord(t, tar.TypeXGlobalHeader, pythonTarGlobal, "", records),
			pythonTarFixtureRecord(t, tar.TypeReg, pythonTarEntry, "x", nil),
		)
		if _, valid := readPythonArchive(data, pythonSdist); valid {
			t.Error("inherited metadata bypassed archive validation")
		}
	}
	duplicate := pythonTarSequence(t,
		pythonTarFixtureRecord(t, tar.TypeXGlobalHeader, pythonTarGlobal, "",
			map[string]string{pythonPAXPath: "duplicate-entry"}),
		pythonTarFixtureRecord(t, tar.TypeReg, pythonTarFirst, "a", nil),
		pythonTarFixtureRecord(t, tar.TypeReg, pythonTarSecond, "b", nil),
	)
	if _, valid := readPythonArchive(duplicate, pythonSdist); valid {
		t.Fatal("inherited duplicate names bypassed validation")
	}
}

func TestPythonTarContiguousFiles(t *testing.T) {
	t.Parallel()
	data := pythonTarSequence(t, pythonTarFixtureRecord(t, tar.TypeCont, pythonTarEntry, "body", nil))
	entries, valid := readPythonArchive(data, pythonSdist)
	if !valid || len(entries) != 1 || string(entries[0].data) != "body" || entries[0].directory {
		t.Fatal("legacy contiguous regular file was not preserved")
	}
}

func TestPythonTarExtensionChecksumsAndTermination(t *testing.T) {
	t.Parallel()
	for _, kind := range []byte{tar.TypeXGlobalHeader, tar.TypeXHeader} {
		header := pythonTarFixtureRecord(t, kind, "extension", "", map[string]string{"comment": "metadata"})
		if _, valid := readPythonArchive(pythonTarSequence(t, header), pythonSdist); valid {
			t.Error("accepted an extension without its following member")
		}
		header[0] ^= 1
		file := pythonTarFixtureRecord(t, tar.TypeReg, pythonTarEntry, "body", nil)
		if _, valid := readPythonArchive(pythonTarSequence(t, header, file), pythonSdist); valid {
			t.Error("accepted a corrupted extended header")
		}
	}
}

func TestPythonTarLegacySparseFiles(t *testing.T) {
	t.Parallel()
	const (
		gnuMagicOffset = 257
		sparseOffset   = 386
		sparseLength   = 398
		realSizeOffset = 483
	)
	data := pythonTarFixtureRecord(t, tar.TypeReg, pythonTarEntry, "abc", nil)
	data[pythonTarTypeOffset] = tar.TypeGNUSparse
	copy(data[gnuMagicOffset:], "ustar  \x00")
	copy(data[sparseOffset:], "00000000002\x00")
	copy(data[sparseLength:], "00000000003\x00")
	copy(data[realSizeOffset:], "00000000011\x00")
	pythonTarFixtureChecksum(data)
	entries, valid := readPythonArchive(pythonTarSequence(t, data), pythonSdist)
	if !valid || len(entries) != 1 || string(entries[0].data) != "\x00\x00abc\x00\x00\x00\x00" {
		t.Fatal("sparse logical file contents were not preserved")
	}
	copy(data[realSizeOffset:], fmt.Sprintf("%011o\x00", pythonArchiveMemberBytes+1))
	pythonTarFixtureChecksum(data)
	if _, valid := readPythonArchive(pythonTarSequence(t, data), pythonSdist); valid {
		t.Fatal("sparse expansion bypassed the logical file size limit")
	}
}
