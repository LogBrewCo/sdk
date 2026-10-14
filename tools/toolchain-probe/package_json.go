package main

import (
	"bytes"
	"encoding/json"
	"io"
	"reflect"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	packageJSONArguments = 3
	jsonFields           = "fields"
	jsonEventFields      = "event-fields"
	jsonEventKinds       = "event-kinds"
	jsonTrailingFields   = "trailing-fields"
	jsonEscapeWidth      = 6
	jsonEscapeRadix      = 16
	jsonEscapePrefix     = 2
	jsonSurrogateWidth   = 12
)

func checkPackageJSON(arguments []string, diagnostic io.Writer) int {
	if len(arguments) < packageJSONArguments {
		return writeText(diagnostic, "package JSON check failed: invalid arguments\n", exitUsage)
	}
	data, valid := readCheckFile(arguments[len(arguments)-1])
	if !valid {
		return writeText(diagnostic, "package JSON check failed: input unavailable\n", exitFailure)
	}
	if !checkPackageDocument(data, arguments[0], arguments[1:len(arguments)-1]) {
		return writeText(diagnostic, "package JSON check failed: invalid output or expectation\n", exitFailure)
	}
	return exitOK
}

func checkPackageDocument(data []byte, mode string, expectations []string) bool {
	if len(expectations) == 0 || !utf8.Valid(data) {
		return false
	}
	if mode == jsonTrailingFields {
		data = trailingCheckObject(data)
	}
	decoded, valid := decodeCheckJSON(data)
	document, object := decoded.(map[string]any)
	if !valid || !object {
		return false
	}
	if mode == jsonFields || mode == jsonTrailingFields {
		return checkExpectedFields([]map[string]any{document}, expectations, mode)
	}
	return checkEventDocument(document["events"], mode, expectations)
}

func checkEventDocument(value any, mode string, expectations []string) bool {
	events, array := value.([]any)
	if !array || len(events) == 0 {
		return false
	}
	objects, kinds := make([]map[string]any, 0, len(events)), make(map[string]bool)
	for _, event := range events {
		entry, isObject := event.(map[string]any)
		if !isObject {
			return false
		}
		objects = append(objects, entry)
		if mode == jsonEventKinds {
			kind, isString := entry["type"].(string)
			if !isString || kind == "" {
				return false
			}
			kinds[kind] = true
		}
	}
	if mode == jsonEventFields {
		return checkExpectedFields(objects, expectations, mode)
	}
	for _, kind := range expectations {
		if !kinds[kind] {
			return false
		}
	}
	return mode == jsonEventKinds
}

func checkExpectedFields(documents []map[string]any, expectations []string, mode string) bool {
	for _, expectation := range expectations {
		key, encoded, separated := strings.Cut(expectation, "=")
		expected, valid := decodeCheckJSON([]byte(encoded))
		if !separated || key == "" || !valid {
			return false
		}
		parts := []string{key}
		if mode == jsonEventFields {
			parts = strings.Split(key, ".")
		}
		matched := false
		for _, document := range documents {
			actual, exists := checkField(document, parts)
			matched = matched || exists && reflect.DeepEqual(actual, expected)
		}
		if !matched {
			return false
		}
	}
	return true
}

func checkField(document map[string]any, parts []string) (any, bool) {
	var current any = document
	for _, part := range parts {
		object, valid := current.(map[string]any)
		if part == "" || !valid {
			return nil, false
		}
		current, valid = object[part]
		if !valid {
			return nil, false
		}
	}
	return current, true
}

func decodeCheckJSON(data []byte) (any, bool) {
	value, valid := decodeCheckDocument(data)
	if !valid {
		return nil, false
	}
	return mapCheckNumbers(value, normalizeCheckNumber)
}

func validCheckEscapes(data []byte) bool {
	for index := 0; index < len(data); index++ {
		if data[index] != '\\' {
			continue
		}
		index++
		if data[index] != 'u' {
			continue
		}
		width := checkEscapeWidth(data[index-1:])
		if width == 0 {
			return false
		}
		index += width - jsonEscapePrefix
	}
	return true
}

