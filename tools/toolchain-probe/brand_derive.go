package main

import (
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	brandTransparentDerivation = "transparent"
	brandEspressoDerivation    = "espresso-bg"
)

func brandReplaceOnce(source, old, replacement string) (string, bool) {
	if strings.Count(source, old) != 1 {
		return "", false
	}
	return strings.Replace(source, old, replacement, 1), true
}

func brandDeriveSVG(master []byte, presentation string, size uint32) ([]byte, bool) {
	if !utf8.Valid(master) || len(master) > brandSVGByteLimit || size == 0 || size > brandPixelDimensionLimit {
		return nil, false
	}
	source := string(master)
	var valid bool
	switch presentation {
	case brandTransparentDerivation:
		source = strings.Replace(source, "logbrew-logo-espresso-bg", "logbrew-logo-transparent", 1)
		source, valid = brandReplaceOnce(source, "  <rect width=\"1600\" height=\"1600\" fill=\"#3C2B24\"/>\n", "")
		if !valid {
			return nil, false
		}
	case brandEspressoDerivation:
	default:
		return nil, false
	}
	if size == brandPixelDimensionLimit {
		return []byte(source), true
	}
	dimension := strconv.FormatUint(uint64(size), 10)
	source, valid = brandReplaceOnce(source, `width="1600" height="1600" viewBox="0 0 1600 1600"`,
		`width="`+dimension+`" height="`+dimension+`" viewBox="0 0 1600 1600"`)
	if !valid {
		return nil, false
	}
	source, valid = brandReplaceOnce(source, presentation+" 1600 optical-centered",
		presentation+" "+dimension+" optical-centered")
	return []byte(source), valid
}
