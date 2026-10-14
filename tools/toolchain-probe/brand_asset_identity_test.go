package main

import (
	"encoding/json"
	"testing"
)

func TestBrandDimensions(t *testing.T) {
	t.Parallel()
	const expected = 512
	for _, value := range []any{
		nil, true, 1, "512", json.Number("0"), json.Number("-1"),
		json.Number("1.0"), json.Number("1e2"), json.Number("4294967296"),
	} {
		if _, valid := brandDimension(value); valid {
			t.Fatal("noncanonical dimension accepted")
		}
	}
	if dimension, valid := brandDimension(json.Number("512")); !valid || dimension != expected {
		t.Fatal("integer dimension rejected")
	}
}

func TestBrandAssetManifestIdentity(t *testing.T) {
	t.Parallel()
	decoded, valid := decodeCheckJSON([]byte(repositorySource(t, "assets/brand/manifest.json")))
	if !valid {
		t.Fatal("brand manifest JSON rejected")
	}
	object, ok := decoded.(map[string]any)
	if !ok {
		t.Fatal("brand manifest root rejected")
	}
	assets, ok := object["assets"].([]any)
	if !ok || len(assets) == 0 {
		t.Fatal("brand asset inventory missing")
	}
	for _, value := range assets {
		asset, accepted := brandAssetDecode(value)
		if !accepted || !brandAssetPolicy(&asset) {
			t.Fatal("actual brand asset identity rejected")
		}
	}
}
