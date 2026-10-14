package main

import (
	"bytes"
	"encoding/xml"
	"errors"
	"io"
	"slices"
	"strings"
	"unicode/utf8"
)

const (
	metadataXMLDepth = 64
	metadataXMLNodes = 4096
)

type metadataXMLNode struct {
	name       string
	namespace  string
	text       []byte
	children   []*metadataXMLNode
	attributes []xml.Attr
}

type metadataXMLParser struct {
	stack       []*metadataXMLNode
	nodes       int
	nodeLimit   int
	declaration bool
}

func parseMetadataXML(data []byte) *metadataXMLNode {
	return parseMetadataXMLBounded(data, pythonManifestLimit, metadataXMLNodes)
}

func parseMetadataXMLBounded(data []byte, byteLimit, nodeLimit int) *metadataXMLNode {
	if len(data) > byteLimit || !utf8.Valid(data) {
		return nil
	}
	document := &metadataXMLNode{name: "", namespace: "", text: nil, children: nil, attributes: nil}
	parser := metadataXMLParser{stack: []*metadataXMLNode{document}, nodes: 0, nodeLimit: nodeLimit, declaration: false}
	// Reviewed 2026-09-12: bounded UTF-8 token parsing, no object deserialization.
	// DTDs and custom entities are rejected; TestMetadataXMLRejectedDocuments covers resource limits.
	// gosec 2.28.0 taint findings vary across runs: https://github.com/securego/gosec/issues/1712.
	// Only this audited G709 exception may be reported unused; all other diagnostics remain errors.
	//nolint:gosec,nolintlint // G709: bounded token parser; unstable finding documented above.
	decoder := xml.NewDecoder(bytes.NewReader(data))
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil || !parser.consume(token) {
			return nil
		}
	}
	if len(parser.stack) != 1 || len(document.children) != 1 || len(bytes.TrimSpace(document.text)) != 0 {
		return nil
	}
	return document.children[0]
}

func (parser *metadataXMLParser) consume(token xml.Token) bool {
	parent := parser.stack[len(parser.stack)-1]
	switch value := token.(type) {
	case xml.StartElement:
		parser.nodes++
		if len(parser.stack) > metadataXMLDepth || parser.nodes > parser.nodeLimit || !uniqueXMLAttributes(value.Attr) {
			return false
		}
		node := &metadataXMLNode{
			name: value.Name.Local, namespace: value.Name.Space, text: nil, children: nil,
			attributes: slices.Clone(value.Attr),
		}
		parent.children = append(parent.children, node)
		parser.stack = append(parser.stack, node)
	case xml.EndElement:
		parser.stack = parser.stack[:len(parser.stack)-1]
	case xml.CharData:
		parent.text = append(parent.text, value...)
	case xml.ProcInst:
		if value.Target != "xml" || parser.nodes != 0 || parser.declaration {
			return false
		}
		parser.declaration = true
	case xml.Comment:
		return true
	default:
		return false
	}
	return true
}

func uniqueXMLAttributes(attributes []xml.Attr) bool {
	seen := make(map[xml.Name]bool, len(attributes))
	for _, attribute := range attributes {
		if seen[attribute.Name] {
			return false
		}
		seen[attribute.Name] = true
	}
	return true
}

func (node *metadataXMLNode) path(names ...string) *metadataXMLNode {
	for _, name := range names {
		if node == nil {
			return nil
		}
		var found *metadataXMLNode
		for _, candidate := range node.children {
			if candidate.name == name {
				if found != nil {
					return nil
				}
				found = candidate
			}
		}
		node = found
	}
	return node
}

func (node *metadataXMLNode) attribute(name string) string {
	if node != nil {
		for _, attribute := range node.attributes {
			if attribute.Name.Space == "" && attribute.Name.Local == name {
				return attribute.Value
			}
		}
	}
	return ""
}

func (node *metadataXMLNode) descendants(name string) []*metadataXMLNode {
	var found []*metadataXMLNode
	if node.name == name {
		found = append(found, node)
	}
	for _, child := range node.children {
		found = append(found, child.descendants(name)...)
	}
	return found
}

func (node *metadataXMLNode) value(names ...string) string {
	field := node.path(names...)
	if field == nil || len(field.children) != 0 {
		return ""
	}
	return strings.TrimSpace(string(field.text))
}

func (node *metadataXMLNode) hasNamespace(namespace string) bool {
	if node.namespace != namespace {
		return false
	}
	for _, child := range node.children {
		if !child.hasNamespace(namespace) {
			return false
		}
	}
	return true
}
