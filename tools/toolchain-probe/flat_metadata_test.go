package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestFlatMetadataShapes(t *testing.T) {
	t.Parallel()
	data := "# listing\r\nname: 'product'\r\nblank: ''\nnull: null\nnumber: 123\nitems:\n  - alpha\n" +
		"  # comment\n  - 'second'\naliases: []\nquoted: \"text\"\napostrophe: 'it''s'\n"
	expected := map[string]any{
		pythonPublicName: "product", "blank": "", fixtureNullJSON: nil, "number": json.Number("123"),
		"items": []string{"alpha", "second"}, "aliases": []string{}, "quoted": "text", "apostrophe": "it's",
	}
	if actual := decodeFlatMetadata([]byte(data)); !reflect.DeepEqual(actual, expected) {
		t.Fatal("flat release metadata scalar/list types changed")
	}
}

func TestFlatMetadataRejectsUnsupportedShapes(t *testing.T) {
	t.Parallel()
	for _, invalid := range []string{
		"name: first\nname: second", "name: null\nname: second", ": value", "bad key: value", "no mapping",
		"  child: value", "\tchild: value", "items:\n  - 123", "items:\n  - null", "items:\n  - []",
		"items:\n    - value", "items: []\n  - value", "name: 'unfinished", "name: 'bad'quote'",
		"name: \"unfinished", "name: \"bad\\x41\"", "name: \"\\ud800\"", "name: &anchor", "name: *anchor",
		"name: !tag value", "name: [value]", "name: {nested: value}", "name: |\n text", "name: >\n text",
		"name: value # comment", "name: \xff", strings.Repeat("\n", flatMetadataLineLimit+1),
		strings.Repeat(" ", pythonManifestLimit+1),
	} {
		if decodeFlatMetadata([]byte(invalid)) != nil {
			t.Fatalf("unsupported flat metadata accepted: %.40q", invalid)
		}
	}
	if _, valid := flatMetadataScalar(""); valid {
		t.Fatal("empty scalar accepted outside a list declaration")
	}
}
