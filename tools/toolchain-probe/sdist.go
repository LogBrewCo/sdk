package main

import (
	"bytes"
	"cmp"
	"compress/flate"
	"compress/gzip"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"math/big"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	tarBlock          = 512
	tarRecord         = 20 * tarBlock
	maxTarStreamBytes = maxArchiveBytes + (maxArchiveMembers+2)*tarBlock + 10_240
	maxPyIntDigits    = 4300
	pyIntLimit        = int64(1) << 60
)

// Source archives are read the way Python's gzip and tarfile modules read
// them. A header error ends the member list quietly unless it is the first
// header; a fatal error rejects the archive.
var (
	errGzip         = errors.New("invalid gzip stream")
	errTarEOF       = errors.New("end of file header")
	errTarInvalid   = errors.New("invalid header")
	errTarEmpty     = errors.New("empty header")
	errTarTruncated = errors.New("truncated header")
	errTarRead      = errors.New("unreadable source archive")
	errTarEntries   = errors.New("invalid source archive entries")
)

// tarMember is a source archive member: its name as raw bytes, its type,
// and where its data starts in the decompressed stream.
type tarMember struct {
	name             string
	size, mode, data int64
	kind             byte
}

func (member tarMember) regular() bool { return slices.Contains([]byte("0\x007S"), member.kind) }

func (member tarMember) supported() bool {
	return slices.Contains([]byte("0\x0012567348LKS"), member.kind)
}

// contents returns a member's data, which must lie inside the stream.
func (member tarMember) contents(stream []byte) ([]byte, error) {
	if member.size == 0 {
		return nil, nil
	}
	if member.data+member.size > int64(len(stream)) {
		return nil, errTarRead
	}
	return stream[member.data : member.data+member.size], nil
}

// gunzip decompresses every gzip member and skips zero padding between them.
// The header CRC is not checked; the trailer CRC and length are.
func gunzip(data []byte, limit int) ([]byte, error) {
	var output bytes.Buffer
	source := bytes.NewReader(data)
	exact := func(count int) []byte {
		buffer := make([]byte, count)
		if _, err := io.ReadFull(source, buffer); err != nil {
			return nil
		}
		return buffer
	}
	for {
		magic := make([]byte, 2)
		if count, _ := io.ReadFull(source, magic); count == 0 {
			return output.Bytes(), nil
		}
		header := exact(8)
		if !bytes.Equal(magic, []byte{0x1f, 0x8b}) || header == nil || header[0] != 8 {
			return nil, errGzip
		}
		if header[1]&4 != 0 {
			length := exact(2)
			if length == nil || exact(int(binary.LittleEndian.Uint16(length))) == nil {
				return nil, errGzip
			}
		}
		for _, flag := range []byte{8, 16} {
			for character, err := byte(1), error(nil); header[1]&flag != 0 && character != 0 && err == nil; {
				character, err = source.ReadByte()
			}
		}
		if header[1]&2 != 0 && exact(2) == nil {
			return nil, errGzip
		}
		start := output.Len()
		_, err := io.Copy(&output, io.LimitReader(flate.NewReader(source), int64(limit-start+1)))
		trailer := exact(8)
		if err != nil || output.Len() > limit || trailer == nil ||
			binary.LittleEndian.Uint32(trailer) != crc32.ChecksumIEEE(output.Bytes()[start:]) ||
			binary.LittleEndian.Uint32(trailer[4:]) != uint32(output.Len()-start) {
			return nil, errGzip
		}
		for character, err := byte(0), error(nil); character == 0 && err == nil; {
			if character, err = source.ReadByte(); err == nil && character != 0 {
				_ = source.UnreadByte()
			}
		}
	}
}

// preflightTar requires ordinary octal member sizes, data inside the stream,
// two zero blocks, and only zeros after them, within the archive limits.
func preflightTar(stream []byte) bool {
	members, total, zeros := 0, int64(0), 0
	for position := 0; ; {
		header := stream[min(position, len(stream)):min(position+tarBlock, len(stream))]
		position += tarBlock
		if len(header) != tarBlock {
			return false
		}
		if !slices.ContainsFunc(header, func(character byte) bool { return character != 0 }) {
			if zeros++; zeros == 2 {
				return !slices.ContainsFunc(stream[position:], func(character byte) bool { return character != 0 })
			}
			continue
		}
		raw := header[124:136]
		value := strings.TrimLeft(strings.TrimRight(string(raw), "\x00 "), " ")
		size, _ := strconv.ParseInt(value, 8, 64)
		zeros, members, total = 0, members+1, total+size
		if raw[0]&0x80 != 0 || value == "" || strings.Trim(value, "01234567") != "" || members > maxArchiveMembers ||
			size > maxArchiveMemberBytes || total > maxArchiveBytes {
			return false
		}
		if position += int(tarBlocks(size)); position > len(stream) {
			return false
		}
	}
}

