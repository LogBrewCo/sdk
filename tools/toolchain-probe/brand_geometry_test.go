package main

import "testing"

func TestBrandGeometryCanonical(t *testing.T) {
	t.Parallel()
	_, geometry := brandSVGParse([]byte(repositorySource(t, "assets/brand/logbrew-logo-espresso-bg-1600.svg")))
	if geometry == nil {
		t.Fatal("canonical SVG rejected")
	}
	digest, err := brandGeometryDigest(geometry)
	if err != nil || digest != "2be61a3c1553e6462f2340b8bbe980395dd7299e375e1b24d8744681d93efcb4" {
		t.Fatal("canonical geometry digest changed")
	}
}

func TestBrandGeometryASCII(t *testing.T) {
	t.Parallel()
	value := "é😀<>&"
	geometry := &brandSVGGeometry{ViewBox: &value, Groups: []*string{nil}, Paths: make([][2]*string, 0)}
	encoded, err := brandGeometryJSON(geometry)
	if err != nil || string(encoded) != `{"groups":[null],"paths":[],"viewBox":"\u00e9\ud83d\ude00<>&"}` {
		t.Fatal("geometry JSON changed ASCII escaping or null semantics")
	}
}
