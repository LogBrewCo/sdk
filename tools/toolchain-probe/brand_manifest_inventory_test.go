package main

import (
	"encoding/json"
	"strings"
	"testing"
)

const brandFixtureKind = "kind"

func brandManifestAssetFixture() map[string]any {
	return map[string]any{
		publicationPathKey: brandCanonicalSource, pythonManifestHash: strings.Repeat("a", 64),
		brandFixtureKind: brandSVGKind,
		"presentation":   brandEspressoPresentation, "generation": "canonical_source",
		"width": json.Number("1600"), "height": json.Number("1600"),
	}
}

func TestBrandManifestInventoryFailures(t *testing.T) {
	t.Parallel()
	manifest := brandManifest{legacy: nil, geometry: "", assets: nil, copies: nil}
	asset := brandManifestAssetFixture()
	if _, valid := brandManifestAssets([]any{asset}, manifest); !valid {
		t.Fatal("canonical asset fixture rejected")
	}
	for _, inventory := range []any{nil, true, []any{}, []any{asset, asset}, []any{nil}} {
		if _, valid := brandManifestAssets(inventory, manifest); valid {
			t.Fatal("invalid brand inventory accepted")
		}
	}
	for _, mutation := range []struct {
		value any
		field string
	}{
		{"assets/brand/../brand/logo.svg", publicationPathKey},
		{"assets/brand/nested/logo.svg", publicationPathKey},
		{"assets/brand/other.svg", publicationPathKey},
		{strings.Repeat("A", 64), pythonManifestHash},
		{"abcd", pythonManifestHash},
		{true, brandFixtureKind},
		{json.Number("0"), "width"},
		{"1600", "height"},
		{"svg_derivative", "generation"},
	} {
		changed := brandManifestAssetFixture()
		changed[mutation.field] = mutation.value
		if _, valid := brandManifestAssets([]any{changed}, manifest); valid {
			t.Fatal("invalid canonical asset identity accepted")
		}
	}
}
