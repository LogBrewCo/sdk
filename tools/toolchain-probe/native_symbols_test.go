package main

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"encoding/binary"
	"slices"
	"strings"
	"testing"
)

const (
	fixtureGUID     = "00112233-4455-6677-8899-AABBCCDDEEFF"
	fixtureDebugID  = fixtureGUID + "_42"
	fixturePDBPath  = `C:\Users\dev\checkout.pdb`
	fixtureBreakpad = "MODULE windows x86 00112233445566778899AABBCCDDEEFF2A checkout.pdb\nFILE 0 a.cpp\n"
)

type byteOrder interface {
	binary.ByteOrder
	binary.AppendByteOrder
}

type elfSection struct {
	name  string
	kind  uint32
	data  []byte
	align uint64
}

// elfFixture builds an ELF file with the sections plus a section name table.
func elfFixture(wide bool, order byteOrder, machine uint16, sections ...elfSection) []byte {
	sections = append(append([]elfSection{{}}, sections...), elfSection{name: ".shstrtab", kind: 3, align: 1})
	names, nameOffsets := []byte{0}, make([]int, len(sections))
	for index := 1; index < len(sections); index++ {
		nameOffsets[index], names = len(names), append(append(names, sections[index].name...), 0)
	}
	sections[len(sections)-1].data = names
	headerSize, entrySize := 52, 40
	if wide {
		headerSize, entrySize = 64, 64
	}
	body, positions := make([]byte, headerSize), make([]int, len(sections))
	for index, section := range sections[1:] {
		positions[index+1] = len(body)
		if section.kind != 8 {
			body = append(body, section.data...)
		}
	}
	table := len(body)
	word := func(buffer []byte, value int) []byte {
		if wide {
			return order.AppendUint64(buffer, uint64(value))
		}
		return order.AppendUint32(buffer, uint32(value))
	}
	header := append([]byte("\x7fELF"), map[bool]byte{false: 1, true: 2}[wide], 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0)
	if order == byteOrder(binary.BigEndian) {
		header[5] = 2
	}
	header = order.AppendUint32(order.AppendUint16(order.AppendUint16(header, 3), machine), 1)
	header = word(word(word(header, 0), 0), table)
	header = order.AppendUint32(header, 0)
	for _, value := range []int{headerSize, 0, 0, entrySize, len(sections), len(sections) - 1} {
		header = order.AppendUint16(header, uint16(value))
	}
	copy(body, header)
	for index, section := range sections {
		body = order.AppendUint32(order.AppendUint32(body, uint32(nameOffsets[index])), section.kind)
		body = word(word(word(word(body, 0), 0), positions[index]), len(section.data))
		body = word(order.AppendUint32(order.AppendUint32(body, 0), 0), int(section.align))
		body = word(body, 0)
	}
	return body
}

func elfNote(order byteOrder, name string, kind uint32, desc []byte) []byte {
	note := order.AppendUint32(order.AppendUint32(order.AppendUint32(nil, uint32(len(name))), uint32(len(desc))), kind)
	note = append(note, name...)
	note = append(note, make([]byte, alignUp(uint64(len(note)), 4)-uint64(len(note)))...)
	return append(note, desc...)
}

// androidELF is the 64-bit little-endian arm64 symbol file the smoke checks use.
func androidELF() []byte {
	order := binary.LittleEndian
	return elfFixture(true, order, 183,
		elfSection{".note.gnu.build-id", 7, elfNote(order, "GNU\x00", 3, []byte{0x32, 0xcc, 0x7f, 0x54}), 4},
		elfSection{".debug_info", 1, []byte("debug"), 1}, elfSection{".symtab", 2, make([]byte, 24), 8},
		elfSection{".text", 1, []byte{0xc0, 0x03, 0x5f, 0xd6}, 16})
}

func machoCommand(order byteOrder, kind, length uint32, payload []byte) []byte {
	return append(order.AppendUint32(order.AppendUint32(nil, kind), length), payload...)
}

