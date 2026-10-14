package main

import "testing"

func TestBrandReadBounds(t *testing.T) {
	t.Parallel()
	const name = "assets/brand/example.png"
	root := openMarkdownFixture(t, map[string]string{name: "bounded content"})
	data, valid := brandReadAsset(root, name, brandSVGByteLimit)
	if !valid || string(data) != "bounded content" {
		t.Fatal("bounded asset read failed")
	}
	for _, limit := range []int{-1, 0, 1, brandSVGByteLimit + 1} {
		if _, accepted := brandReadAsset(root, name, limit); accepted {
			t.Fatal("invalid or exceeded asset limit accepted")
		}
	}
	for _, rejected := range []string{"assets/brand", "assets/brand/missing.png", "../outside.png"} {
		if _, accepted := brandReadAsset(root, rejected, brandSVGByteLimit); accepted {
			t.Fatal("nonregular or escaping asset read accepted")
		}
	}
}