func checkEscapeWidth(data []byte) int {
	code, err := strconv.ParseUint(string(data[2:jsonEscapeWidth]), jsonEscapeRadix, jsonEscapeRadix)
	if err != nil {
		return 0
	}
	if !utf16.IsSurrogate(rune(code)) {
		return jsonEscapeWidth
	}
	if len(data) < jsonSurrogateWidth || string(data[jsonEscapeWidth:jsonEscapeWidth+jsonEscapePrefix]) != `\u` {
		return 0
	}
	low, err := strconv.ParseUint(string(data[jsonEscapeWidth+jsonEscapePrefix:jsonSurrogateWidth]),
		jsonEscapeRadix, jsonEscapeRadix)
	if err != nil || utf16.DecodeRune(rune(code), rune(low)) == unicode.ReplacementChar {
		return 0
	}
	return jsonSurrogateWidth
}

func mapCheckNumbers(value any, convert func(json.Number) (any, bool)) (any, bool) {
	switch typed := value.(type) {
	case json.Number:
		return convert(typed)
	case map[string]any:
		for key, item := range typed {
			converted, valid := mapCheckNumbers(item, convert)
			if !valid {
				return nil, false
			}
			typed[key] = converted
		}
	case []any:
		for index, item := range typed {
			converted, valid := mapCheckNumbers(item, convert)
			if !valid {
				return nil, false
			}
			typed[index] = converted
		}
	default:
	}
	return value, true
}

type checkDecimal struct {
	coefficient string
	exponent    int64
}

func normalizeCheckNumber(number json.Number) (any, bool) {
	encoded := string(number)
	if !strings.ContainsAny(encoded, ".eE") {
		if number == "-0" {
			number = "0"
		}
		return number, true
	}
	floating, err := strconv.ParseFloat(encoded, 64)
	if err != nil {
		return nil, false
	}
	mantissa, exponent, _ := strings.Cut(strings.ToLower(encoded), "e")
	whole, fraction, _ := strings.Cut(mantissa, ".")
	digits := strings.TrimLeft(strings.TrimPrefix(whole, "-")+fraction, "0")
	if digits == "" {
		return checkDecimal{}, true
	}
	if floating == 0 {
		return nil, false
	}
	var scale int64
	if exponent != "" {
		scale, err = strconv.ParseInt(exponent, 10, 64)
		if err != nil {
			return nil, false
		}
	}
	coefficient := strings.TrimRight(digits, "0")
	scale += int64(len(digits) - len(coefficient) - len(fraction))
	if strings.HasPrefix(mantissa, "-") {
		coefficient = "-" + coefficient
	}
	return checkDecimal{coefficient: coefficient, exponent: scale}, true
}

type checkJSONStream struct {
	stack           []byte
	start, end      int
	quoted, escaped bool
}

func trailingCheckObject(data []byte) []byte {
	state := checkJSONStream{stack: nil, start: -1, end: -1, quoted: false, escaped: false}
	for index, character := range data {
		if !state.consume(index, character) {
			return nil
		}
	}
	if state.quoted || len(state.stack) != 0 || state.start < 0 || state.end < state.start ||
		data[state.start] != '{' || len(bytes.TrimSpace(data[state.end:])) != 0 {
		return nil
	}
	return data[state.start:state.end]
}

func (state *checkJSONStream) consume(index int, character byte) bool {
	if state.quoted {
		switch {
		case state.escaped:
			state.escaped = false
		case character == '\\':
			state.escaped = true
		case character == '"':
			state.quoted = false
		default:
		}
		return true
	}
	switch character {
	case '"':
		state.quoted = true
	case '{', '[':
		if len(state.stack) == 0 {
			state.start = index
		}
		state.stack = append(state.stack, character)
	case '}', ']':
		expected := byte('{')
		if character == ']' {
			expected = '['
		}
		if len(state.stack) == 0 || state.stack[len(state.stack)-1] != expected {
			return false
		}
		state.stack = state.stack[:len(state.stack)-1]
		if len(state.stack) == 0 {
			state.end = index + 1
		}
	default:
	}
	return true
}
