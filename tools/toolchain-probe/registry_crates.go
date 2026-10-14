package main

import (
	"encoding/json"
	"strings"
)

func registryCratesVersions(payload any) map[string]bool {
	versions := make(map[string]bool)
	if index, text := payload.(string); text {
		return registryCratesIndexVersions(index)
	}
	object, valid := payload.(map[string]any)
	if !valid {
		return versions
	}
	crate := registryObjectField(object, "crate")
	if version, text := crate["newest_version"].(string); text && version != "" {
		versions[version] = true
	}
	entries, array := object[registryVersionsField].([]any)
	if array {
		for _, entry := range entries {
			item, mapping := entry.(map[string]any)
			if !mapping {
				continue
			}
			if version, text := item["num"].(string); text {
				versions[version] = true
			}
		}
	}
	return versions
}

func registryCratesIndexVersions(index string) map[string]bool {
	versions := make(map[string]bool)
	for _, line := range strings.FieldsFunc(index, registryLineSeparator) {
		entry, valid := decodeCheckDocument([]byte(line))
		object, mapping := entry.(map[string]any)
		if !valid || !mapping || registryJSONTruthy(object["yanked"]) {
			continue
		}
		if version, text := object["vers"].(string); text {
			versions[version] = true
		}
	}
	return versions
}

func registryLineSeparator(value rune) bool {
	return strings.ContainsRune("\n\r\v\f\x1c\x1d\x1e\u0085\u2028\u2029", value)
}

func registryJSONTruthy(value any) bool {
	switch item := value.(type) {
	case nil:
		return false
	case bool:
		return item
	case string:
		return item != ""
	case json.Number:
		number, err := item.Float64()
		return err != nil || number != 0
	case []any:
		return len(item) != 0
	case map[string]any:
		return len(item) != 0
	default:
		return true
	}
}