func machoFixture(order byteOrder, wide bool, cpu uint32, commands ...[]byte) []byte {
	joined := bytes.Join(commands, nil)
	magic := map[bool]uint32{false: 0xfeedface, true: 0xfeedfacf}[wide]
	header := order.AppendUint32(nil, magic)
	for _, value := range []uint32{cpu, 0, 10, uint32(len(commands)), uint32(len(joined)), 0} {
		header = order.AppendUint32(header, value)
	}
	if wide {
		header = order.AppendUint32(header, 0)
	}
	return append(append(header, joined...), "tail"...)
}

func uuidMacho() []byte {
	order := binary.LittleEndian
	return machoFixture(order, true, 0x0100000c, machoCommand(order, 1, 8, nil),
		machoCommand(order, 0x1b, 24, []byte("\xc8\x46\x9f\x85\xb0\x60\x30\x85\xb6\x9d\xe4\x6c\x64\x55\x60\xea")))
}

func fatFixture(order byteOrder, wide bool, slices ...[]byte) []byte {
	entrySize := map[bool]int{false: 20, true: 32}[wide]
	fat := order.AppendUint32(binary.BigEndian.AppendUint32(nil, map[bool]uint32{false: 0xcafebabe, true: 0xcafebabf}[wide]),
		uint32(len(slices)))
	if order == byteOrder(binary.LittleEndian) {
		fat = append(binary.LittleEndian.AppendUint32(nil, binary.BigEndian.Uint32(fat)), fat[4:]...)
	}
	offset, body := 8+entrySize*len(slices), []byte{}
	for _, slice := range slices {
		fat = order.AppendUint32(order.AppendUint32(fat, 0), 0)
		if wide {
			fat = order.AppendUint32(order.AppendUint32(order.AppendUint64(order.AppendUint64(fat,
				uint64(offset+len(body))), uint64(len(slice))), 0), 0)
		} else {
			fat = order.AppendUint32(order.AppendUint32(order.AppendUint32(fat, uint32(offset+len(body))), uint32(len(slice))), 0)
		}
		body = append(body, slice...)
	}
	return append(fat, body...)
}

func guidBytes(guid string) []byte {
	parts := strings.Split(guid, "-")
	data := make([]byte, 0, 16)
	for index, part := range parts {
		raw := make([]byte, len(part)/2)
		for at := range raw {
			raw[at] = byte(strings.Index("0123456789ABCDEF", part[2*at:2*at+1])<<4 | strings.Index("0123456789ABCDEF", part[2*at+1:2*at+2]))
		}
		if index < 3 {
			slices.Reverse(raw)
		}
		data = append(data, raw...)
	}
	return data
}

func codeView(guid string, age uint32, path string) []byte {
	return append(binary.LittleEndian.AppendUint32(append([]byte("RSDS"), guidBytes(guid)...), age), path+"\x00"...)
}

func embeddedPDB(payload []byte, size int) []byte {
	var compressed bytes.Buffer
	writer, _ := flate.NewWriter(&compressed, flate.DefaultCompression)
	_, _ = writer.Write(payload)
	_ = writer.Close()
	return append(binary.LittleEndian.AppendUint32([]byte("MPDB"), uint32(size)), compressed.Bytes()...)
}

// peFixture builds a PE file whose debug directory lists the blobs by type.
func peFixture(magic uint16, blobs ...[]any) []byte {
	debug, payloads := []byte{}, []byte{}
	offset := 0x200 + 28*len(blobs)
	for _, blob := range blobs {
		data := blob[1].([]byte)
		debug = append(debug, make([]byte, 12)...)
		for _, value := range []int{blob[0].(int), len(data), 0x1000 + offset - 0x200, offset} {
			debug = binary.LittleEndian.AppendUint32(debug, uint32(value))
		}
		payloads, offset = append(payloads, data...), offset+len(data)
	}
	section := append(debug, payloads...)
	file := make([]byte, 0x200+max(0x200, len(section)))
	copy(file, "MZ")
	binary.LittleEndian.PutUint32(file[0x3c:], 0x80)
	copy(file[0x80:], "PE\x00\x00")
	binary.LittleEndian.PutUint16(file[0x84:], 0x8664)
	binary.LittleEndian.PutUint16(file[0x86:], 1)
	binary.LittleEndian.PutUint16(file[0x94:], 240)
	binary.LittleEndian.PutUint16(file[0x98:], magic)
	directory := 0x98 + map[uint16]int{0x10b: 96}[magic] + map[bool]int{true: 112}[magic != 0x10b] + 48
	if len(blobs) > 0 {
		binary.LittleEndian.PutUint32(file[directory:], 0x1000)
	}
	binary.LittleEndian.PutUint32(file[directory+4:], uint32(len(debug)))
	header := 0x98 + 240
	copy(file[header:], ".rdata")
	for index, value := range []int{len(section), 0x1000, max(0x200, len(section)), 0x200} {
		binary.LittleEndian.PutUint32(file[header+8+4*index:], uint32(value))
	}
	copy(file[0x200:], section)
	return file
}

