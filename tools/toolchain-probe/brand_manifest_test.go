package main

import (
	"strings"
	"testing"
)

func TestBrandManifestDecode(t *testing.T) {
	t.Parallel()
	const assetCount = 14
	source := repositorySource(t, "assets/brand/manifest.json")
	manifest, valid := brandManifestDecode([]byte(source))
	if !valid || len(manifest.assets) != assetCount {
		t.Fatal("actual brand manifest rejected")
	}
	for _, changed := range []string{
		strings.Replace(source, `"schemaVersion": 1`, `"schemaVersion": true`, 1),
		strings.Replace(source, `"schemaVersion": 1`, `"schemaVersion": 2`, 1),
		strings.Replace(source, `"canonical_source"`, `"svg_derivative"`, 1),
		strings.Replace(source, `"exactCopies"`, `"missingCopies"`, 1),
		strings.Replace(source, `"legacySha256"`, `"missingLegacyHashes"`, 1),
		strings.Replace(source, `"assets/brand/google-play-icon-512.png",`,
			`"assets/brand/undeclared-copy.png",`, 1),
		strings.Replace(source, `"canonicalSource": "`+brandCanonicalSource+`"`,
			`"canonicalSource": "assets/brand/other.svg"`, 1),
		`{"schemaVersion":1,"schemaVersion":1}`,
	} {
		if _, accepted := brandManifestDecode([]byte(changed)); accepted {
			t.Fatal("invalid brand manifest accepted")
		}
	}
}
