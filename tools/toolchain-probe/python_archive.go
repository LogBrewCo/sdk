package main

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"io"
	"net/textproto"
	"path"
	"slices"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	pythonWheel                = "wheel"
	pythonSdist                = "sdist"
	pythonArtifactLimit        = 25 << 20
	pythonArchiveMemberLimit   = 1024
	pythonArchiveMemberBytes   = 8 << 20
	pythonArchiveExpandedLimit = 32 << 20
	pythonMetadataLimit        = 512 << 10
	pythonTarBlockSize         = 512
	pythonTarEndBlocks         = 2
	pythonTarRecordPadding     = 10240
	pythonTarStreamLimit       = pythonArchiveExpandedLimit +
		(pythonArchiveMemberLimit+pythonTarEndBlocks)*pythonTarBlockSize + pythonTarRecordPadding
	pythonTarSizeOffset            = 124
	pythonTarSizeEnd               = 136
	pythonZipEndSize               = 22
	pythonZipEndSignature          = "PK\x05\x06"
	pythonZipTailLimit             = 65557
	pythonUnixTypeMask             = 0o170000
	pythonUnixRegular              = 0o100000
	pythonUnixDirectory            = 0o040000
	pythonUnixPermissions          = 0o777
	pythonZipModeShift             = 16
	pythonZipDirectoryHeaderSize   = 46
	pythonZipDirectorySignature    = "PK\x01\x02"
	pythonZipVariableLengthsOffset = 28
	pythonZipVariableLengthsEnd    = 34
	pythonZipWordSize              = 2
	pythonZipLocalOffset           = 42
	pythonZipLocalHeaderSize       = 30
	pythonZipLocalSignature        = "PK\x03\x04"
	pythonZipUnsupportedFlags      = 0x61 // Encryption, patched data, and strong encryption.
)

type pythonArchiveEntry struct {
	name      string
	data      []byte
	mode      uint32
	directory bool
}

type pythonArchiveBudget struct {
	members int
	size    uint64
}

func (budget *pythonArchiveBudget) accept(size uint64) bool {
	if budget.members >= pythonArchiveMemberLimit || size > pythonArchiveMemberBytes ||
		size > pythonArchiveExpandedLimit-budget.size {
		return false
	}
	budget.members++
	budget.size += size
	return true
}

type pythonZipEnd struct {
	Signature                                 uint32
	Disk, DirectoryDisk, DiskEntries, Entries uint16
	DirectorySize, DirectoryOffset            uint32
	CommentLength                             uint16
}

// Read bounded package bytes without extracting any archive path to disk.
// Container preflight runs before the standard library allocates member tables.
func readPythonArchive(data []byte, kind string) ([]pythonArchiveEntry, bool) {
	if len(data) == 0 || len(data) > pythonArtifactLimit {
		return nil, false
	}
	var entries []pythonArchiveEntry
	var valid bool
	switch kind {
	case pythonWheel:
		entries, valid = readPythonWheel(data)
	case pythonSdist:
		entries, valid = readPythonSdist(data)
	default:
		return nil, false
	}
	if !valid || !canonicalArchiveEntries(entries) {
		return nil, false
	}
	return entries, true
}

func canonicalArchiveEntries(entries []pythonArchiveEntry) bool {
	if len(entries) > pythonArchiveMemberLimit {
		return false
	}
	slices.SortFunc(entries, func(left, right pythonArchiveEntry) int { return strings.Compare(left.name, right.name) })
	for index, entry := range entries {
		if !safePythonArchiveName(entry.name) || index > 0 && entries[index-1].name == entry.name {
			return false
		}
	}
	return true
}

func safePythonArchiveName(name string) bool {
	trimmed := strings.TrimSuffix(name, "/")
	return utf8.ValidString(name) && trimmed != "." && trimmed != "" &&
		!strings.Contains(name, "\\") && !path.IsAbs(name) && path.Clean(trimmed) == trimmed &&
		trimmed != ".." && !strings.HasPrefix(trimmed, "../") && strings.IndexFunc(name, unicode.IsControl) < 0
}

