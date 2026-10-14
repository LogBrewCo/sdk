package main

import (
	"strings"
	"testing"
)

func TestBrandDerivationSourceGuards(t *testing.T) {
	t.Parallel()
	const size = 512
	master := repositorySource(t, brandCanonicalSource)
	background := "  <rect width=\"1600\" height=\"1600\" fill=\"#3C2B24\"/>\n"
	for _, changed := range []string{
		strings.Replace(master, background, "", 1),
		strings.Replace(master, background, background+background, 1),
		strings.Replace(master, `width="1600" height="1600" viewBox="0 0 1600 1600"`, `width="1599"`, 1),
		strings.Replace(master, "espresso-bg 1600 optical-centered", "changed title", 1),
	} {
		if _, valid := brandDeriveSVG([]byte(changed), "transparent", size); valid {
			t.Fatal("drifted canonical transformation accepted")
		}
	}
	for _, dimension := range []uint32{0, brandPixelDimensionLimit + 1} {
		if _, valid := brandDeriveSVG([]byte(master), "espresso-bg", dimension); valid {
			t.Fatal("invalid derivative dimension accepted")
		}
	}
	if _, valid := brandDeriveSVG([]byte{0xff}, "espresso-bg", size); valid {
		t.Fatal("invalid UTF8 master accepted")
	}
}
