package main

import (
	"strconv"
	"strings"
)

const brandSVGViewBox = "0 0 1600 1600"

const (
	brandEspressoPresentation    = "espresso_app_icon"
	brandTransparentPresentation = "transparent_inline"
)

func brandSVGValue(node *metadataXMLNode, name, expected string) bool {
	value := brandSVGAttribute(node, name)
	return value != nil && *value == expected
}

func brandSVGElements(node *metadataXMLNode, suffix string) []*metadataXMLNode {
	result := make([]*metadataXMLNode, 0)
	if strings.HasSuffix(node.name, suffix) {
		result = append(result, node)
	}
	for _, child := range node.children {
		result = append(result, brandSVGElements(child, suffix)...)
	}
	return result
}

func brandSVGContract(root *metadataXMLNode, size uint32, presentation string) bool {
	if root == nil {
		return false
	}
	dimension := strconv.FormatUint(uint64(size), 10)
	if !brandSVGValue(root, "width", dimension) || !brandSVGValue(root, "height", dimension) ||
		!brandSVGValue(root, "viewBox", brandSVGViewBox) || len(brandSVGElements(root, "image")) != 0 {
		return false
	}
	rectangles := brandSVGElements(root, "rect")
	switch presentation {
	case brandEspressoPresentation:
		if len(rectangles) != 1 {
			return false
		}
		rectangle := rectangles[0]
		return len(rectangle.attributes) == 3 && brandSVGValue(rectangle, "width", "1600") &&
			brandSVGValue(rectangle, "height", "1600") && brandSVGValue(rectangle, "fill", "#3C2B24")
	case brandTransparentPresentation:
		return len(rectangles) == 0
	default:
		return false
	}
}
