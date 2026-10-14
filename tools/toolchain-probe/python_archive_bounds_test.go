package main

import (
	"archive/tar"
	"bytes"
	"encoding/binary"
	"fmt"
	"testing"
)

const (
	pythonZipFlagsOffset      = 8
	pythonZipSizeOffset       = 24
	pythonZipAttributesOffset = 38
	pythonZipCRCOffset        = 16
	pythonTarTypeOffset       = 156
	pythonFixtureSymlinkMode  = 0o120777
	pythonFixtureFIFOMode     = 0o010644
)

func TestPythonWheelEntryBounds(t *testing.T) {
	t.Parallel()
	const (
		patchedDataFlag      = 1 << 5
		strongEncryptionFlag = 1 << 6
	)
	data := pythonFixtureZip(t, []pythonArchiveEntry{pythonFixtureFile("a", "x")})
	position := bytes.Index(data, []byte(pythonZipDirectorySignature))
	for _, flags := range []uint16{1, patchedDataFlag, strongEncryptionFlag} {
		mutated := bytes.Clone(data)
		binary.LittleEndian.PutUint16(mutated[position+pythonZipFlagsOffset:], flags)
		if _, valid := readPythonArchive(mutated, pythonWheel); valid {
			t.Errorf("accepted unsupported ZIP flags %x", flags)
		}
	}
	for _, test := range []struct {
		name   string
		offset int
		value  uint32
	}{
		{"oversized", pythonZipSizeOffset, pythonArchiveMemberBytes + 1},
		{"linked-wheel-entry", pythonZipAttributesOffset, pythonFixtureSymlinkMode << pythonZipModeShift},
		{"fifo", pythonZipAttributesOffset, pythonFixtureFIFOMode << pythonZipModeShift},
	} {
		mutated := bytes.Clone(data)
		binary.LittleEndian.PutUint32(mutated[position+test.offset:], test.value)
		if _, valid := readPythonArchive(mutated, pythonWheel); valid {
			t.Errorf("accepted %s wheel member", test.name)
		}
	}
	mutated := bytes.Clone(data)
	// Change the expected checksum, not a compression bit that may be padding.
	mutated[position+pythonZipCRCOffset] ^= 1
	if _, valid := readPythonArchive(mutated, pythonWheel); valid {
		t.Error("accepted corrupted member bytes")
	}
}

func TestPythonWheelRejectsLocalNameMismatch(t *testing.T) {
	t.Parallel()
	file := pythonFixtureFile(pythonFixtureWheelMetadata, pythonFixtureMetadata)
	data := pythonFixtureZip(t, []pythonArchiveEntry{file})
	if _, valid := readPythonArchive(data, pythonWheel); !valid {
		t.Fatal("valid wheel fixture rejected")
	}
	data[pythonZipLocalHeaderSize] ^= 1
	if _, valid := readPythonArchive(data, pythonWheel); valid {
		t.Fatal("accepted different local and central ZIP filenames")
	}
}

func TestPythonWheelLocalHeaderBounds(t *testing.T) {
	t.Parallel()
	data := pythonFixtureZip(t, []pythonArchiveEntry{pythonFixtureFile("pkg/entry", "body")})
	directory := bytes.Index(data, []byte(pythonZipDirectorySignature))
	for _, offset := range []int{
		0, pythonZipLocalHeaderSize - 2*pythonZipWordSize,
		pythonZipLocalHeaderSize - pythonZipWordSize, directory + pythonZipLocalOffset,
	} {
		mutated := bytes.Clone(data)
		binary.LittleEndian.PutUint16(mutated[offset:], ^uint16(0))
		if _, valid := readPythonArchive(mutated, pythonWheel); valid {
			t.Errorf("accepted invalid local header field at %d", offset)
		}
	}
}

func TestPythonWheelLocalExtraAndUnicode(t *testing.T) {
	t.Parallel()
	extra := []byte{pythonFixtureByteMask, pythonFixtureByteMask, 2, 0, 1, 2}
	file := pythonFixtureFile("pkg/é.py", "body")
	data := pythonFixtureZip(t, []pythonArchiveEntry{file}, extra...)
	// Local and central extra fields may legitimately differ. Data descriptors
	// also leave local CRC and sizes unset until the member has been written.
	data[pythonZipLocalHeaderSize+len(file.name)+len(extra)-1] ^= 1
	entries, valid := readPythonArchive(data, pythonWheel)
	if !valid || pythonArchiveDigest(entries) != pythonArchiveDigest([]pythonArchiveEntry{file}) {
		t.Fatal("valid Unicode filename, local extra, or data descriptor rejected")
	}
}