func validPythonZipEnd(data []byte) bool {
	start := max(0, len(data)-pythonZipTailLimit)
	offset := bytes.LastIndex(data[start:], []byte(pythonZipEndSignature))
	if offset < 0 {
		return false
	}
	offset += start
	var end pythonZipEnd
	if _, err := binary.Decode(data[offset:], binary.LittleEndian, &end); err != nil {
		return false
	}
	return end.Disk == 0 && end.DirectoryDisk == 0 && end.DiskEntries == end.Entries &&
		end.Entries <= pythonArchiveMemberLimit &&
		uint64(end.DirectoryOffset)+uint64(end.DirectorySize) == uint64(offset) &&
		offset+pythonZipEndSize+int(end.CommentLength) == len(data) &&
		validPythonZipDirectory(data[:offset], int(end.DirectoryOffset), int(end.Entries))
}

func validPythonZipDirectory(data []byte, directoryOffset, expected int) bool {
	directory := data[directoryOffset:]
	count := 0
	for offset := 0; offset < len(directory); {
		if len(directory)-offset < pythonZipDirectoryHeaderSize ||
			!bytes.HasPrefix(directory[offset:], []byte(pythonZipDirectorySignature)) {
			return false
		}
		size := pythonZipDirectoryHeaderSize
		for field := pythonZipVariableLengthsOffset; field < pythonZipVariableLengthsEnd; field += pythonZipWordSize {
			size += int(binary.LittleEndian.Uint16(directory[offset+field:]))
		}
		count++
		if size > len(directory)-offset || count > pythonArchiveMemberLimit ||
			!validPythonZipLocalHeader(data[:directoryOffset], directory[offset:offset+size]) {
			return false
		}
		offset += size
	}
	return count == expected
}

// The ZIP reader trusts central filenames; Python consumers also compare the
// local copy. Validate both without assuming that their extra fields match.
func validPythonZipLocalHeader(data, directory []byte) bool {
	offset := uint64(binary.LittleEndian.Uint32(directory[pythonZipLocalOffset:]))
	if offset+pythonZipLocalHeaderSize > uint64(len(data)) {
		return false
	}
	header := data[offset:]
	if !bytes.HasPrefix(header, []byte(pythonZipLocalSignature)) {
		return false
	}
	nameLength := int(binary.LittleEndian.Uint16(header[pythonZipLocalHeaderSize-2*pythonZipWordSize:]))
	extraLength := int(binary.LittleEndian.Uint16(header[pythonZipLocalHeaderSize-pythonZipWordSize:]))
	directoryNameLength := int(binary.LittleEndian.Uint16(directory[pythonZipVariableLengthsOffset:]))
	nameEnd := pythonZipLocalHeaderSize + nameLength
	return nameLength == directoryNameLength && nameEnd+extraLength <= len(header) &&
		bytes.Equal(header[pythonZipLocalHeaderSize:nameEnd],
			directory[pythonZipDirectoryHeaderSize:pythonZipDirectoryHeaderSize+directoryNameLength])
}

func readPythonWheel(data []byte) ([]pythonArchiveEntry, bool) {
	if !validPythonZipEnd(data) {
		return nil, false
	}
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil || len(reader.File) > pythonArchiveMemberLimit {
		return nil, false
	}
	entries := make([]pythonArchiveEntry, 0, len(reader.File))
	var budget pythonArchiveBudget
	for _, member := range reader.File {
		directory := strings.HasSuffix(member.Name, "/")
		expectedType := uint32(pythonUnixRegular)
		if directory {
			expectedType = pythonUnixDirectory
		}
		fileType := member.ExternalAttrs >> pythonZipModeShift & pythonUnixTypeMask
		if member.Flags&pythonZipUnsupportedFlags != 0 || fileType != 0 && fileType != expectedType ||
			!budget.accept(member.UncompressedSize64) {
			return nil, false
		}
		source, openError := member.Open()
		if openError != nil {
			return nil, false
		}
		body, readError := io.ReadAll(io.LimitReader(source, pythonArchiveMemberBytes+1))
		closeError := source.Close()
		if readError != nil || closeError != nil || uint64(len(body)) != member.UncompressedSize64 {
			return nil, false
		}
		entries = append(entries, pythonArchiveEntry{
			name: member.Name, data: body,
			mode: member.ExternalAttrs >> pythonZipModeShift & pythonUnixPermissions, directory: directory,
		})
	}
	return entries, true
}

func readPythonSdist(data []byte) ([]pythonArchiveEntry, bool) {
	compressed, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, false
	}
	raw, readError := io.ReadAll(io.LimitReader(compressed, pythonTarStreamLimit+1))
	closeError := compressed.Close()
	if readError != nil || closeError != nil {
		return nil, false
	}
	records, valid := pythonTarRecords(raw)
	if !valid {
		return nil, false
	}
	return readPythonTarRecords(records)
}

