package main

import (
	"encoding/json"
	"strings"
)

const flatMetadataLineLimit = 4096

// Release listings use a flat YAML subset: scalar members and indented string
// lists. Reject unsupported syntax instead of interpreting general YAML.
func decodeFlatMetadata(data []byte) map[string]any {
	if !validMetadataText(data, nil) || strings.Count(string(data), "\n") > flatMetadataLineLimit {
		return nil
	}
	result := make(map[string]any)
	active := ""
	for line := range strings.SplitSeq(string(data), "\n") {
		line = strings.TrimSuffix(line, "\r")
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		var valid bool
		active, valid = readFlatMetadataLine(result, line, active)
		if !valid {
			return nil
		}
	}
	return result
}

func readFlatMetadataLine(result map[string]any, line, active string) (string, bool) {
	if active != "" && strings.HasPrefix(line, "  - ") {
		return active, appendFlatMetadataItem(result, active, strings.TrimSpace(line[4:]))
	}
	key, raw, found := strings.Cut(line, ":")
	if !found || key == "" || strings.ContainsAny(key, " \t\r\n[]{}&*!|>'\"") {
		return "", false
	}
	if _, duplicate := result[key]; duplicate {
		return "", false
	}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		result[key] = []string{}
		return key, true
	}
	value, valid := flatMetadataScalar(raw)
	result[key] = value
	return "", valid
}

func appendFlatMetadataItem(result map[string]any, key, raw string) bool {
	value, valid := flatMetadataScalar(raw)
	text, isText := value.(string)
	items, isList := result[key].([]string)
	if !valid || !isText || !isList {
		return false
	}
	result[key] = append(items, text)
	return true
}

func flatMetadataScalar(raw string) (any, bool) {
	const nullScalar = "null"
	if raw == "" {
		return nil, false
	}
	switch raw {
	case nullScalar:
		return nil, true
	case "[]":
		return []string{}, true
	}
	if raw[0] == '"' {
		var value string
		err := json.Unmarshal([]byte(raw), &value)
		return value, err == nil && validCheckEscapes([]byte(raw))
	}
	if raw[0] == '\'' {
		if len(raw) < 2 || raw[len(raw)-1] != '\'' {
			return nil, false
		}
		value := raw[1 : len(raw)-1]
		if strings.Contains(strings.ReplaceAll(value, "''", ""), "'") {
			return nil, false
		}
		return strings.ReplaceAll(value, "''", "'"), true
	}
	if strings.Trim(raw, "0123456789") == "" {
		return json.Number(raw), true
	}
	return raw, !strings.ContainsAny(raw, "[]{}&*!|>\t") && !strings.Contains(raw, " #")
}
