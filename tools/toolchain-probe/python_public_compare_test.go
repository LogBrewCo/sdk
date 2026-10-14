package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"path"
	"testing"
)

func pythonPublicComparisonFixture(t *testing.T, kind, body string) []byte {
	t.Helper()
	metadata := pythonFixtureRoot + "/PKG-INFO"
	if kind == pythonWheel {
		metadata = pythonFixtureWheelMetadata
	}
	return pythonFixtureArchive(t, kind, []pythonArchiveEntry{
		pythonFixtureFile(metadata, pythonFixtureMetadata),
		pythonFixtureFile(pythonFixtureRoot+"/module.py", body),
	})
}

func pythonPublicComparisonRecord(data []byte, kind string) pythonPublicArtifact {
	name := path.Base(pythonReleaseArtifactPath(pythonReleaseCatalog()[2], pythonFixtureVersion, kind))
	return pythonPublicArtifact{
		url:    "https://files.pythonhosted.org/packages/example/" + name,
		sha256: fmt.Sprintf("%x", sha256.Sum256(data)),
	}
}

func repackPythonPublicFixture(data []byte, kind string) []byte {
	public := bytes.Clone(data)
	if kind == pythonWheel {
		binary.LittleEndian.PutUint16(public[len(public)-2:], 1)
		return append(public, 'x')
	}
	public[4] ^= 1
	return public
}

func TestPythonPublicComparisonPreservesContentAndByteIdentity(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{pythonWheel, pythonSdist} {
		t.Run(kind, func(t *testing.T) {
			t.Parallel()
			built := pythonPublicComparisonFixture(t, kind, "original")
			for state, public := range map[string][]byte{
				pythonPublicBuilt: built, pythonPublicExisting: repackPythonPublicFixture(built, kind),
			} {
				registry := pythonPublicComparisonRecord(public, kind)
				receipt, valid := reconcilePythonPublicArtifact(built, public, registry,
					pythonReleaseCatalog()[2], pythonFixtureVersion, kind)
				expectedFile := pythonReleaseArtifactPath(pythonReleaseCatalog()[2], pythonFixtureVersion, kind)
				if !valid || len(receipt) != 5 || receipt[pythonPublicState] != state ||
					receipt[pythonManifestHash] != registry.sha256 ||
					receipt[pythonPublicRegistryHash] != registry.sha256 ||
					len(receipt[pythonPublicContentHash]) != pythonArtifactHashSize ||
					receipt[pythonManifestFile] != expectedFile ||
					(state == pythonPublicBuilt) != bytes.Equal(built, public) {
					t.Fatal("comparison did not distinguish package bytes from contents")
				}
			}
		})
	}
}

func TestPythonPublicComparisonRejectsChangedAndInvalidEvidence(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{pythonWheel, pythonSdist} {
		built := pythonPublicComparisonFixture(t, kind, "original")
		changed := pythonPublicComparisonFixture(t, kind, "different")
		for _, test := range []struct {
			registry      pythonPublicArtifact
			name          string
			built, public []byte
		}{
			{pythonPublicComparisonRecord(changed, kind), "changed-content", built, changed},
			{pythonPublicComparisonRecord(changed, kind), "forged-digest", built, built},
			{pythonPublicComparisonRecord(nil, kind), "invalid-public", built, nil},
			{pythonPublicComparisonRecord(built, kind), "invalid-build", nil, built},
		} {
			t.Run(kind+"/"+test.name, func(t *testing.T) {
				t.Parallel()
				if receipt, valid := reconcilePythonPublicArtifact(test.built, test.public, test.registry,
					pythonReleaseCatalog()[2], pythonFixtureVersion, kind); valid || len(receipt) != 0 {
					t.Fatal("invalid public comparison produced a successful receipt")
				}
			})
		}
	}
}
