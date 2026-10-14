package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"slices"
	"testing"
)

const nugetArchiveName, nugetArchiveBody = "a", "x"

func TestNugetArchiveContentDigest(t *testing.T) {
	t.Parallel()
	entries := []pythonArchiveEntry{
		pythonFixtureFile("b", nugetArchiveBody), pythonFixtureFile(nugetArchiveName, "abc"),
		{name: "d/", data: nil, mode: pythonFixtureMode, directory: true},
	}
	// Frozen framing, independently written rather than using the serializer.
	wire := "\x00\x00\x00\x00\x00\x00\x00\x01a\x00\x00\x00\x00\x00\x00\x00\x03abc" +
		"\x00\x00\x00\x00\x00\x00\x00\x01b\x00\x00\x00\x00\x00\x00\x00\x01x" +
		"\x00\x00\x00\x00\x00\x00\x00\x02d/\x00\x00\x00\x00\x00\x00\x00\x00"
	digest := sha256.Sum256([]byte(wire))
	expected := hex.EncodeToString(digest[:])
	for _, signature := range []string{"", "first-signature", "replacement-signature"} {
		members := slices.Clone(entries)
		if signature != "" {
			members = append(members, pythonFixtureFile(".signature.p7s", signature))
		}
		slices.Reverse(members)
		actual, valid := nugetPackageContentSHA256(pythonFixtureZip(t, members))
		if !valid || actual != expected {
			t.Fatal("NuGet content framing, ordering or root signature exclusion changed")
		}
	}
	for _, members := range [][]pythonArchiveEntry{
		entries[:2], append(slices.Clone(entries), pythonFixtureFile("nested/.signature.p7s", "content")),
		{pythonFixtureFile(nugetArchiveName, "different")},
	} {
		actual, valid := nugetPackageContentSHA256(pythonFixtureZip(t, members))
		if !valid || actual == expected {
			t.Fatal("changed non-signature package content retained its digest")
		}
	}
}

func TestNugetArchiveResourceBounds(t *testing.T) {
	t.Parallel()
	data := pythonFixtureZip(t, []pythonArchiveEntry{pythonFixtureFile(nugetArchiveName, nugetArchiveBody)})
	position := bytes.Index(data, []byte(pythonZipDirectorySignature))
	for _, test := range []struct {
		offset int
		value  uint32
	}{
		{pythonZipSizeOffset, pythonArchiveMemberBytes + 1},
		{pythonZipAttributesOffset, pythonFixtureSymlinkMode << pythonZipModeShift},
		{pythonZipAttributesOffset, pythonFixtureFIFOMode << pythonZipModeShift},
	} {
		mutated := bytes.Clone(data)
		binary.LittleEndian.PutUint32(mutated[position+test.offset:], test.value)
		if _, valid := nugetPackageContentSHA256(mutated); valid {
			t.Fatal("oversized or non-regular package entry accepted")
		}
	}
	mutated := bytes.Clone(data)
	mutated[position+pythonZipCRCOffset] ^= 1
	if _, valid := nugetPackageContentSHA256(mutated); valid {
		t.Fatal("corrupted package content accepted")
	}
	mutated = bytes.Clone(data)
	binary.LittleEndian.PutUint16(mutated[position+pythonZipFlagsOffset:], 1)
	if _, valid := nugetPackageContentSHA256(mutated); valid {
		t.Fatal("encrypted package content accepted")
	}
	if _, valid := nugetPackageContentSHA256(make([]byte, nugetPackageLimit+1)); valid {
		t.Fatal("oversized package accepted")
	}
}

func TestNugetArchiveRejectsAmbiguousNames(t *testing.T) {
	t.Parallel()
	for _, entries := range [][]pythonArchiveEntry{
		{pythonFixtureFile("../outside", nugetArchiveBody)},
		{pythonFixtureFile("/absolute", nugetArchiveBody)},
		{pythonFixtureFile("a//b", nugetArchiveBody)},
		{pythonFixtureFile("a/./b", nugetArchiveBody)},
		{pythonFixtureFile("a\\b", nugetArchiveBody)},
		{pythonFixtureFile(nugetArchiveName, nugetArchiveBody), pythonFixtureFile(nugetArchiveName, "y")},
	} {
		if _, valid := nugetPackageContentSHA256(pythonFixtureZip(t, entries)); valid {
			t.Fatal("unsafe or duplicate NuGet archive path accepted")
		}
	}
	data := pythonFixtureZip(t, []pythonArchiveEntry{pythonFixtureFile(nugetArchiveName, nugetArchiveBody)})
	for _, invalid := range [][]byte{nil, data[:len(data)-1], append(bytes.Clone(data), 'x')} {
		if _, valid := nugetPackageContentSHA256(invalid); valid {
			t.Fatal("incomplete or trailing archive accepted")
		}
	}
}
