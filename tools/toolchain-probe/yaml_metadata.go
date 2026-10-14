package main

import (
	"bytes"
	"errors"
	"io"
	"slices"

	"go.yaml.in/yaml/v3"
)

const (
	metadataYAMLDepth = 64
	metadataYAMLNodes = 4096
	yamlStringTag     = "!!str"
	yamlBooleanTag    = "!!bool"
	yamlPairSize      = 2
)

func parseMetadataYAML(data []byte) *yaml.Node {
	if !validMetadataText(data, nil) {
		return nil
	}
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	var document, trailing yaml.Node
	if decoder.Decode(&document) != nil || !errors.Is(decoder.Decode(&trailing), io.EOF) ||
		document.Kind != yaml.DocumentNode || len(document.Content) != 1 {
		return nil
	}
	root := document.Content[0]
	remaining := metadataYAMLNodes
	if root.Kind != yaml.MappingNode || !validMetadataYAMLNode(root, 0, &remaining) {
		return nil
	}
	return root
}

func validMetadataYAMLNode(node *yaml.Node, depth int, remaining *int) bool {
	*remaining--
	if *remaining < 0 || depth > metadataYAMLDepth || node.Anchor != "" ||
		node.Alias != nil || node.Style&yaml.TaggedStyle != 0 || !validMetadataYAMLShape(node) {
		return false
	}
	for _, child := range node.Content {
		if !validMetadataYAMLNode(child, depth+1, remaining) {
			return false
		}
	}
	return true
}

func validMetadataYAMLShape(node *yaml.Node) bool {
	switch node.Kind {
	case yaml.MappingNode:
		return node.Tag == "!!map" && uniqueMetadataYAMLKeys(node)
	case yaml.SequenceNode:
		return node.Tag == "!!seq"
	case yaml.ScalarNode:
		return len(node.Content) == 0 && slices.Contains([]string{
			yamlStringTag, yamlBooleanTag, "!!null", "!!int", "!!float",
		}, node.Tag)
	case yaml.DocumentNode, yaml.AliasNode:
		return false
	}
	return false
}

func uniqueMetadataYAMLKeys(node *yaml.Node) bool {
	if len(node.Content)%2 != 0 {
		return false
	}
	seen := make(map[string]bool, len(node.Content)/yamlPairSize)
	for index := 0; index < len(node.Content); index += 2 {
		key := node.Content[index]
		if key.Kind != yaml.ScalarNode || key.Tag != yamlStringTag || key.Value == "" || seen[key.Value] {
			return false
		}
		seen[key.Value] = true
	}
	return true
}

func yamlField(node *yaml.Node, path ...string) *yaml.Node {
	for _, key := range path {
		if node == nil || node.Kind != yaml.MappingNode {
			return nil
		}
		var found *yaml.Node
		for index := 0; index < len(node.Content); index += 2 {
			if node.Content[index].Value == key {
				found = node.Content[index+1]
				break
			}
		}
		node = found
	}
	return node
}

func yamlScalar(node *yaml.Node, tag, value string) bool {
	return node != nil && node.Kind == yaml.ScalarNode && node.Tag == tag && node.Value == value
}
