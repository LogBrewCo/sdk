package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"unicode/utf8"
)

const maximumJSONDepth = 128

func readCheckFile(path string) ([]byte, bool) {
	input, err := openCheckInput(path)
	if err != nil {
		return nil, false
	}
	return readCheckInputFile(input)
}

func readCheckInputFile(input *os.File) ([]byte, bool) {
	return readCheckInputLimit(input, maximumOutputFile)
}

func readCheckInputLimit(input *os.File, limit int64) ([]byte, bool) {
	data, valid := readCheckBytes(input, limit)
	return data, valid && len(data) > 0
}

func readCheckBytes(input *os.File, limit int64) ([]byte, bool) {
	info, statError := input.Stat()
	var data []byte
	var err error
	valid := statError == nil && info.Mode().IsRegular() && info.Size() <= limit && limit > 0
	if valid {
		data, err = io.ReadAll(io.LimitReader(input, limit+1))
	}
	closeError := input.Close()
	return data, valid && err == nil && closeError == nil && int64(len(data)) == info.Size()
}

// Decode once without replacing malformed Unicode, rounding numbers, accepting
// duplicate object members, or recursively allocating beyond the depth limit.
func decodeCheckDocument(data []byte) (any, bool) {
	if len(data) > maximumOutputFile || !utf8.Valid(data) || !json.Valid(data) || !validCheckEscapes(data) {
		return nil, false
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	return readCheckValue(decoder, 0)
}

func readCheckValue(decoder *json.Decoder, depth int) (any, bool) {
	if depth > maximumJSONDepth {
		return nil, false
	}
	value, err := decoder.Token()
	if err != nil {
		return nil, false
	}
	switch value {
	case json.Delim('{'):
		return readCheckObject(decoder, depth)
	case json.Delim('['):
		items := make([]any, 0)
		for decoder.More() {
			item, valid := readCheckValue(decoder, depth+1)
			if !valid {
				return nil, false
			}
			items = append(items, item)
		}
		closing, closeError := decoder.Token()
		return items, closeError == nil && closing == json.Delim(']')
	default:
		return value, true
	}
}

func readCheckObject(decoder *json.Decoder, depth int) (any, bool) {
	object := make(map[string]any)
	for decoder.More() {
		token, err := decoder.Token()
		key, isString := token.(string)
		_, duplicate := object[key]
		if err != nil || !isString || duplicate {
			return nil, false
		}
		value, valid := readCheckValue(decoder, depth+1)
		if !valid {
			return nil, false
		}
		object[key] = value
	}
	closing, err := decoder.Token()
	return object, err == nil && closing == json.Delim('}')
}
