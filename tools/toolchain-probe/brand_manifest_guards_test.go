package main

import (
	"strings"
	"testing"
)

func TestBrandManifestGuards(t *testing.T) {
	t.Parallel()
	const source, target = "assets/brand/first.png", "assets/brand/second.png"
	if pairs, valid := brandCopyPairs([]any{[]any{source, target}}); !valid || len(pairs) != 1 {
		t.Fatal("valid copy pair rejected")
	}
	for _, value := range []any{
		nil,
		[]any{true},
		[]any{[]any{source}},
		[]any{[]any{source, source}},
		[]any{[]any{source, "../outside.png"}},
	} {
		if _, valid := brandCopyPairs(value); valid {
			t.Fatal("invalid copy pair accepted")
		}
	}
	digest := strings.Repeat("a", 64)
	if hashes, valid := brandLegacyHashes([]any{digest}); !valid || !hashes[digest] {
		t.Fatal("valid legacy digest rejected")
	}
	for _, value := range []any{nil, []any{true}, []any{"invalid_digest"}, []any{digest, digest}} {
		if _, valid := brandLegacyHashes(value); valid {
			t.Fatal("invalid legacy digest inventory accepted")
		}
	}
}
