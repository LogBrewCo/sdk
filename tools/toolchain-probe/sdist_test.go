package main

import (
	"bytes"
	"compress/gzip"
	"errors"
	"strings"
	"testing"
)

func TestGunzip(t *testing.T) {
	var named bytes.Buffer
	writer := gzip.NewWriter(&named)
	writer.Name, writer.Comment, writer.Extra = "a.tar", "comment", []byte("xy")
	_, _ = writer.Write([]byte("first"))
	_ = writer.Close()
	plain := gzipSdist([]byte("second"), 0)
	checked := append(append(bytes.Clone(plain[:10]), 0, 0), plain[10:]...)
	checked[3] |= 2
	for _, test := range []struct {
		data   []byte
		output string
		ok     bool
	}{
		{nil, "", true},
		{append(append(named.Bytes(), 0, 0, 0), plain...), "firstsecond", true},
		{append(bytes.Clone(plain), 0, 0), "second", true},
		{checked, "second", true},
		{plain[:1], "", false},
		{plain[:9], "", false},
		{patched(plain, 2, 7), "", false},
		{patched(plain, 1, 0), "", false},
		{append(bytes.Clone(plain[:10]), 0), "", false},
		{patched(plain[:10], 3, 4), "", false},
		{append(patched(plain[:10], 3, 4), 9, 0, 1), "", false},
		{patched(plain[:10], 3, 2), "", false},
		{patched(plain[:10], 3, 8), "", false},
		{plain[:len(plain)-1], "", false},
		{flipped(plain, len(plain)-8), "", false},
		{flipped(plain, len(plain)-1), "", false},
		{append(bytes.Clone(plain), 0, 1), "", false},
	} {
		output, err := gunzip(test.data, 100)
		if test.ok != (err == nil) || string(output) != test.output {
			t.Errorf("%x: %q %v", test.data, output, err)
		}
	}
	if _, err := gunzip(plain, 5); err == nil {
		t.Error("limit ignored")
	}
}

func TestPreflightTar(t *testing.T) {
	valid := tarStream(tarEntry{"a", "data", '0'})
	sized := func(size string) []byte {
		block := tarHeaderBlock("a", 0o644, 0, 0, '0')
		copy(block[124:136], size)
		return append(checksummed(block), make([]byte, 1024)...)
	}
	for _, test := range []struct {
		stream []byte
		ok     bool
	}{
		{valid, true},
		{append(bytes.Clone(valid), make([]byte, tarRecord)...), true},
		{sized(" 0 \x00\x00\x00\x00\x00\x00\x00\x00\x00"), true},
		{valid[:len(valid)-1], false},
		{append(bytes.Clone(valid), 1), false},
		{valid[:tarBlock], false},
		{sized("\x80\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x01"), false},
		{sized("\x00"), false},
		{sized("+1\x00"), false},
		{sized("1000\x00"), false},
		{sized("40000001\x00"), false},
		{sized("4\x00"), false},
	} {
		if preflightTar(test.stream) != test.ok {
			t.Errorf("%q: expected %v", test.stream[:min(len(test.stream), 140)], test.ok)
		}
	}
	many := bytes.Repeat(tarStream(tarEntry{"a", "", '0'})[:tarBlock], maxArchiveMembers+1)
	if preflightTar(append(many, make([]byte, 1024)...)) {
		t.Error("member limit ignored")
	}
	large := []byte{}
	for range 5 {
		block := tarHeaderBlock("a", 0o644, maxArchiveMemberBytes, 0, '0')
		large = append(append(large, block...), make([]byte, maxArchiveMemberBytes)...)
	}
	if preflightTar(append(large, make([]byte, 1024)...)) {
		t.Error("size limit ignored")
	}
}

func readTarStream(stream []byte) ([]string, error) {
	_, members, err := readSdist(gzipSdist(stream, 0))
	names := []string{}
	for _, member := range members {
		names = append(names, member.name+":"+string(member.kind)+":"+itoaOctal(int(member.size)))
	}
	return names, err
}

