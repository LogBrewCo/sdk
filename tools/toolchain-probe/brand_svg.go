package main

import "strings"

type brandSVGGeometry struct {
	ViewBox *string
	Groups  []*string
	Paths   [][2]*string
}

const brandSVGNamespace = "http://www.w3.org/2000/svg" //nolint:revive // unsecure-url-scheme: SVG namespace identifier.

const brandSVGByteLimit = 8 * 1024 * 1024

const brandSVGNodeLimit = 32768

func brandSVGAttribute(node *metadataXMLNode, name string) *string {
	for _, attribute := range node.attributes {
		if attribute.Name.Space == "" && attribute.Name.Local == name {
			value := attribute.Value
			return &value
		}
	}
	return nil
}

func brandSVGCollect(node *metadataXMLNode, geometry *brandSVGGeometry) {
	if strings.HasSuffix(node.name, "g") {
		geometry.Groups = append(geometry.Groups, brandSVGAttribute(node, "transform"))
	}
	if strings.HasSuffix(node.name, "path") {
		geometry.Paths = append(geometry.Paths, [2]*string{
			brandSVGAttribute(node, "fill"), brandSVGAttribute(node, "d"),
		})
	}
	for _, child := range node.children {
		brandSVGCollect(child, geometry)
	}
}

func brandSVGParse(data []byte) (*metadataXMLNode, *brandSVGGeometry) {
	root := parseMetadataXMLBounded(data, brandSVGByteLimit, brandSVGNodeLimit)
	if root == nil || root.name != brandSVGKind || root.namespace != brandSVGNamespace {
		return nil, nil
	}
	geometry := &brandSVGGeometry{
		Groups: make([]*string, 0), Paths: make([][2]*string, 0), ViewBox: brandSVGAttribute(root, "viewBox"),
	}
	brandSVGCollect(root, geometry)
	return root, geometry
}