func portablePDB(guid string, age uint32) []byte {
	version := []byte("LogBrew fixture v1\x00\x00")
	stream := binary.LittleEndian.AppendUint32(guidBytes(guid), age)
	stream = append(stream, make([]byte, 12)...)
	data := append([]byte("BSJB"), 1, 0, 1, 0, 0, 0, 0, 0)
	data = append(binary.LittleEndian.AppendUint32(data, uint32(len(version))), version...)
	data = append(data, 0, 0, 1, 0)
	offset := len(data) + 8 + 8
	data = binary.LittleEndian.AppendUint32(binary.LittleEndian.AppendUint32(data, uint32(offset)), uint32(len(stream)))
	return append(append(append(data, "#Pdb\x00\x00\x00\x00"...), stream...), "marker"...)
}

// classicPDB builds a Windows MSF PDB with information and DBI streams.
func classicPDB(guid string, age, dbiAge uint32) []byte {
	const pageSize = 0x400
	information := binary.LittleEndian.AppendUint32(binary.LittleEndian.AppendUint32(
		binary.LittleEndian.AppendUint32(nil, 19990903), 0x12345678), age)
	information = append(append(information, guidBytes(guid)...), 0, 0, 0, 0)
	dbi := binary.LittleEndian.AppendUint32(binary.LittleEndian.AppendUint32(
		binary.LittleEndian.AppendUint32(nil, 0xffffffff), 19990903), dbiAge)
	streams := [][]byte{{}, information, {}, append(dbi, make([]byte, 52)...), []byte("marker")}
	directory, next, pages := binary.LittleEndian.AppendUint32(nil, uint32(len(streams))), 3, [][]int{}
	for _, stream := range streams {
		directory = binary.LittleEndian.AppendUint32(directory, uint32(len(stream)))
		current := []int{}
		for range (len(stream) + pageSize - 1) / pageSize {
			current, next = append(current, next), next+1
		}
		pages = append(pages, current)
	}
	for _, current := range pages {
		for _, page := range current {
			directory = binary.LittleEndian.AppendUint32(directory, uint32(page))
		}
	}
	data := make([]byte, next*pageSize)
	copy(data, msfSignature)
	for index, value := range []int{pageSize, 1, next - 1, len(directory), 0, 1} {
		binary.LittleEndian.PutUint32(data[32+4*index:], uint32(value))
	}
	binary.LittleEndian.PutUint32(data[pageSize:], 2)
	copy(data[2*pageSize:], directory)
	for index, current := range pages {
		for at, page := range current {
			copy(data[page*pageSize:], streams[index][at*pageSize:min(len(streams[index]), (at+1)*pageSize)])
		}
	}
	return data
}