// readSdist decompresses and checks a source archive and lists its members.
// A list failure returns errTarEntries; any other failure means the archive
// cannot be read.
func readSdist(data []byte) ([]byte, []tarMember, error) {
	stream, err := gunzip(data, maxTarStreamBytes)
	if len(data) == 0 || len(data) > maxPythonArtifactBytes || err != nil || !preflightTar(stream) {
		return nil, nil, errGzip
	}
	reader := &tarReader{stream: stream, global: map[string]string{}}
	members := []tarMember{}
	names := map[string]bool{}
	total := int64(0)
	for {
		member, err := reader.next()
		if err != nil || member == nil {
			return stream, members, err
		}
		if len(members) >= maxArchiveMembers || names[member.name] || !safeArchiveName(member.name) ||
			!member.regular() && member.kind != '5' || member.size < 0 || member.size > maxArchiveMemberBytes {
			return nil, nil, errTarEntries
		}
		members, names[member.name] = append(members, *member), true
		if member.regular() {
			if total += member.size; total > maxArchiveBytes {
				return nil, nil, errTarEntries
			}
		}
	}
}

type tarReader struct {
	global           map[string]string
	stream           []byte
	position, offset int64
}

func (reader *tarReader) read(count int64) []byte {
	start := min(reader.position, int64(len(reader.stream)))
	end := int64(len(reader.stream))
	if count >= 0 {
		end = min(end, start+count)
	}
	reader.position = end
	return reader.stream[start:end]
}

// next returns the next member, or nil after the last one.
func (reader *tarReader) next() (*tarMember, error) {
	if reader.offset != reader.position {
		if reader.offset < 0 || reader.offset > int64(len(reader.stream)) {
			return nil, errTarRead
		}
		reader.position = reader.offset
	}
	member, err := reader.member()
	switch {
	case err == nil:
		return &member, nil
	case errors.Is(err, errTarEOF):
		return nil, nil
	case reader.offset != 0 && (errors.Is(err, errTarInvalid) || errors.Is(err, errTarEmpty) ||
		errors.Is(err, errTarTruncated)):
		return nil, nil
	}
	return nil, errTarRead
}

// member reads one header and the extended headers that apply to it.
func (reader *tarReader) member() (tarMember, error) {
	member, err := tarHeader(reader.read(tarBlock))
	if err != nil {
		return member, err
	}
	switch member.kind {
	case 'L', 'K':
		name := reader.read(tarBlocks(member.size))
		next, err := reader.member()
		if err != nil {
			return next, errTarRead
		}
		if member.kind == 'L' {
			next.name, _, _ = strings.Cut(string(name), "\x00")
		}
		if next.kind == '5' {
			next.name = strings.TrimSuffix(next.name, "/")
		}
		return next, nil
	case 'x', 'g', 'X':
		return reader.pax(member)
	}
	member.data = reader.position
	reader.offset = member.data
	if member.regular() || !member.supported() {
		reader.offset += tarBlocks(member.size)
	}
	err = member.apply(reader.global)
	if member.kind == '5' {
		member.name = strings.TrimRight(member.name, "/")
	}
	return member, err
}

// pax applies an extended header to the next member, or a global header to
// every later member.
func (reader *tarReader) pax(header tarMember) (tarMember, error) {
	buffer := reader.read(tarBlocks(header.size))
	headers := map[string]string{}
	if header.kind == 'g' {
		headers = reader.global
	}
	records := [][2]string{}
	for position := 0; position < len(buffer) && buffer[position] != 0; {
		digits := position
		for digits < len(buffer) && digits-position <= 20 && '0' <= buffer[digits] && buffer[digits] <= '9' {
			digits++
		}
		length, err := strconv.Atoi(string(buffer[position:digits]))
		end := position + length - 1
		if digits == position || digits-position > 20 || digits == len(buffer) || buffer[digits] != ' ' ||
			err != nil || length < 5 || position+length > len(buffer) {
			return header, errTarInvalid
		}
		key, value, found := strings.Cut(string(buffer[min(digits+1, end):end]), "=")
		if key == "" || !found || buffer[end] != '\n' {
			return header, errTarInvalid
		}
		records, position = append(records, [2]string{key, value}), position+length
	}
	if header.kind != 'g' {
		for key, value := range reader.global {
			headers[key] = value
		}
	}
	for _, record := range records {
		headers[record[0]] = record[1]
	}
	next, err := reader.member()
	_, sparseMap := headers["GNU.sparse.map"]
	_, sparseSize := headers["GNU.sparse.size"]
	if err != nil || sparseMap || sparseSize || headers["GNU.sparse.major"] == "1" && headers["GNU.sparse.minor"] == "0" {
		return next, errTarRead
	}
	if header.kind != 'g' {
		err = next.apply(headers)
		if _, found := headers["size"]; found {
			reader.offset = next.data
			if next.regular() || !next.supported() {
				reader.offset += tarBlocks(next.size)
			}
		}
	}
	return next, err
}

