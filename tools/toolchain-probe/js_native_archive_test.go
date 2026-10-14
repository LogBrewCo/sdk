package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestJSNativeArchivePlatform(t *testing.T) {
	t.Parallel()
	for _, platform := range []string{"darwin/arm64", "darwin/amd64", "linux/arm64", "linux/amd64"} {
		specification, valid := jsNativeArchiveForPlatform(platform)
		if !valid || !directDirectoryName(specification.member) || len(specification.digest) != sha256.Size*2 {
			t.Fatal("native archive platform identity incomplete")
		}
	}
	if _, valid := jsNativeArchiveForPlatform("unsupported/native-fixture"); valid {
		t.Fatal("unknown native archive platform accepted")
	}
}

func TestJSNativeArchiveEnvelope(t *testing.T) {
	t.Parallel()
	const member = "native-parser-fixture"
	for _, fixture := range []struct {
		name    string
		entries []pythonArchiveEntry
		valid   bool
	}{
		{name: "one-executable", entries: []pythonArchiveEntry{
			pythonFixtureFile(member, "native fixture"),
		}, valid: true},
		{name: "wrong-member", entries: []pythonArchiveEntry{
			pythonFixtureFile("unexpected", "native fixture"),
		}, valid: false},
		{name: "extra-member", entries: []pythonArchiveEntry{
			pythonFixtureFile(member, "native fixture"), pythonFixtureFile("additional", "extra fixture"),
		}, valid: false},
		{name: "empty-archive", entries: nil, valid: false},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			t.Parallel()
			archive := pythonFixtureArchive(t, pythonSdist, fixture.entries)
			specification := jsNativeFixtureIdentity(archive, member)
			data, valid := jsNativeArchiveContent(archive, specification)
			if valid != fixture.valid || !valid && data != nil {
				t.Fatal("native archive envelope result changed")
			}
			archive[len(archive)-1] ^= 1
			if data, valid := jsNativeArchiveContent(archive, specification); valid || data != nil {
				t.Fatal("modified archive digest accepted")
			}
			specification = jsNativeFixtureIdentity(archive, member)
			if data, valid := jsNativeArchiveContent(archive, specification); valid || data != nil {
				t.Fatal("damaged gzip footer accepted")
			}
		})
	}
}

func jsNativeFixtureIdentity(data []byte, member string) jsNativeArchive {
	digest := sha256.Sum256(data)
	return jsNativeArchive{name: member + ".tar.gz", member: member, digest: hex.EncodeToString(digest[:])}
}

func TestJSNativeOfficialArchive(t *testing.T) {
	t.Parallel()
	name := os.Getenv("LOGBREW_TEST_OXLINT_ARCHIVE")
	if name == "" {
		t.Skip("official archive integration requires a verified archive path")
	}
	root, err := os.OpenRoot(filepath.Dir(name))
	if err != nil {
		t.Fatal("official archive root unavailable")
	}
	data, read := jsNativeReadArchive(root, filepath.Base(name))
	closeError := root.Close()
	specification, valid := jsNativeArchiveForPlatform("darwin/arm64")
	if !read || closeError != nil || !valid {
		t.Fatal("official native archive fixture unavailable")
	}
	content, valid := jsNativeArchiveContent(data, specification)
	if !valid || len(content) == 0 {
		t.Fatal("official native archive failed integrity or extraction")
	}
}