func TestReadSdist(t *testing.T) {
	invalidChecksum := tarHeaderBlock("b", 0o644, 0, 0, '0')
	invalidChecksum[150] = '9'
	sparse := tarHeaderBlock("s", 0o644, 0, 0, 'S')
	sparseBadField, sparseBadSize := bytes.Clone(sparse), bytes.Clone(sparse)
	copy(sparseBadField[386:], "zz")
	copy(sparseBadSize[483:], "zz")
	signed := tarHeaderBlock("c", 0o644, 0, 0, '0')
	copy(signed[148:], "\xff\xff\xff\xff\xff\xff\xff\xff")
	for _, test := range []struct {
		stream []byte
		names  []string
		err    error
	}{
		{tarStream(tarEntry{"a", "1", '0'}, tarEntry{"d/", "", 0}, tarEntry{"e", "", '5'}),
			[]string{"a:0:1", "d:5:", "e:5:"}, nil},
		{tarStream(tarEntry{"././@LongLink", "long/name\x00x", 'L'}, tarEntry{"short", "12", '0'},
			tarEntry{"././@LongLink", "dir//", 'L'}, tarEntry{"x", "", '5'},
			tarEntry{"././@LongLink", "target", 'K'}, tarEntry{"k", "", '0'}),
			[]string{"long/name:0:2", "dir/:5:", "k:0:"}, nil},
		{tarStream(paxEntry('x', "path=p/q/", "comment=c"), tarEntry{"a", "", '0'}), []string{"p/q:0:"}, nil},
		{tarStream(paxEntry('g', "mtime=1"), tarEntry{"a", "", '0'}, paxEntry('x', "size=1"), tarEntry{"b", "1", '0'}),
			[]string{"a:0:", "b:0:1"}, nil},
		{tarStream(paxEntry('g', "path=g"), tarEntry{"a", "", '0'}, tarEntry{"b", "", '0'}), nil, errTarEntries},
		{tarStream(paxEntry('x', "size=x"), tarEntry{"a", "", '0'}), []string{"a:0:"}, nil},
		{tarStream(paxEntry('x', "size=0"), tarEntry{"a", "", '5'}, tarEntry{"b", "", '0'}),
			[]string{"a:5:", "b:0:"}, nil},
		{append(tarStream(tarEntry{"a", "", '0'})[:tarBlock], append(invalidChecksum, make([]byte, 1024)...)...),
			[]string{"a:0:"}, nil},
		{append(signed, make([]byte, 1024)...), nil, errTarRead},
		{append(invalidChecksum, make([]byte, 1024)...), nil, errTarRead},
		{tarStream(tarEntry{"a", "", 'V'}), nil, errTarEntries},
		{tarStream(tarEntry{"a", "", '0'}, tarEntry{"a", "", '0'}), nil, errTarEntries},
		{tarStream(paxEntry('x', "size=-1"), tarEntry{"a", "", '0'}), nil, errTarEntries},
		{tarStream(paxEntry('x', "size=9000000"), tarEntry{"a", "", '0'}), nil, errTarEntries},
		{tarStream(paxEntry('x', "size=5000"), tarEntry{"a", "", '0'}), nil, errTarRead},
		{tarStream(tarEntry{"././@LongLink", "n", 'L'}), nil, errTarRead},
		{tarStream(paxEntry('x', "path=a")), nil, errTarRead},
		{tarStream(paxEntry('x', "GNU.sparse.map=0,1"), tarEntry{"a", "", '0'}), nil, errTarRead},
		{tarStream(paxEntry('x', "GNU.sparse.size=1"), tarEntry{"a", "", '0'}), nil, errTarRead},
		{tarStream(paxEntry('x', "GNU.sparse.major=1", "GNU.sparse.minor=0"), tarEntry{"a", "", '0'}), nil, errTarRead},
		{tarStream(paxEntry('x', "GNU.sparse.name=n"), tarEntry{"a", "", '0'}), nil, errTarRead},
		{tarStream(tarEntry{"././@PaxHeader", "x", 'x'}, tarEntry{"a", "", '0'}), nil, errTarRead},
		{tarStream(tarEntry{"././@PaxHeader", "6 a=b\n", 'x'}, tarEntry{"a", "", '0'}), []string{"a:0:"}, nil},
		{tarStream(tarEntry{"././@PaxHeader", "6 ab\n\n", 'x'}, tarEntry{"a", "", '0'}), nil, errTarRead},
		{tarStream(tarEntry{"././@PaxHeader", "5 a=b\n", 'x'}, tarEntry{"a", "", '0'}), nil, errTarRead},
		{tarStream(tarEntry{"././@PaxHeader", "9 a=b\n", 'x'}, tarEntry{"a", "", '0'}), nil, errTarRead},
		{tarStream(tarEntry{"././@PaxHeader", "4 a\n", 'x'}, tarEntry{"a", "", '0'}), nil, errTarRead},
		{tarStream(tarEntry{"././@PaxHeader", "123456789012345678901 a=b\n", 'x'}, tarEntry{"a", "", '0'}), nil,
			errTarRead},
		{tarStream(tarEntry{"././@PaxHeader", "6 =bc\n", 'x'}, tarEntry{"a", "", '0'}), nil, errTarRead},
		{tarStream(tarEntry{"././@PaxHeader", "6 a=b", 'x'}, tarEntry{"a", "", '0'}), nil, errTarRead},
		{append(sparse, make([]byte, 1024)...), nil, errTarRead},
		{append(checksummed(sparseBadField), make([]byte, 1024)...), nil, errTarRead},
		{append(checksummed(sparseBadSize), make([]byte, 1024)...), nil, errTarRead},
	} {
		names, err := readTarStream(test.stream)
		if !errors.Is(err, test.err) || err == nil && strings.Join(names, ",") != strings.Join(test.names, ",") {
			t.Errorf("%q: %q %v", test.stream[:min(len(test.stream), 100)], names, err)
		}
	}
	files := []tarEntry{paxEntry('g', "size=7000000")}
	for index := range 5 {
		files = append(files, tarEntry{string(rune('a' + index)), "", '0'})
	}
	if _, err := readTarStream(tarStream(files...)); !errors.Is(err, errTarEntries) {
		t.Errorf("total size: %v", err)
	}
	many := []tarEntry{}
	for index := range maxArchiveMembers + 1 {
		many = append(many, tarEntry{"m" + itoaOctal(index+1), "", '5'})
	}
	if _, err := readTarStream(append(tarStream(many...), make([]byte, 0)...)); err == nil {
		t.Error("member limit ignored")
	}
}