// apply sets the path and size that extended headers give; GNU sparse
// members are not supported.
func (member *tarMember) apply(headers map[string]string) error {
	for key, value := range headers {
		switch key {
		case "GNU.sparse.name", "GNU.sparse.size", "GNU.sparse.realsize":
			return errTarRead
		case "path":
			member.name = strings.TrimRight(value, "/")
		case "size":
			member.size, _ = pyInt(value, 10, false)
		}
	}
	return nil
}

// tarHeader parses one header block the way tarfile.TarInfo.frombuf does.
func tarHeader(block []byte) (tarMember, error) {
	switch {
	case len(block) == 0:
		return tarMember{}, errTarEmpty
	case len(block) != tarBlock:
		return tarMember{}, errTarTruncated
	case !slices.ContainsFunc(block, func(character byte) bool { return character != 0 }):
		return tarMember{}, errTarEOF
	}
	unsigned, signed := int64(256), int64(256)
	for index, character := range block {
		if index < 148 || index >= 156 {
			unsigned, signed = unsigned+int64(character), signed+int64(int8(character))
		}
	}
	numbers := []int64{}
	valid := true
	for _, field := range [][2]int{{148, 156}, {100, 108}, {108, 116}, {116, 124}, {124, 136}, {136, 148}, {329, 337}, {337, 345}} {
		number, ok := tarNumber(block[field[0]:field[1]])
		numbers, valid = append(numbers, number), valid && ok
	}
	if !valid || numbers[0] != unsigned && numbers[0] != signed {
		return tarMember{}, errTarInvalid
	}
	member := tarMember{name: tarString(block[:100]), mode: numbers[1], size: numbers[4], kind: block[156]}
	if member.kind == 0 && strings.HasSuffix(member.name, "/") {
		member.kind = '5'
	}
	if member.kind == 'S' {
		for at := 386; at < 482; at += 12 {
			if _, ok := tarNumber(block[at : at+12]); !ok {
				return member, errTarInvalid
			}
		}
		if _, ok := tarNumber(block[483:495]); !ok {
			return member, errTarInvalid
		}
		return member, errTarRead
	}
	if member.kind == '5' {
		member.name = strings.TrimRight(member.name, "/")
	}
	if prefix := tarString(block[345:500]); prefix != "" && member.kind != 'L' && member.kind != 'K' {
		member.name = prefix + "/" + member.name
	}
	return member, nil
}

func tarString(field []byte) string {
	text, _, _ := strings.Cut(string(field), "\x00")
	return text
}

// tarNumber reads an octal or base-256 number field, saturating values that
// do not fit.
func tarNumber(field []byte) (int64, bool) {
	if field[0] == 0x80 || field[0] == 0xff {
		number := new(big.Int).SetBytes(field[1:])
		if field[0] == 0xff {
			number.Sub(number, new(big.Int).Lsh(big.NewInt(1), uint(8*(len(field)-1))))
		}
		if number.CmpAbs(big.NewInt(pyIntLimit)) > 0 {
			return int64(number.Sign()) * pyIntLimit, true
		}
		return number.Int64(), true
	}
	text := tarString(field)
	if slices.ContainsFunc([]byte(text), func(character byte) bool { return character >= utf8.RuneSelf }) {
		return 0, false
	}
	return pyInt(text, 8, true)
}

// pyInt parses text the way Python's int(text, base) does: surrounding
// whitespace, a sign, an "0o" prefix in base 8, single underscores between
// digits, and any Unicode decimal digit. Empty text is 0 when emptyZero is
// set. Values that do not fit saturate, and invalid text is 0.
func pyInt(text string, base int64, emptyZero bool) (int64, bool) {
	var ascii strings.Builder
	for _, character := range text {
		switch {
		case unicode.IsDigit(character):
			start := character
			for unicode.IsDigit(start - 1) {
				start--
			}
			ascii.WriteByte(byte('0' + (character-start)%10))
		case unicode.IsSpace(character) || 0x1c <= character && character <= 0x1f || character == ' ':
			ascii.WriteByte(' ')
		case character >= utf8.RuneSelf:
			return 0, false
		default:
			ascii.WriteRune(character)
		}
	}
	text = strings.Trim(ascii.String(), " ")
	if text == "" {
		return 0, emptyZero
	}
	sign := map[byte]int64{'-': -1}[text[0]]
	if sign != 0 || text[0] == '+' {
		text = text[1:]
	}
	if base == 8 && len(text) > 1 && text[0] == '0' && text[1]|0x20 == 'o' {
		text = strings.TrimPrefix(text[2:], "_")
	}
	value, count, underscore := int64(0), 0, true
	for _, character := range text {
		digit := int64(character - '0')
		switch {
		case character == '_' && !underscore:
			underscore = true
			continue
		case digit < 0 || digit >= base:
			return 0, false
		}
		count, underscore = count+1, false
		value = min(value, pyIntLimit/base)*base + digit
	}
	if count == 0 || underscore || base == 10 && count > maxPyIntDigits {
		return 0, false
	}
	return value * cmp.Or(sign, 1), true
}

