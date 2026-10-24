package main

import (
	"bufio"
	"bytes"
	"compress/flate"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math/big"
	"os"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

const (
	pdbMaxEmbeddedBytes = 64 << 20
	msfSignature        = "Microsoft C/C++ MSF 7.00\r\n\x1a\x44\x53\x00\x00\x00"
)

var (
	breakpadIdentifierPattern = regexp.MustCompile(`^[0-9A-F]+$`)
	breakpadArches            = map[string]string{"x86": "x86", "x86_64": "x86_64", "amd64": "x86_64", "x64": "x86_64",
		"arm64": "arm64", "aarch64": "arm64", "arm": "armv7", "armv7": "armv7", "arm32": "armv7"}
	elfArches   = map[uint16]string{3: "x86", 40: "armeabi-v7a", 62: "x86_64", 183: "arm64-v8a"}
	machoArches = map[uint32]string{7: "i386", 12: "armv7", 0x01000007: "x86_64", 0x0100000c: "arm64"}
	peArches    = map[uint16]string{0x014c: "x86", 0x8664: "x64", 0x01c0: "arm32", 0xaa64: "arm64"}
)

// nativeFile reads byte ranges of one symbol file.
type nativeFile struct {
	io.ReaderAt
	size int64
}

func openNativeFile(path string) (nativeFile, func()) {
	file, err := os.Open(path)
	var info os.FileInfo
	if err == nil {
		info, err = file.Stat()
	}
	if err != nil {
		panic(nativeStop{exitFailure, "cannot read " + path})
	}
	return nativeFile{file, info.Size()}, func() { _ = file.Close() }
}

// fits reports whether count bytes at offset lie inside the file.
func (file nativeFile) fits(offset, count uint64) bool {
	return offset <= uint64(file.size) && count <= uint64(file.size)-offset
}

// at returns count bytes at offset, or nil when the file ends first.
func (file nativeFile) at(offset, count uint64) []byte {
	if count == 0 {
		return []byte{}
	}
	if !file.fits(offset, count) {
		return nil
	}
	data := make([]byte, count)
	if _, err := file.ReadAt(data, int64(offset)); err != nil {
		return nil
	}
	return data
}

// nativeZip lists an archive's file members by their safe names, as Python's
// zipfile and pathlib read them.
func nativeZip(path, label string) (map[string]zipEntry, []string) {
	data, err := os.ReadFile(path)
	var members []zipEntry
	if err == nil {
		members, err = openZip(data)
	}
	if err != nil {
		return nil, []string{label + " is not a valid ZIP file"}
	}
	entries, failures := map[string]zipEntry{}, []string{}
	for _, member := range members {
		if strings.HasSuffix(member.name, "/") {
			continue
		}
		parts := []string{}
		for _, part := range strings.Split(member.name, "/") {
			if part != "" && part != "." {
				parts = append(parts, part)
			}
		}
		if member.name == "" || strings.Contains(member.name, "\\") || strings.HasPrefix(member.name, "/") ||
			len(parts) == 0 || strings.HasSuffix(parts[0], ":") || slices.Contains(parts, "..") {
			failures = []string{label + " contains unsafe entry paths"}
			continue
		}
		entries[strings.Join(parts, "/")] = member
	}
	return entries, failures
}

// nativeRead reads a whole member; a member Python's zipfile cannot read stops
// the manifest.
func nativeRead(entry zipEntry) []byte {
	data, err := readZipFile(entry)
	if err != nil {
		panic(nativeStop{exitFailure, "cannot read ZIP member " + entry.name})
	}
	return data
}

func nativeMember(entry zipEntry) nativeFile {
	data := nativeRead(entry)
	return nativeFile{bytes.NewReader(data), int64(len(data))}
}

// nativeHead reads the first 4 KiB of a member; Python checks the CRC only
// when it reaches the end.
func nativeHead(entry zipEntry) []byte {
	if entry.size <= 4096 {
		return nativeRead(entry)
	}
	reader, _, err := openZipFile(entry)
	head := make([]byte, 4096)
	if err == nil {
		_, err = io.ReadFull(reader, head)
	}
	if err != nil {
		panic(nativeStop{exitFailure, "cannot read ZIP member " + entry.name})
	}
	return head
}

// readELF reads an ELF file's identity and symbol tables.
func readELF(file nativeFile) (map[string]any, string) {
	head := file.at(0, uint64(min(64, file.size)))
	if len(head) < 16 || !bytes.HasPrefix(head, []byte("\x7fELF")) {
		return nil, "not an ELF file"
	}
	switch {
	case head[4] != 1 && head[4] != 2:
		return nil, fmt.Sprintf("unsupported ELF class: %d", head[4])
	case head[5] != 1 && head[5] != 2:
		return nil, fmt.Sprintf("unsupported ELF endianness: %d", head[5])
	case head[6] != 1:
		return nil, fmt.Sprintf("unsupported ELF version: %d", head[6])
	}
	wide, order := head[4] == 2, binary.ByteOrder(binary.LittleEndian)
	if head[5] == 2 {
		order = binary.BigEndian
	}
	headerSize, entrySize, shift, tableAt := 52, 40, 0, 32
	if wide {
		headerSize, entrySize, shift, tableAt = 64, 64, 12, 40
	}
	if file.size < int64(headerSize) {
		return nil, "ELF header is truncated"
	}
	word := func(data []byte, at int) uint64 {
		if wide {
			return order.Uint64(data[at:])
		}
		return uint64(order.Uint32(data[at:]))
	}
	half := func(at int) int { return int(order.Uint16(head[at+shift:])) }
	typeCode, machine := order.Uint16(head[16:]), order.Uint16(head[18:])
	tableOffset, count, nameIndex := word(head, tableAt), half(48), half(50)
	switch {
	case order.Uint32(head[20:]) != 1:
		return nil, fmt.Sprintf("unsupported ELF file version: %d", order.Uint32(head[20:]))
	case half(40) != headerSize:
		return nil, fmt.Sprintf("unexpected ELF header size: %d", half(40))
	case count != 0 && half(46) != entrySize:
		return nil, fmt.Sprintf("unexpected ELF section header size: %d", half(46))
	case count == 0 || nameIndex == 0xffff:
		return nil, "ELF extended section tables are not supported by this dry run"
	case tableOffset == 0:
		return nil, "ELF section header table is missing"
	}
	table := file.at(tableOffset, uint64(count*entrySize))
	if table == nil {
		return nil, "ELF section header table is truncated"
	}
	type section struct {
		name                      []byte
		kind, offset, size, align uint64
	}
	sections := make([]section, count)
	for index := range sections {
		entry := table[index*entrySize:]
		at := map[bool][]int{false: {16, 20, 32}, true: {24, 32, 48}}[wide]
		sections[index] = section{nil, uint64(order.Uint32(entry[4:])), word(entry, at[0]), word(entry, at[1]),
			word(entry, at[2])}
		if sections[index].kind != 8 && !file.fits(sections[index].offset, sections[index].size) {
			return nil, "ELF section data is truncated"
		}
	}
	if nameIndex >= count {
		return nil, "ELF section name table index is invalid"
	}
	if sections[nameIndex].kind != 3 {
		return nil, "ELF section name table is missing"
	}
	names := file.at(sections[nameIndex].offset, sections[nameIndex].size)
	record := map[string]any{"elfClass": map[bool]int{false: 32, true: 64}[wide], "elfTypeCode": typeCode,
		"elfType": map[uint16]string{2: "EXEC", 3: "DYN"}[typeCode], "arch": elfArches[machine],
		"gnuBuildId": "", "goBuildId": "", "fileSha256": "", "hasCode": false}
	if record["elfType"] == "" {
		record["elfType"] = fmt.Sprintf("unknown(%d)", typeCode)
	}
	if record["arch"] == "" {
		record["arch"] = fmt.Sprintf("unknown(%d)", machine)
	}
	for index := range sections {
		current := &sections[index]
		nameOffset := uint64(order.Uint32(table[index*entrySize:]))
		if nameOffset < uint64(len(names)) {
			current.name, _, _ = bytes.Cut(names[nameOffset:], []byte{0})
		}
		name := string(current.name)
		filled := current.kind != 8 && current.size > 0
		for key, wanted := range map[string]string{"hasDebugInfo": ".debug_info", "hasZdebugInfo": ".zdebug_info",
			"hasSymbolTable": ".symtab", "hasDynamicSymbolTable": ".dynsym"} {
			record[key] = record[key] == true || name == wanted && filled
		}
		if name == ".text" && current.kind == 1 {
			record["hasCode"] = true
		}
		if current.kind != 7 || name != ".note.gnu.build-id" && name != ".note.go.buildid" {
			continue
		}
		payload := file.at(current.offset, current.size)
		for at := uint64(0); at <= uint64(len(payload)) && uint64(len(payload))-at >= 12; {
			nameSize, descSize, noteType := uint64(order.Uint32(payload[at:])), uint64(order.Uint32(payload[at+4:])),
				order.Uint32(payload[at+8:])
			descOffset := alignUp(at+12+nameSize, current.align)
			if descOffset > uint64(len(payload)) || descSize > uint64(len(payload))-descOffset {
				break
			}
			noteName, desc := string(bytes.TrimRight(payload[at+12:at+12+nameSize], "\x00")), payload[descOffset:descOffset+descSize]
			if name == ".note.gnu.build-id" && (noteType == 3 || noteName == "GNU") {
				record["gnuBuildId"] = hex.EncodeToString(desc)
			}
			if name == ".note.go.buildid" && (noteType == 4 || noteName == "Go") {
				record["goBuildId"] = asciiReplace(desc)
			}
			at = alignUp(descOffset+descSize, current.align)
		}
	}
	record["hasDebugInfo"] = record["hasDebugInfo"] == true || record["hasZdebugInfo"] == true
	delete(record, "hasZdebugInfo")
	if record["hasCode"] == true {
		digest := sha256.New()
		_, _ = io.Copy(digest, io.NewSectionReader(file, 0, file.size))
		record["fileSha256"] = hex.EncodeToString(digest.Sum(nil))
	}
	return record, ""
}

// asciiReplace decodes like Python's bytes.decode("ascii", "replace").
func asciiReplace(data []byte) string {
	var text strings.Builder
	for _, value := range data {
		if value >= utf8.RuneSelf {
			text.WriteRune(utf8.RuneError)
		} else {
			text.WriteByte(value)
		}
	}
	return text.String()
}

func alignUp(value, alignment uint64) uint64 {
	if alignment <= 1 || value%alignment == 0 {
		return value
	}
	return value + alignment - value%alignment
}

// machoUUIDs reads the UUID of a Mach-O object or of each fat slice.
func machoUUIDs(file nativeFile) ([]any, string) {
	if file.size < 4 {
		return nil, "Mach-O object is truncated"
	}
	magic := binary.BigEndian.Uint32(file.at(0, 4))
	order := binary.ByteOrder(binary.BigEndian)
	switch magic {
	case 0xbebafeca, 0xbfbafeca:
		order = binary.LittleEndian
	case 0xcafebabe, 0xcafebabf:
	default:
		entry, failure := machoSlice(file, 0, uint64(file.size))
		if entry == nil {
			return nil, failure
		}
		return []any{entry}, ""
	}
	countBytes := file.at(4, 4)
	if countBytes == nil {
		panic(nativeStop{exitUsage, "manifest validation failed: file data is truncated"})
	}
	entrySize, wide := uint64(20), magic&0xff == 0xbf || magic>>24 == 0xbf
	if wide {
		entrySize = 32
	}
	table := file.at(8, uint64(order.Uint32(countBytes))*entrySize)
	if table == nil {
		return nil, "fat Mach-O architecture table is truncated"
	}
	uuids, failures := []any{}, []string{}
	for at := uint64(0); at < uint64(len(table)); at += entrySize {
		offset, size := uint64(order.Uint32(table[at+8:])), uint64(order.Uint32(table[at+12:]))
		if wide {
			offset, size = order.Uint64(table[at+8:]), order.Uint64(table[at+16:])
		}
		if entry, failure := machoSlice(file, offset, size); entry != nil {
			uuids = append(uuids, entry)
		} else {
			failures = append(failures, failure)
		}
	}
	if len(uuids) > 0 {
		return uuids, ""
	}
	return nil, cmpOr(strings.Join(failures, "; "), "fat Mach-O object has no UUIDs")
}

func machoSlice(file nativeFile, offset, size uint64) (map[string]any, string) {
	if size < 4 || !file.fits(offset, size) {
		return nil, "Mach-O slice is truncated"
	}
	headerSize, order := uint64(28), binary.ByteOrder(binary.LittleEndian)
	switch string(file.at(offset, 4)) {
	case "\xcf\xfa\xed\xfe":
		headerSize = 32
	case "\xfe\xed\xfa\xcf":
		headerSize, order = 32, binary.BigEndian
	case "\xfe\xed\xfa\xce":
		order = binary.BigEndian
	case "\xce\xfa\xed\xfe":
	default:
		return nil, "not a Mach-O object"
	}
	if size < headerSize {
		return nil, "Mach-O header is truncated"
	}
	header := file.at(offset, headerSize)
	commandSize := uint64(order.Uint32(header[20:]))
	if commandSize > size-headerSize {
		return nil, "Mach-O load commands are truncated"
	}
	commands := file.at(offset+headerSize, commandSize)
	at := uint64(0)
	for range order.Uint32(header[16:]) {
		if at+8 > commandSize {
			return nil, "Mach-O load command is truncated"
		}
		command, length := order.Uint32(commands[at:]), uint64(order.Uint32(commands[at+4:]))
		if length < 8 || length > commandSize-at {
			return nil, "Mach-O load command size is invalid"
		}
		if command == 0x1b {
			if length < 24 {
				return nil, "Mach-O UUID load command is truncated"
			}
			uuid := strings.ToUpper(hex.EncodeToString(commands[at+8 : at+24]))
			arch := machoArches[order.Uint32(header[4:])]
			if arch == "" {
				arch = fmt.Sprintf("unknown(%d)", order.Uint32(header[4:]))
			}
			return map[string]any{"uuid": uuid[:8] + "-" + uuid[8:12] + "-" + uuid[12:16] + "-" + uuid[16:20] + "-" + uuid[20:],
				"arch": arch}, ""
		}
		at += length
	}
	return nil, "Mach-O UUID load command is missing"
}

// readBreakpad reads a Breakpad symbol file's MODULE header and whether it
// lists source files.
func readBreakpad(path string) (map[string]any, string) {
	file, closer := openNativeFile(path)
	defer closer()
	reader := bufio.NewReader(io.NewSectionReader(file, 0, file.size))
	var fields []string
	source := "symbol_table"
	for {
		raw, err := reader.ReadBytes('\n')
		if len(raw) == 0 && err != nil {
			break
		}
		raw = bytes.TrimRight(raw, "\r\n")
		if slices.ContainsFunc(raw, func(value byte) bool { return value >= utf8.RuneSelf }) {
			return nil, "Breakpad .sym files must be ASCII encoded"
		}
		text := pyStrip(string(raw))
		if fields == nil {
			if text == "" {
				continue
			}
			fields = strings.FieldsFunc(text, func(character rune) bool { return pyStrip(string(character)) == "" })
			switch identifier := strings.ToUpper(fields[min(3, len(fields)-1)]); {
			case !strings.HasPrefix(text, "MODULE "):
				return nil, "first non-empty line must be a Breakpad MODULE header"
			case len(fields) < 5:
				return nil, "Breakpad MODULE header is malformed"
			case len(identifier) <= 32:
				return nil, "Breakpad MODULE identifier must contain GUID and age"
			case !breakpadIdentifierPattern.MatchString(identifier):
				return nil, "Breakpad MODULE identifier must be hexadecimal"
			}
			continue
		}
		if strings.HasPrefix(text, "FILE ") {
			source = "debug_info"
			break
		}
		if strings.HasPrefix(text, "FUNC ") || strings.HasPrefix(text, "PUBLIC ") {
			break
		}
	}
	if fields == nil {
		return nil, "Breakpad symbol file is missing MODULE header"
	}
	identifier, cpu := strings.ToUpper(fields[3]), fields[2]
	age, _ := new(big.Int).SetString(identifier[32:], 16)
	arch := breakpadArches[strings.ToLower(cpu)]
	if arch == "" {
		arch = "unknown(" + cpu + ")"
	}
	return map[string]any{"moduleOs": fields[1], "cpu": cpu, "arch": arch, "moduleId": identifier,
		"guid": identifier[:8] + "-" + identifier[8:12] + "-" + identifier[12:16] + "-" + identifier[16:20] + "-" + identifier[20:32],
		"age":  age, "moduleName": baseName(strings.Join(fields[4:], " ")), "symbolSource": source}, ""
}

// baseName keeps the last component of a Windows or POSIX path.
func baseName(name string) string {
	name = strings.TrimRight(strings.ReplaceAll(name, "\\", "/"), "/")
	return cmpOr(name[strings.LastIndex(name, "/")+1:], "unknown")
}

func codeViewGUID(data []byte) string {
	return fmt.Sprintf("%08X-%04X-%04X-%X-%X", binary.LittleEndian.Uint32(data), binary.LittleEndian.Uint16(data[4:]),
		binary.LittleEndian.Uint16(data[6:]), data[8:10], data[10:16])
}

// readPE reads a PE file's CodeView PDB identity and any embedded Portable PDB.
func readPE(file nativeFile) (map[string]any, string) {
	dos := file.at(0, 64)
	if dos == nil {
		return nil, "PE DOS header is truncated"
	}
	if !bytes.HasPrefix(dos, []byte("MZ")) {
		return nil, "not a PE file"
	}
	peOffset := uint64(binary.LittleEndian.Uint32(dos[0x3c:]))
	if peOffset+24 > uint64(file.size) {
		return nil, "PE header is truncated"
	}
	if string(file.at(peOffset, 4)) != "PE\x00\x00" {
		return nil, "invalid PE signature"
	}
	header := file.at(peOffset+4, 20)
	machine, sectionCount := binary.LittleEndian.Uint16(header), uint64(binary.LittleEndian.Uint16(header[2:]))
	optionalSize := uint64(binary.LittleEndian.Uint16(header[16:]))
	if optionalSize < 120 {
		return nil, "PE optional header is truncated"
	}
	optional := file.at(peOffset+24, optionalSize)
	if optional == nil {
		return nil, "file data is truncated"
	}
	directory, class := map[uint16]uint64{0x10b: 96, 0x20b: 112}[binary.LittleEndian.Uint16(optional)],
		map[uint16]int{0x10b: 32, 0x20b: 64}[binary.LittleEndian.Uint16(optional)]
	if directory == 0 {
		return nil, fmt.Sprintf("unsupported PE optional header magic: %d", binary.LittleEndian.Uint16(optional))
	}
	if directory+56 > optionalSize {
		return nil, "PE debug directory entry is missing"
	}
	arch := peArches[machine]
	if arch == "" {
		arch = fmt.Sprintf("unknown(%d)", machine)
	}
	debugRVA, debugSize := binary.LittleEndian.Uint32(optional[directory+48:]), uint64(binary.LittleEndian.Uint32(optional[directory+52:]))
	if debugRVA == 0 || debugSize == 0 {
		return nil, "PE file has no CodeView PDB debug information"
	}
	sections := file.at(peOffset+24+optionalSize, sectionCount*40)
	if sections == nil {
		return nil, "file data is truncated"
	}
	fileOffset := func(rva uint32) (uint64, bool) {
		for at := 0; at < len(sections); at += 40 {
			field := func(index int) uint64 { return uint64(binary.LittleEndian.Uint32(sections[at+index:])) }
			if start := field(12); start <= uint64(rva) && uint64(rva) < start+max(field(8), field(16)) {
				offset := field(20) + uint64(rva) - start
				return offset, offset < uint64(file.size)
			}
		}
		return uint64(rva), uint64(rva) < uint64(file.size)
	}
	debugOffset, found := fileOffset(debugRVA)
	payload := file.at(debugOffset, debugSize)
	if !found || payload == nil {
		return nil, "PE debug directory points outside the file"
	}
	var record, embedded map[string]any
	embeddedFailure := ""
	for at := uint64(0); at+28 <= debugSize; at += 28 {
		field := func(index uint64) uint32 { return binary.LittleEndian.Uint32(payload[at+index:]) }
		kind, size, dataOffset, found := field(12), uint64(field(16)), uint64(field(24)), true
		if kind != 2 && kind != 17 {
			continue
		}
		if dataOffset == 0 {
			dataOffset, found = fileOffset(field(20))
		}
		found = found && file.fits(dataOffset, size)
		data := file.at(dataOffset, size)
		switch {
		case kind == 2 && !found:
			return nil, "PE CodeView record points outside the file"
		case kind == 2 && (len(data) < 24 || !bytes.HasPrefix(data, []byte("RSDS"))):
			return nil, "PE CodeView record is not PDB70/RSDS"
		case kind == 2:
			name, _, _ := bytes.Cut(data[24:], []byte{0})
			guid, age := codeViewGUID(data[4:20]), binary.LittleEndian.Uint32(data[20:])
			record = map[string]any{"peClass": class, "arch": arch, "pdbGuid": guid, "pdbAge": age,
				"pdbFileName": baseName(pyUTF8(name)), "pdbDebugId": fmt.Sprintf("%s_%d", guid, age), "symbolSource": "debug_info"}
		case kind == 17 && !found:
			embeddedFailure = "embedded Portable PDB record points outside the file"
		case kind == 17:
			embedded, embeddedFailure = readEmbeddedPDB(data)
		}
	}
	if record == nil {
		return nil, "PE file has no CodeView PDB debug information"
	}
	if embeddedFailure != "" {
		return nil, embeddedFailure
	}
	if len(embedded) > 0 {
		record["embeddedPortablePdb"] = embedded
	}
	return record, ""
}

func readEmbeddedPDB(data []byte) (map[string]any, string) {
	if len(data) < 8 {
		return nil, "embedded Portable PDB debug data is truncated"
	}
	if !bytes.HasPrefix(data, []byte("MPDB")) {
		return nil, "embedded Portable PDB signature is invalid"
	}
	size := binary.LittleEndian.Uint32(data[4:])
	if size > pdbMaxEmbeddedBytes {
		return nil, fmt.Sprintf("embedded Portable PDB is %d bytes when decompressed; maximum is %d bytes", size, pdbMaxEmbeddedBytes)
	}
	payload, err := io.ReadAll(io.LimitReader(flate.NewReader(bytes.NewReader(data[8:])), int64(size)+1))
	var corrupt flate.CorruptInputError
	if errors.As(err, &corrupt) {
		return nil, "embedded Portable PDB could not be decompressed"
	}
	if err != nil || len(payload) != int(size) {
		return nil, "embedded Portable PDB decompressed size does not match its header"
	}
	record, failure := readPortablePDB(payload)
	if failure != "" {
		return nil, "embedded " + failure
	}
	if record["pdbFormat"] != "portable_pdb" {
		return nil, "embedded Portable PDB payload is not a Portable PDB"
	}
	record["pdbFormat"], record["compressedByteSize"], record["uncompressedByteSize"] = "embedded_portable_pdb", len(data)-8, size
	return record, ""
}

// readPDB reads the identity of a Windows (MSF) or Portable PDB.
func readPDB(data []byte) (map[string]any, string) {
	if bytes.HasPrefix(data, []byte(msfSignature)) {
		return readWindowsPDB(data)
	}
	return readPortablePDB(data)
}

func readPortablePDB(data []byte) (map[string]any, string) {
	if !bytes.HasPrefix(data, []byte("BSJB")) {
		return map[string]any{"pdbFormat": "unrecognized"}, ""
	}
	size := uint64(len(data))
	if size < 16 {
		return nil, "Portable PDB metadata root is truncated"
	}
	at := 16 + uint64(binary.LittleEndian.Uint32(data[12:]))
	if at+4 > size {
		return nil, "Portable PDB metadata root is truncated"
	}
	count := binary.LittleEndian.Uint16(data[at+2:])
	if count == 0 {
		return nil, "Portable PDB stream directory is empty"
	}
	if count > 64 {
		return nil, fmt.Sprintf("Portable PDB stream directory has %d streams; maximum is 64", count)
	}
	at += 4
	for range count {
		if at+8 > size {
			return nil, "Portable PDB stream header is truncated"
		}
		offset, length := uint64(binary.LittleEndian.Uint32(data[at:])), uint64(binary.LittleEndian.Uint32(data[at+4:]))
		probe := data[min(size, at+8):min(size, at+8+256)]
		end := bytes.IndexByte(probe, 0)
		if end < 0 {
			return nil, "Portable PDB stream name is unterminated"
		}
		if !utf8.Valid(probe[:end]) {
			return nil, "Portable PDB stream name is not UTF-8"
		}
		name := string(probe[:end])
		if at = alignUp(at+8+uint64(end)+1, 4); at > size {
			return nil, "Portable PDB stream header is truncated"
		}
		if offset+length > size {
			return nil, "Portable PDB stream " + cmpOr(name, "<empty>") + " points outside the file"
		}
		if name != "#Pdb" {
			continue
		}
		if length < 32 {
			return nil, "Portable PDB #Pdb stream is truncated"
		}
		guid, age := codeViewGUID(data[offset:]), binary.LittleEndian.Uint32(data[offset+16:])
		return map[string]any{"pdbFormat": "portable_pdb", "pdbGuid": guid, "pdbAge": age,
			"pdbDebugId": fmt.Sprintf("%s_%d", guid, age)}, ""
	}
	return nil, "Portable PDB #Pdb stream is missing"
}

func readWindowsPDB(data []byte) (map[string]any, string) {
	if len(data) < len(msfSignature)+20 {
		return nil, "Windows PDB MSF header is truncated"
	}
	field := func(source []byte, index uint64) uint64 { return uint64(binary.LittleEndian.Uint32(source[index:])) }
	pageSize, maxPage, directorySize := field(data, 32), field(data, 40), field(data, 44)
	switch {
	case pageSize&(pageSize-1) != 0 || pageSize < 0x100 || pageSize > 128*0x10000:
		return nil, fmt.Sprintf("Windows PDB page size is invalid: %d", pageSize)
	case directorySize == 0:
		return nil, "Windows PDB stream directory is empty"
	case directorySize > 16<<20:
		return nil, fmt.Sprintf("Windows PDB stream directory is %d bytes; maximum is %d bytes", directorySize, 16<<20)
	case pageSize > uint64(len(data)):
		return nil, "Windows PDB page size is larger than the file"
	}
	pages := func(count uint64) uint64 { return (count + pageSize - 1) / pageSize }
	page := func(number uint64, label string) ([]byte, string) {
		if number == 0 || number > maxPage {
			return nil, fmt.Sprintf("Windows PDB %s page %d is outside the file", label, number)
		}
		if (number+1)*pageSize > uint64(len(data)) {
			return nil, fmt.Sprintf("Windows PDB %s page %d is truncated", label, number)
		}
		return data[number*pageSize : (number+1)*pageSize], ""
	}
	// read joins a stream's pages, keeping at most keep bytes.
	read := func(numbers []uint64, size, keep uint64, label string) ([]byte, string) {
		stream := []byte{}
		for _, number := range numbers {
			content, failure := page(number, label)
			if failure != "" {
				return nil, failure
			}
			if uint64(len(stream)) < min(size, keep) {
				stream = append(stream, content...)
			}
		}
		return stream[:min(size, uint64(len(stream)))], ""
	}
	numbers := func(source []byte, at, count uint64) []uint64 {
		values := []uint64{}
		for index := range count {
			values = append(values, field(source, at+index*4))
		}
		return values
	}
	directoryPages := pages(directorySize)
	listPages := pages(directoryPages * 4)
	if 52+listPages*4 > min(pageSize, uint64(len(data))) {
		return nil, "Windows PDB stream directory page list is truncated"
	}
	list, failure := read(numbers(data, 52, listPages), directoryPages*4, directoryPages*4, "stream directory page-list")
	if failure != "" {
		return nil, failure
	}
	directory, failure := read(numbers(list, 0, directoryPages), directorySize, directorySize, "stream directory")
	if failure != "" {
		return nil, failure
	}
	if len(directory) < 4 {
		return nil, "Windows PDB stream directory is truncated"
	}
	count := field(directory, 0)
	if count > 65535 {
		return nil, fmt.Sprintf("Windows PDB stream directory has %d streams; maximum is 65535", count)
	}
	if 4+count*4 > uint64(len(directory)) {
		return nil, "Windows PDB stream directory is truncated"
	}
	type stream struct {
		size    uint64
		numbers []uint64
	}
	streams, cursor := []*stream{}, 4+count*4
	for _, size := range numbers(directory, 4, count) {
		if size == 0xffffffff {
			streams = append(streams, nil)
			continue
		}
		if cursor+pages(size)*4 > uint64(len(directory)) {
			return nil, "Windows PDB stream directory page references are truncated"
		}
		current := &stream{size, numbers(directory, cursor, pages(size))}
		for _, number := range current.numbers {
			if number == 0 || number > maxPage {
				return nil, fmt.Sprintf("Windows PDB stream page %d is outside the file", number)
			}
		}
		streams, cursor = append(streams, current), cursor+pages(size)*4
	}
	content := func(number, keep int) ([]byte, string) {
		if len(streams) <= number || streams[number] == nil {
			return nil, ""
		}
		return read(streams[number].numbers, streams[number].size, uint64(keep), "stream")
	}
	information, failure := content(1, 32)
	switch {
	case failure != "":
		return nil, failure
	case information == nil:
		return nil, "Windows PDB information stream is missing"
	case len(information) < 32:
		return nil, "Windows PDB information stream is truncated"
	}
	guid, age := codeViewGUID(information[12:28]), field(information, 8)
	debug, failure := content(3, 12)
	switch {
	case failure != "":
		return nil, failure
	case debug != nil && len(debug) < 12:
		return nil, "Windows PDB debug information stream is truncated"
	case debug != nil && field(debug, 8) != 0:
		age = field(debug, 8)
	}
	return map[string]any{"pdbFormat": "windows_pdb", "pdbGuid": guid, "pdbAge": age,
		"pdbDebugId": fmt.Sprintf("%s_%d", guid, age)}, ""
}
