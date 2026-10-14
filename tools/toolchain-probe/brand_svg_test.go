package main

import "testing"

func TestBrandSVGGeometry(t *testing.T) {
	t.Parallel()
	data := []byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1600">` +
		`<g transform="translate(14 0)"><path fill="#111011" d="M1 2"/><g><path/></g></g></svg>`)
	root, geometry := brandSVGParse(data)
	if root == nil || geometry == nil || len(geometry.Groups) != 3 || len(geometry.Paths) != 2 {
		t.Fatal("SVG geometry traversal changed")
	}
	if geometry.Groups[0] != nil || geometry.Groups[1] == nil || *geometry.Groups[1] != "translate(14 0)" ||
		geometry.Groups[2] != nil || geometry.Paths[1][0] != nil || geometry.Paths[1][1] != nil {
		t.Fatal("SVG missing attributes lost null semantics")
	}
	for _, rejected := range []string{
		`<svg/>`, `<html xmlns="http://www.w3.org/2000/svg"/>`,
		`<svg xmlns="http://www.w3.org/2000/svg"><path></svg>`,
		`<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>`,
	} {
		if node, _ := brandSVGParse([]byte(rejected)); node != nil {
			t.Fatal("invalid SVG accepted")
		}
	}
}