// tarBlocks rounds a byte count up to whole blocks with Python's floor division.
func tarBlocks(count int64) int64 {
	blocks := count / tarBlock
	if count%tarBlock != 0 && count > 0 {
		blocks++
	}
	return blocks * tarBlock
}

// pyCodePoints decodes a raw name as Python does with surrogateescape.
func pyCodePoints(text string) []rune {
	points := []rune{}
	for index := 0; index < len(text); {
		character, size := utf8.DecodeRuneInString(text[index:])
		if character == utf8.RuneError && size == 1 {
			character = 0xdc00 + rune(text[index])
		}
		points, index = append(points, character), index+size
	}
	return points
}

// normalizedTar rewrites an archive's members in name order as Python's
// tarfile writes a pax archive: fixed owner, the source date as every
// modification time, and permission bits only.
func normalizedTar(stream []byte, members []tarMember, epoch int64) ([]byte, error) {
	slices.SortFunc(members, func(left, right tarMember) int {
		return slices.Compare(pyCodePoints(left.name), pyCodePoints(right.name))
	})
	var archive bytes.Buffer
	for _, member := range members {
		name, kind, data := strings.TrimSuffix(member.name, "/")+"/", byte('5'), []byte(nil)
		if member.regular() {
			var err error
			name, kind = member.name, '0'
			if data, err = member.contents(stream); err != nil {
				return nil, err
			}
		}
		points := pyCodePoints(name)
		if len(points) > 100 || slices.ContainsFunc(points, func(point rune) bool { return point >= utf8.RuneSelf }) {
			records := paxRecord("path", name)
			if !utf8.ValidString(name) {
				records = "21 hdrcharset=BINARY\n" + records
			}
			archive.Write(tarHeaderBlock("././@PaxHeader", 0, int64(len(records)), 0, 'x'))
			archive.WriteString(records)
			archive.Write(make([]byte, tarBlocks(int64(len(records)))-int64(len(records))))
		}
		ascii := []byte{}
		for _, point := range points {
			if point >= utf8.RuneSelf {
				point = '?'
			}
			ascii = append(ascii, byte(point))
		}
		archive.Write(tarHeaderBlock(string(ascii[:min(len(ascii), 100)]), member.mode&0o777, int64(len(data)), epoch, kind))
		archive.Write(data)
		archive.Write(make([]byte, tarBlocks(int64(len(data)))-int64(len(data))))
	}
	archive.Write(make([]byte, 2*tarBlock))
	archive.Write(make([]byte, (tarRecord-archive.Len()%tarRecord)%tarRecord))
	return archive.Bytes(), nil
}

// gzipSdist compresses a stream with the source date as its timestamp.
func gzipSdist(stream []byte, epoch int64) []byte {
	var compressed bytes.Buffer
	writer, _ := gzip.NewWriterLevel(&compressed, gzip.BestCompression)
	writer.ModTime = time.Unix(epoch, 0)
	_, _ = writer.Write(stream)
	_ = writer.Close()
	return compressed.Bytes()
}

// paxRecord writes "length keyword=value\n", where length counts itself.
func paxRecord(keyword, value string) string {
	length := len(keyword) + len(value) + 3
	total := 0
	for next := length + 1; next != total; next = length + len(strconv.Itoa(next)) {
		total = next
	}
	return strconv.Itoa(total) + " " + keyword + "=" + value + "\n"
}

func tarHeaderBlock(name string, mode, size, mtime int64, kind byte) []byte {
	block := make([]byte, tarBlock)
	copy(block, name)
	for _, field := range []struct {
		at, digits int
		value      int64
	}{{100, 8, mode}, {108, 8, 0}, {116, 8, 0}, {124, 12, size}, {136, 12, mtime}} {
		copy(block[field.at:], fmt.Sprintf("%0*o\x00", field.digits-1, field.value))
	}
	copy(block[148:], "        ")
	block[156] = kind
	copy(block[257:], "ustar\x0000")
	checksum := 0
	for _, character := range block {
		checksum += int(character)
	}
	copy(block[148:], fmt.Sprintf("%06o\x00", checksum))
	return block
}
