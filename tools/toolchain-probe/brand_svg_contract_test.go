package main

import "testing"

func TestBrandSVGContract(t *testing.T) {
	t.Parallel()
	const size = 512
	prefix := `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 1600 1600">`
	background := `<rect width="1600" height="1600" fill="#3C2B24"/>`
	for _, test := range []struct {
		body, presentation string
		valid              bool
	}{
		{"", brandTransparentPresentation, true},
		{background, brandEspressoPresentation, true},
		{background, brandTransparentPresentation, false},
		{"", brandEspressoPresentation, false},
		{background + background, brandEspressoPresentation, false},
		{background + `<image/>`, brandEspressoPresentation, false},
		{`<g><image/></g>`, brandTransparentPresentation, false},
		{`<rect width="1600" height="1600" fill="#3C2B24" opacity="1"/>`, brandEspressoPresentation, false},
		{"", "unsupported_brand_presentation", false},
	} {
		root, _ := brandSVGParse([]byte(prefix + test.body + `</svg>`))
		if brandSVGContract(root, size, test.presentation) != test.valid {
			t.Fatal("SVG presentation contract changed")
		}
		if brandSVGContract(root, size+1, test.presentation) {
			t.Fatal("SVG dimension mismatch accepted")
		}
	}
	if brandSVGContract(nil, size, brandTransparentPresentation) {
		t.Fatal("absent SVG accepted")
	}
}
