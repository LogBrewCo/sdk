package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestBrandSVGRepositoryDerivatives(t *testing.T) {
	t.Parallel()
	const digest = "2be61a3c1553e6462f2340b8bbe980395dd7299e375e1b24d8744681d93efcb4"
	const large, small = 1600, 512
	for _, asset := range []struct {
		name, presentation string
		size               uint32
	}{
		{"logbrew-logo-espresso-bg-1600.svg", brandEspressoPresentation, large},
		{"logbrew-logo-espresso-bg-512.svg", brandEspressoPresentation, small},
		{"logbrew-logo-transparent-1600.svg", brandTransparentPresentation, large},
		{"logbrew-logo-transparent-512.svg", brandTransparentPresentation, small},
	} {
		t.Run(asset.name, func(t *testing.T) {
			t.Parallel()
			data := []byte(repositorySource(t, "assets/brand/"+asset.name))
			root, geometry := brandSVGParse(data)
			if !brandSVGContract(root, asset.size, asset.presentation) || geometry == nil {
				t.Fatal("repository SVG contract drifted")
			}
			actual, err := brandGeometryDigest(geometry)
			if err != nil || actual != digest {
				t.Fatal("derivative geometry differs from canonical artwork")
			}
			requireBrandGeometryMutation(t, data, digest)
		})
	}
}

func requireBrandGeometryMutation(t *testing.T, data []byte, digest string) {
	t.Helper()
	mutated := bytes.Replace(data, []byte("translate(14 0)"), []byte("translate(15 0)"), 1)
	_, changed := brandSVGParse(mutated)
	if changed == nil {
		t.Fatal("geometry mutation fixture rejected")
	}
	actual, err := brandGeometryDigest(changed)
	if err != nil || actual == digest {
		t.Fatal("geometry drift was not detected")
	}
}

func TestBrandSVGResourceLimits(t *testing.T) {
	t.Parallel()
	if node, _ := brandSVGParse(bytes.Repeat([]byte{' '}, brandSVGByteLimit+1)); node != nil {
		t.Fatal("oversized SVG accepted")
	}
	document := `<svg xmlns="http://www.w3.org/2000/svg">` +
		strings.Repeat(`<path/>`, brandSVGNodeLimit) + `</svg>`
	if node, _ := brandSVGParse([]byte(document)); node != nil {
		t.Fatal("SVG node limit exceeded")
	}
}