func zipFixture(t *testing.T, method uint16, members ...string) []byte {
	t.Helper()
	var archive bytes.Buffer
	writer := zip.NewWriter(&archive)
	for index := 0; index < len(members); index += 2 {
		member, err := writer.CreateHeader(&zip.FileHeader{Name: members[index], Method: method})
		if err == nil {
			_, err = member.Write([]byte(members[index+1]))
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return archive.Bytes()
}

func memoryFile(data []byte) nativeFile { return nativeFile{bytes.NewReader(data), int64(len(data))} }

func TestReadELF(t *testing.T) {
	big, little := binary.BigEndian, binary.LittleEndian
	elf32 := elfFixture(false, big, 40,
		elfSection{".note.go.buildid", 7, elfNote(big, "Go\x00\x00", 4, []byte("go\xffid")), 4},
		elfSection{".note.gnu.build-id", 7, append(elfNote(big, "XYZ\x00", 9, []byte{1}), elfNote(big, "GNU\x00", 9, []byte{2})...), 0},
		elfSection{".zdebug_info", 1, []byte("z"), 1}, elfSection{".dynsym", 11, make([]byte, 24), 8},
		elfSection{".text", 8, nil, 1})
	record, failure := readELF(memoryFile(elf32))
	if failure != "" || record["goBuildId"] != "go\ufffdid" || record["gnuBuildId"] != "02" || record["hasCode"] != false ||
		record["hasDebugInfo"] != true || record["arch"] != "armeabi-v7a" || record["elfClass"] != 32 {
		t.Fatalf("32-bit big-endian ELF = %v, %q", record, failure)
	}
	record, failure = readELF(memoryFile(androidELF()))
	if failure != "" || record["gnuBuildId"] != "32cc7f54" || record["hasCode"] != true || len(record["fileSha256"].(string)) != 64 {
		t.Fatalf("android ELF = %v, %q", record, failure)
	}
	unknown, _ := readELF(memoryFile(patched(elfFixture(true, little, 99), 16, 9)))
	if unknown["elfType"] != "unknown(9)" || unknown["arch"] != "unknown(99)" {
		t.Fatalf("unknown ELF = %v", unknown)
	}
	wrapped := elfFixture(true, little, 183, elfSection{".note.gnu.build-id", 7, elfNote(little, "GNU\x00", 3, []byte{1, 2, 3}), 1 << 63})
	if record, _ = readELF(memoryFile(wrapped)); record["gnuBuildId"] != "" {
		t.Fatalf("huge note alignment = %v", record)
	}
	base := androidELF()
	table := int(little.Uint64(base[40:]))
	for _, test := range []struct {
		data    []byte
		failure string
	}{
		{[]byte("\x7fELF"), "not an ELF file"},
		{patched(base, 4, 3), "unsupported ELF class: 3"},
		{patched(base, 5, 3), "unsupported ELF endianness: 3"},
		{patched(base, 6, 2), "unsupported ELF version: 2"},
		{base[:60], "ELF header is truncated"},
		{patched(base, 20, 2), "unsupported ELF file version: 2"},
		{patched(base, 52, 63), "unexpected ELF header size: 63"},
		{patched(base, 58, 63), "unexpected ELF section header size: 63"},
		{patched(base, 60, 0, 0), "ELF extended section tables are not supported by this dry run"},
		{patched(base, 62, 0xff, 0xff), "ELF extended section tables are not supported by this dry run"},
		{patched(base, 40, 0, 0, 0, 0, 0, 0, 0, 0), "ELF section header table is missing"},
		{base[:len(base)-1], "ELF section header table is truncated"},
		{patched(base, table+64+32, 0xff, 0xff), "ELF section data is truncated"},
		{patched(base, 62, 40), "ELF section name table index is invalid"},
		{patched(base, 62, 1), "ELF section name table is missing"},
	} {
		if _, failure := readELF(memoryFile(test.data)); failure != test.failure {
			t.Errorf("readELF failure = %q, want %q", failure, test.failure)
		}
	}
	names := patched(base, table+6*64, 0xff, 0xff)
	if record, failure = readELF(memoryFile(names)); failure != "" || record["gnuBuildId"] != "32cc7f54" {
		t.Fatalf("name offset outside the table = %v, %q", record, failure)
	}
}

func TestMachoUUIDs(t *testing.T) {
	big, little := binary.BigEndian, binary.LittleEndian
	uuid := machoCommand(big, 0x1b, 24, make([]byte, 16))
	for _, test := range []struct {
		data    []byte
		count   int
		failure string
	}{
		{uuidMacho(), 1, ""},
		{machoFixture(big, false, 5, uuid), 1, ""},
		{machoFixture(little, false, 7, machoCommand(little, 0x1b, 24, make([]byte, 16))), 1, ""},
		{machoFixture(big, true, 12, uuid), 1, ""},
		{fatFixture(big, false, uuidMacho(), machoFixture(big, true, 7, uuid)), 2, ""},
		{fatFixture(little, true, uuidMacho()), 1, ""},
		{fatFixture(big, false, []byte("bad!"), uuidMacho()), 1, ""},
		{fatFixture(big, false, []byte("bad!"), []byte("ab")), 0, "not a Mach-O object; Mach-O slice is truncated"},
		{fatFixture(big, false), 0, "fat Mach-O object has no UUIDs"},
		{patched(fatFixture(big, false, uuidMacho()), 4, 0xff), 0, "fat Mach-O architecture table is truncated"},
		{[]byte("abc"), 0, "Mach-O object is truncated"},
		{uuidMacho()[:20], 0, "Mach-O header is truncated"},
		{patched(uuidMacho(), 20, 0xff), 0, "Mach-O load commands are truncated"},
		{patched(machoFixture(little, true, 7, machoCommand(little, 1, 8, nil)), 16, 2), 0, "Mach-O load command is truncated"},
		{patched(uuidMacho(), 36, 7), 0, "Mach-O load command size is invalid"},
		{machoFixture(big, true, 7, machoCommand(big, 0x1b, 20, make([]byte, 12))), 0, "Mach-O UUID load command is truncated"},
		{machoFixture(big, true, 7), 0, "Mach-O UUID load command is missing"},
	} {
		uuids, failure := machoUUIDs(memoryFile(test.data))
		if len(uuids) != test.count || failure != test.failure {
			t.Errorf("machoUUIDs = %v, %q, want %d, %q", uuids, failure, test.count, test.failure)
		}
	}
	if uuids, _ := machoUUIDs(memoryFile(uuidMacho())); uuids[0].(map[string]any)["uuid"] != "C8469F85-B060-3085-B69D-E46C645560EA" {
		t.Fatalf("UUID = %v", uuids)
	}
	defer func() {
		if stop := recover().(nativeStop); stop.code != exitUsage || !strings.HasSuffix(stop.message, "file data is truncated") {
			t.Fatalf("stop = %v", stop)
		}
	}()
	machoUUIDs(memoryFile([]byte("\xca\xfe\xba\xbe\x00")))
}

func TestReadPE(t *testing.T) {
	codeview, portable := []any{2, codeView(fixtureGUID, 42, fixturePDBPath)}, portablePDB(fixtureGUID, 42)
	record, failure := readPE(memoryFile(peFixture(0x10b, codeview, []any{17, embeddedPDB(portable, len(portable))})))
	if failure != "" || record["peClass"] != 32 || record["pdbFileName"] != "checkout.pdb" || record["pdbDebugId"] != fixtureDebugID ||
		record["embeddedPortablePdb"].(map[string]any)["uncompressedByteSize"] != uint32(len(portable)) {
		t.Fatalf("PE32 = %v, %q", record, failure)
	}
	base := peFixture(0x20b, codeview)
	rawPointer := 0x200 + 24
	for _, test := range []struct {
		data    []byte
		failure string
	}{
		{base[:63], "PE DOS header is truncated"},
		{patched(base, 0, 'X'), "not a PE file"},
		{patched(base, 0x3c, 0xff, 0xff), "PE header is truncated"},
		{patched(base, 0x80, 'X'), "invalid PE signature"},
		{patched(base, 0x94, 100), "PE optional header is truncated"},
		{patched(base, 0x94, 0xff, 0xff), "file data is truncated"},
		{patched(base, 0x98, 1), "unsupported PE optional header magic: 513"},
		{patched(base, 0x94, 150), "PE debug directory entry is missing"},
		{peFixture(0x20b), "PE file has no CodeView PDB debug information"},
		{patched(base, 0x86, 0xff), "file data is truncated"},
		{patched(base, 0x98+240+12, 0, 0, 1), "PE debug directory points outside the file"},
		{patched(base, rawPointer, 0xff, 0xff), "PE CodeView record points outside the file"},
		{patched(base, 0x200+28, 'X'), "PE CodeView record is not PDB70/RSDS"},
		{peFixture(0x20b, []any{9, []byte("x")}), "PE file has no CodeView PDB debug information"},
		{peFixture(0x20b, codeview, []any{17, []byte("MPDB")}), "embedded Portable PDB debug data is truncated"},
		{peFixture(0x20b, codeview, []any{17, []byte("XPDB0000")}), "embedded Portable PDB signature is invalid"},
		{peFixture(0x20b, codeview, []any{17, append([]byte("MPDB"), 0, 0, 0, 0x10)}),
			"embedded Portable PDB is 268435456 bytes when decompressed; maximum is 67108864 bytes"},
		{peFixture(0x20b, codeview, []any{17, append([]byte("MPDB\x01\x00\x00\x00"), 0xff)}), "embedded Portable PDB could not be decompressed"},
		{peFixture(0x20b, codeview, []any{17, embeddedPDB(portablePDB(fixtureGUID, 42), 5)}),
			"embedded Portable PDB decompressed size does not match its header"},
		{peFixture(0x20b, codeview, []any{17, embeddedPDB([]byte("BSJB"), 4)}), "embedded Portable PDB metadata root is truncated"},
		{peFixture(0x20b, codeview, []any{17, embeddedPDB(classicPDB(fixtureGUID, 1, 1), len(classicPDB(fixtureGUID, 1, 1)))}),
			"embedded Portable PDB payload is not a Portable PDB"},
	} {
		if _, failure := readPE(memoryFile(test.data)); failure != test.failure {
			t.Errorf("readPE failure = %q, want %q", failure, test.failure)
		}
	}
	outside := peFixture(0x20b, codeview, []any{17, embeddedPDB(portable, len(portable))})
	binary.LittleEndian.PutUint32(outside[0x200+28+24:], 0)
	binary.LittleEndian.PutUint32(outside[0x200+28+20:], 0xffffff)
	if _, failure := readPE(memoryFile(outside)); failure != "embedded Portable PDB record points outside the file" {
		t.Fatalf("embedded outside = %q", failure)
	}
	for _, address := range []uint32{0x1000 + 28, 0x200 + 28} {
		mapped := patched(base, rawPointer, 0, 0, 0, 0)
		binary.LittleEndian.PutUint32(mapped[rawPointer-4:], address)
		if record, failure = readPE(memoryFile(mapped)); failure != "" {
			t.Fatalf("RVA %#x = %v, %q", address, record, failure)
		}
	}
	unknown, _ := readPE(memoryFile(patched(base, 0x84, 1, 2)))
	if unknown["arch"] != "unknown(513)" {
		t.Fatalf("unknown machine = %v", unknown)
	}
}

func TestReadPDB(t *testing.T) {
	if record, _ := readPDB([]byte("junk")); record["pdbFormat"] != "unrecognized" {
		t.Fatalf("unrecognized = %v", record)
	}
	for _, test := range []struct {
		age, dbi uint32
		debugID  string
	}{{42, 42, fixtureDebugID}, {42, 0, fixtureDebugID}, {42, 7, fixtureGUID + "_7"}} {
		if record, failure := readPDB(classicPDB(fixtureGUID, test.age, test.dbi)); record["pdbDebugId"] != test.debugID || failure != "" {
			t.Errorf("classic PDB = %v, %q", record, failure)
		}
	}
	portable, classic := portablePDB(fixtureGUID, 42), classicPDB(fixtureGUID, 42, 42)
	streams := 0x800 + 4
	missingDBI := patched(classic, streams+12, 0xff, 0xff, 0xff, 0xff)
	if record, failure := readPDB(missingDBI); record["pdbDebugId"] != fixtureDebugID || failure != "" {
		t.Fatalf("classic PDB without DBI = %v, %q", record, failure)
	}
	for _, test := range []struct {
		data    []byte
		failure string
	}{
		{portable[:10], "Portable PDB metadata root is truncated"},
		{patched(portable, 12, 0xff), "Portable PDB metadata root is truncated"},
		{patched(portable, 38, 0), "Portable PDB stream directory is empty"},
		{patched(portable, 38, 65), "Portable PDB stream directory has 65 streams; maximum is 64"},
		{portable[:44], "Portable PDB stream header is truncated"},
		{portable[:52], "Portable PDB stream name is unterminated"},
		{portable[:53], "Portable PDB stream header is truncated"},
		{patched(portable, 48, 0xff), "Portable PDB stream name is not UTF-8"},
		{patched(portable, 48, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)[:52],
			"Portable PDB stream <empty> points outside the file"},
		{patched(portable, 44, 0xff), "Portable PDB stream #Pdb points outside the file"},
		{patched(portable, 44, 31), "Portable PDB #Pdb stream is truncated"},
		{patched(portable, 49, 'X'), "Portable PDB #Pdb stream is missing"},
		{classic[:51], "Windows PDB MSF header is truncated"},
		{patched(classic, 32, 1, 3), "Windows PDB page size is invalid: 769"},
		{patched(classic, 44, 0, 0), "Windows PDB stream directory is empty"},
		{patched(classic, 44, 0, 0, 0, 2), "Windows PDB stream directory is 33554432 bytes; maximum is 16777216 bytes"},
		{patched(classic, 32, 0, 0, 0x80), "Windows PDB page size is larger than the file"},
		{patched(patched(classic, 32, 0, 1), 44, 0, 0, 0, 1), "Windows PDB stream directory page list is truncated"},
		{patched(classic, 52, 0), "Windows PDB stream directory page-list page 0 is outside the file"},
		{patched(classic, 1024, 0), "Windows PDB stream directory page 0 is outside the file"},
		{classic[:1024+512], "Windows PDB stream directory page-list page 1 is truncated"},
		{patched(classic, 1024, 99), "Windows PDB stream directory page 99 is outside the file"},
		{patched(classic, 44, 3), "Windows PDB stream directory is truncated"},
		{patched(classic, 0x800, 0xff, 0xff, 1), "Windows PDB stream directory has 131071 streams; maximum is 65535"},
		{patched(classic, 0x800, 9), "Windows PDB stream directory is truncated"},
		{patched(classic, streams+16, 0xff, 0xff), "Windows PDB stream directory page references are truncated"},
		{patched(classic, streams+20, 99), "Windows PDB stream page 99 is outside the file"},
		{classic[:3*1024], "Windows PDB stream page 3 is truncated"},
		{patched(classic, 0x800, 1), "Windows PDB information stream is missing"},
		{patched(classic, streams+4, 0xff, 0xff, 0xff, 0xff), "Windows PDB information stream is missing"},
		{patched(classic, streams+4, 31), "Windows PDB information stream is truncated"},
		{classic[:4*1024], "Windows PDB stream page 4 is truncated"},
		{patched(classic, streams+12, 11), "Windows PDB debug information stream is truncated"},
	} {
		if _, failure := readPDB(test.data); failure != test.failure {
			t.Errorf("readPDB failure = %q, want %q", failure, test.failure)
		}
	}
}

func TestNativeFileReadFailure(t *testing.T) {
	if data := (nativeFile{bytes.NewReader(nil), 4}).at(0, 4); data != nil {
		t.Fatalf("failed read = %q", data)
	}
}

func TestNativeZipNames(t *testing.T) {
	path := writeTempFile(t, zipFixture(t, zip.Store, "a/", "", "./x//y", "1", "a/../b", "", `a\b`, "", "C:/x", "", "/abs", "",
		".", "", "", "", "x/y", "2"))
	entries, failures := nativeZip(path, "Archive")
	if !slices.Equal(slices.Sorted(mapKeys(entries)), []string{"x/y"}) || nativeRead(entries["x/y"])[0] != '2' ||
		!slices.Equal(failures, []string{"Archive contains unsafe entry paths"}) {
		t.Fatalf("entries = %v, %v", entries, failures)
	}
	if _, failures = nativeZip(writeTempFile(t, []byte("not a zip")), "Archive"); failures[0] != "Archive is not a valid ZIP file" {
		t.Fatalf("invalid archive = %v", failures)
	}
	large := strings.Repeat("x", 5000)
	entries, _ = nativeZip(writeTempFile(t, zipFixture(t, zip.Deflate, "big", large, "small", "{}")), "Archive")
	if string(nativeHead(entries["big"])) != large[:4096] || string(nativeHead(entries["small"])) != "{}" {
		t.Fatal("head reads differ")
	}
	for _, read := range []func(zipEntry){func(entry zipEntry) { nativeRead(entry) }, func(entry zipEntry) { nativeHead(entry) }} {
		broken := entries["big"]
		broken.header++
		func() {
			defer func() {
				if stop := recover().(nativeStop); stop.code != exitFailure {
					t.Fatalf("stop = %v", stop)
				}
			}()
			read(broken)
		}()
	}
}

func TestReadBreakpad(t *testing.T) {
	record, failure := readBreakpad(writeTempFile(t, []byte("\n \x1c\nMODULE windows\x1f  AMD64 "+
		"00112233445566778899aabbccddeeff2a1 dir\\a b/\r\nINFO x\nPUBLIC 1 0 f\n")))
	if failure != "" || record["arch"] != "x86_64" || record["age"].(interface{ String() string }).String() != "673" ||
		record["moduleName"] != "a b" || record["symbolSource"] != "symbol_table" || record["guid"] != fixtureGUID {
		t.Fatalf("breakpad = %v, %q", record, failure)
	}
	if record, _ = readBreakpad(writeTempFile(t, []byte(fixtureBreakpad))); record["symbolSource"] != "debug_info" {
		t.Fatalf("FILE records = %v", record)
	}
	if record, _ = readBreakpad(writeTempFile(t, []byte("MODULE linux mips 00112233445566778899AABBCCDDEEFF2A x/\nFUNC"))); record["arch"] != "unknown(mips)" ||
		record["moduleName"] != "x" {
		t.Fatalf("unknown CPU = %v", record)
	}
	if record, _ = readBreakpad(writeTempFile(t, []byte("MODULE linux x86 00112233445566778899AABBCCDDEEFF2A /"))); record["moduleName"] != "unknown" {
		t.Fatalf("empty module name = %v", record)
	}
	for text, want := range map[string]string{
		"\n  \n":               "Breakpad symbol file is missing MODULE header",
		"MODULE a b c\xff d\n": "Breakpad .sym files must be ASCII encoded",
		"INFO x\n":             "first non-empty line must be a Breakpad MODULE header",
		"MODULE a b c\n":       "Breakpad MODULE header is malformed",
		"MODULE a b 0011 d\n":  "Breakpad MODULE identifier must contain GUID and age",
		"MODULE a b " + strings.Repeat("G", 33) + " d\n": "Breakpad MODULE identifier must be hexadecimal",
	} {
		if _, failure := readBreakpad(writeTempFile(t, []byte(text))); failure != want {
			t.Errorf("readBreakpad(%q) = %q, want %q", text, failure, want)
		}
	}
}

func TestPythonText(t *testing.T) {
	if got := pyUTF8([]byte("a\xe2\x82b\xf0\x90\x80\xed\xa0\x80\xf4\x90\xc2\xe0\xa0\xff\xe2\x82\xac")); got != "a\ufffdb\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd€" {
		t.Fatalf("pyUTF8 = %q", got)
	}
	if got := pySplitLines("a\r\nb\rc\u2028d\x1fe\nf"); !slices.Equal(got, []string{"a", "b", "c", "d\x1fe", "f"}) {
		t.Fatalf("pySplitLines = %q", got)
	}
	for name, suffix := range map[string]string{"a.dll": ".dll", ".dll": "", "a.": "", "a": "", "x/b.c.sym": ".sym"} {
		if got := pySuffix(name); got != suffix {
			t.Errorf("pySuffix(%q) = %q, want %q", name, got, suffix)
		}
	}
}