func validPythonTarMember(member *tar.Header) bool {
	return member.Typeflag == tar.TypeReg || member.Typeflag == tar.TypeCont ||
		member.Typeflag == tar.TypeGNUSparse || member.Typeflag == tar.TypeDir
}

// Count raw PAX/GNU extension records too. Logical tar iteration alone can hide
// excessive metadata allocations. Accept only bounded octal physical sizes.
func validPythonTarStream(raw []byte) bool {
	_, valid := pythonTarRecords(raw)
	return valid
}

func pythonTarRecords(raw []byte) ([][]byte, bool) {
	if len(raw) > pythonTarStreamLimit {
		return nil, false
	}
	var zero [pythonTarBlockSize]byte
	var budget pythonArchiveBudget
	records := make([][]byte, 0)
	for offset := 0; offset+pythonTarBlockSize <= len(raw); {
		start := offset
		header := raw[offset : offset+pythonTarBlockSize]
		offset += pythonTarBlockSize
		if bytes.Equal(header, zero[:]) {
			return records, len(raw)-offset >= pythonTarBlockSize && allPythonZeroBytes(raw[offset:])
		}
		rawSize := string(header[pythonTarSizeOffset:pythonTarSizeEnd])
		sizeText := strings.TrimLeft(strings.TrimRight(rawSize, "\x00 "), " ")
		size, err := strconv.ParseUint(sizeText, 8, 64)
		if err != nil || strings.HasPrefix(sizeText, "+") || size > pythonArchiveMemberBytes || !budget.accept(size) {
			return nil, false
		}
		padded := (int(size) + pythonTarBlockSize - 1) / pythonTarBlockSize * pythonTarBlockSize
		if padded > len(raw)-offset {
			return nil, false
		}
		offset += padded
		records = append(records, raw[start:offset])
	}
	return nil, false
}

func allPythonZeroBytes(data []byte) bool {
	for _, value := range data {
		if value != 0 {
			return false
		}
	}
	return true
}

// Preserve the release manifest's length-framed, sorted content digest. File
// permissions, order, timestamps and compression do not change package content.
func pythonArchiveDigest(entries []pythonArchiveEntry) string {
	files := slices.DeleteFunc(slices.Clone(entries), func(entry pythonArchiveEntry) bool { return entry.directory })
	return framedArchiveDigest(files)
}

func framedArchiveDigest(entries []pythonArchiveEntry) string {
	ordered := slices.Clone(entries)
	slices.SortFunc(ordered, func(left, right pythonArchiveEntry) int { return strings.Compare(left.name, right.name) })
	digest := sha256.New()
	for _, entry := range ordered {
		record := binary.BigEndian.AppendUint64(nil, uint64(len(entry.name)))
		record = append(record, entry.name...)
		record = binary.BigEndian.AppendUint64(record, uint64(len(entry.data)))
		if _, err := digest.Write(record); err != nil {
			return ""
		}
		if _, err := digest.Write(entry.data); err != nil {
			return ""
		}
	}
	return hex.EncodeToString(digest.Sum(nil))
}

// This is archive identity, not a substitute for complete Python metadata
// validation. Callers must retain that separate packaging gate.
func pythonArchiveIdentity(entries []pythonArchiveEntry, kind, root, packageID, version string) bool {
	var metadata []byte
	for _, entry := range entries {
		matches := kind == pythonWheel && strings.HasSuffix(entry.name, ".dist-info/METADATA") ||
			kind == pythonSdist && entry.name == root+"/PKG-INFO"
		if !matches || entry.directory {
			continue
		}
		if metadata != nil || len(entry.data) > pythonMetadataLimit {
			return false
		}
		metadata = entry.data
	}
	if len(metadata) == 0 || !utf8.Valid(metadata) {
		return false
	}
	reader := textproto.NewReader(bufio.NewReader(bytes.NewReader(append(bytes.Clone(metadata), '\n', '\n'))))
	headers, err := reader.ReadMIMEHeader()
	return err == nil && len(headers.Values("Name")) == 1 && len(headers.Values("Version")) == 1 &&
		headers.Get("Name") == packageID && headers.Get("Version") == version
}