func TestPythonTarRejectsSpecialEntries(t *testing.T) {
	t.Parallel()
	for _, kind := range []byte{tar.TypeSymlink, tar.TypeLink, tar.TypeFifo, tar.TypeChar, tar.TypeBlock} {
		var raw bytes.Buffer
		writer := tar.NewWriter(&raw)
		header := new(tar.Header)
		header.Name, header.Linkname, header.Typeflag = "pkg/entry", "target", kind
		if err := writer.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		data := pythonFixtureGzip(t, raw.Bytes())
		if _, valid := readPythonArchive(data, pythonSdist); valid {
			t.Errorf("accepted special tar entry %q", kind)
		}
		if _, valid := normalizePythonSdist(data, pythonReleaseEpoch); valid {
			t.Errorf("normalized special tar entry %q", kind)
		}
	}
}

func pythonRawHeader(size int, kind byte) []byte {
	header := make([]byte, pythonTarBlockSize)
	copy(header, "pkg/entry")
	copy(header[pythonTarSizeOffset:pythonTarSizeEnd], fmt.Sprintf("%011o\x00", size))
	header[pythonTarTypeOffset] = kind
	return header
}

func TestPythonTarPhysicalExpansionBounds(t *testing.T) {
	t.Parallel()
	for _, kind := range []byte{tar.TypeReg, tar.TypeXHeader, tar.TypeXGlobalHeader, tar.TypeGNULongName} {
		if validPythonTarStream(pythonRawHeader(pythonArchiveMemberBytes+1, kind)) {
			t.Errorf("accepted oversized physical member %q", kind)
		}
	}
	const memberCount = pythonArchiveExpandedLimit/pythonArchiveMemberBytes + 1
	const expandedSize = memberCount*(pythonArchiveMemberBytes+pythonTarBlockSize) +
		pythonTarEndBlocks*pythonTarBlockSize
	raw := make([]byte, 0, expandedSize)
	for range memberCount {
		raw = append(raw, pythonRawHeader(pythonArchiveMemberBytes, tar.TypeReg)...)
		raw = append(raw, make([]byte, pythonArchiveMemberBytes)...)
	}
	raw = append(raw, make([]byte, pythonTarEndBlocks*pythonTarBlockSize)...)
	if validPythonTarStream(raw) {
		t.Fatal("accepted excessive physical expansion")
	}
	if _, valid := readPythonArchive(pythonFixtureGzip(t, raw), pythonSdist); valid {
		t.Fatal("accepted gzip expansion beyond the stream limit")
	}
}

func TestPythonTarCountsExtendedHeaders(t *testing.T) {
	t.Parallel()
	raw := make([]byte, 0, (pythonArchiveMemberLimit+1+pythonTarEndBlocks)*pythonTarBlockSize)
	for range pythonArchiveMemberLimit + 1 {
		raw = append(raw, pythonRawHeader(0, tar.TypeXHeader)...)
	}
	raw = append(raw, make([]byte, pythonTarEndBlocks*pythonTarBlockSize)...)
	if validPythonTarStream(raw) {
		t.Fatal("logical tar iteration hid too many extension headers")
	}
	oversized := make([]byte, pythonArtifactLimit+1)
	for _, kind := range []string{pythonWheel, pythonSdist} {
		if _, valid := readPythonArchive(oversized, kind); valid {
			t.Errorf("%s accepted oversized compressed input", kind)
		}
	}
}

func TestPythonZipDirectoryCountCannotUnderstateAllocation(t *testing.T) {
	t.Parallel()
	data := pythonFixtureZip(t, []pythonArchiveEntry{pythonFixtureFile("a", "x"), pythonFixtureFile("b", "y")})
	end := len(data) - pythonZipEndSize
	binary.LittleEndian.PutUint16(data[end+8:], 1)
	binary.LittleEndian.PutUint16(data[end+10:], 1)
	if validPythonZipEnd(data) {
		t.Fatal("ZIP preflight accepted more central entries than its declared allocation bound")
	}
}

func TestPythonArchiveBudget(t *testing.T) {
	t.Parallel()
	var budget pythonArchiveBudget
	for range pythonArchiveExpandedLimit / pythonArchiveMemberBytes {
		if !budget.accept(pythonArchiveMemberBytes) {
			t.Fatal("rejected an in-budget member")
		}
	}
	before := budget
	if budget.accept(1) || budget != before {
		t.Fatal("aggregate overflow was accepted or changed the valid budget")
	}
	budget = pythonArchiveBudget{members: 0, size: 0}
	for range pythonArchiveMemberLimit {
		if !budget.accept(0) {
			t.Fatal("rejected an in-budget empty member")
		}
	}
	if budget.accept(0) {
		t.Fatal("empty entries bypassed the member count limit")
	}
	for _, size := range []uint64{pythonArchiveMemberBytes + 1, ^uint64(0)} {
		budget = pythonArchiveBudget{members: 0, size: 0}
		if budget.accept(size) || budget.members != 0 || budget.size != 0 {
			t.Fatal("oversized member changed the budget")
		}
	}
}