func TestTarHeader(t *testing.T) {
	if _, err := tarHeader(nil); !errors.Is(err, errTarEmpty) {
		t.Errorf("empty: %v", err)
	}
	if _, err := tarHeader(make([]byte, 10)); !errors.Is(err, errTarTruncated) {
		t.Errorf("truncated: %v", err)
	}
	prefixed := tarHeaderBlock("name", 0o755, 0, 0, '0')
	copy(prefixed[345:], "pre")
	member, err := tarHeader(checksummed(prefixed))
	if err != nil || member.name != "pre/name" || member.mode != 0o755 {
		t.Errorf("prefix: %v %v", member, err)
	}
	invalid := tarHeaderBlock("name", 0o755, 0, 0, '0')
	copy(invalid[100:], "\xd9\xa1")
	if _, err := tarHeader(checksummed(invalid)); !errors.Is(err, errTarInvalid) {
		t.Errorf("non-ASCII number: %v", err)
	}
}

func TestTarNumber(t *testing.T) {
	for _, test := range []struct {
		field string
		value int64
		ok    bool
	}{
		{"0000017\x00", 0o17, true},
		{"\x00", 0, true},
		{"  ", 0, true},
		{" 0o17 ", 0o17, true},
		{"\x80\x00\x00\x00\x00\x00\x01\x00", 256, true},
		{"\xff\xff\xff\xff\xff\xff\xff\xfe", -2, true},
		{"\x80\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff", pyIntLimit, true},
		{"\xff\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x01", -pyIntLimit, true},
		{"\xd9\xa1", 0, false},
		{"8", 0, false},
	} {
		value, ok := tarNumber([]byte(test.field))
		if value != test.value || ok != test.ok {
			t.Errorf("%q: %d %v", test.field, value, ok)
		}
	}
}

func TestPyInt(t *testing.T) {
	for _, test := range []struct {
		text  string
		value int64
		ok    bool
	}{
		{" 12 ", 12, true},
		{"\x1c-1_2　", -12, true},
		{"+١٢", 12, true},
		{"\U0001D7D9", 1, true},
		{"0o_17", 0, false},
		{"1__2", 0, false},
		{"_1", 0, false},
		{"1_", 0, false},
		{"", 0, false},
		{"-", 0, false},
		{"1 2", 0, false},
		{"1é", 0, false},
		{strings.Repeat("9", maxPyIntDigits), pyIntLimit/10*10 + 9, true},
		{strings.Repeat("9", maxPyIntDigits+1), 0, false},
	} {
		value, ok := pyInt(test.text, 10, false)
		if value != test.value || ok != test.ok {
			t.Errorf("%q: %d %v", test.text, value, ok)
		}
	}
	if value, ok := pyInt("0O_17", 8, false); value != 0o17 || !ok {
		t.Errorf("octal prefix: %d %v", value, ok)
	}
	if value, ok := pyInt("", 8, true); value != 0 || !ok {
		t.Errorf("empty: %d %v", value, ok)
	}
}

func TestNormalizedTar(t *testing.T) {
	stream := tarStream(paxEntry('g', "size=4000"), tarEntry{"d", "", '5'})
	_, members, err := readSdist(gzipSdist(stream, 0))
	normalized, normalizeErr := normalizedTar(stream, members, 0)
	if err != nil || normalizeErr != nil || len(normalized) != tarRecord {
		t.Fatalf("directory: %v %v %d", err, normalizeErr, len(normalized))
	}
	if record := paxRecord("path", strings.Repeat("x", 94)); !strings.HasPrefix(record, "104 path=") || len(record) != 104 {
		t.Errorf("record %q", record)
	}
	if record := paxRecord("path", strings.Repeat("x", 3)); record != "12 path=xxx\n" {
		t.Errorf("record %q", record)
	}
}
