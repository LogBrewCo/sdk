package main

import (
	"encoding/json"
	"reflect"
	"strings"
)

// The canonical schema owns shape, enums, bounds, and conditional presence.
// These checks retain relationships and lexical integer rules that it cannot
// express. Evaluate them before number normalization so 0.0 stays distinct
// from an integer parent index. A semantic rejection never masks a parse error.
func (checker *checkedSchema) validateEventBatch(data []byte) (bool, error) {
	document, valid := decodeCheckDocument(data)
	if !valid {
		return false, errCheckInput
	}
	consistent := eventBatchConsistent(document)
	document, valid = mapCheckNumbers(document, schemaCheckNumber)
	if !valid {
		return false, errCheckInput
	}
	valid, err := checker.validateDocument(document)
	return valid && consistent, err
}

func eventObject(value any) map[string]any {
	object, valid := value.(map[string]any)
	if !valid {
		return nil
	}
	return object
}

func eventBatchConsistent(document any) bool {
	events, valid := eventObject(document)["events"].([]any)
	if !valid || len(events) == 0 {
		return false
	}
	for _, event := range events {
		item := eventObject(event)
		attributes := eventObject(item["attributes"])
		if attributes == nil || !eventSessionConsistent(attributes) {
			return false
		}
		if item["type"] == "issue" && (!eventFramesConsistent(attributes["stackFrames"]) ||
			!eventExceptionConsistent(attributes) || !eventEvidenceConsistent(attributes)) {
			return false
		}
	}
	return true
}

func eventSessionConsistent(attributes map[string]any) bool {
	context := eventObject(attributes["context"])
	session := eventObject(context["session"])
	previous, present := session["previousId"]
	if !present {
		return true
	}
	id, idValid := session["id"].(string)
	previousID, previousValid := previous.(string)
	return idValid && previousValid && strings.TrimSpace(id) != strings.TrimSpace(previousID)
}

func eventCoordinatesConsistent(location map[string]any) bool {
	for _, field := range []string{"line", "column"} {
		if value, present := location[field]; present {
			number, isNumber := value.(json.Number)
			if _, err := number.Int64(); !isNumber || err != nil {
				return false
			}
		}
	}
	return true
}

func eventFramesConsistent(value any) bool {
	if value == nil {
		return true
	}
	frames, valid := value.([]any)
	if !valid {
		return false
	}
	for _, frame := range frames {
		if !eventCoordinatesConsistent(eventObject(frame)) {
			return false
		}
	}
	return true
}

func eventExceptionConsistent(attributes map[string]any) bool {
	chain := eventObject(attributes["exceptionChain"])
	if chain == nil {
		return true
	}
	entries, valid := chain["entries"].([]any)
	if !valid || len(entries) == 0 {
		return false
	}
	for index, value := range entries {
		entry := eventObject(value)
		if !eventExceptionParent(entry, index) || !eventFramesConsistent(entry["stackFrames"]) {
			return false
		}
	}
	root := eventObject(entries[0])
	projection := map[string]any{"type": root["type"]}
	if mechanism, present := root["mechanism"]; present {
		projection["mechanism"] = mechanism
	}
	return reflect.DeepEqual(projection, attributes["exception"]) &&
		reflect.DeepEqual(root["stackFrames"], attributes["stackFrames"])
}

func eventExceptionParent(entry map[string]any, index int) bool {
	id, isNumber := entry["id"].(json.Number)
	number, err := id.Float64()
	// Schema validation separately enforces exact integrality and the small
	// index bound. Numeric 0.0/1e0 IDs were accepted by the legacy validator.
	if !isNumber || err != nil || number != float64(index) {
		return false
	}
	parent, present := entry["parentId"]
	if index == 0 {
		return entry["relationship"] == "reported" && !present
	}
	parentNumber, parentValid := parent.(json.Number)
	parentIndex, parentError := parentNumber.Int64()
	return parentValid && parentError == nil && parentIndex >= 0 &&
		parentIndex < int64(index) && entry["relationship"] != "reported"
}

func eventEvidenceConsistent(attributes map[string]any) bool {
	evidence := eventObject(attributes["evidence"])
	area := eventObject(evidence["likelyFixArea"])
	if value, present := area["file"]; present {
		path, valid := value.(string)
		if !valid || !eventRelativePath(path) {
			return false
		}
	}
	return eventCoordinatesConsistent(area) && eventEvidenceStates(evidence)
}

func eventEvidenceStates(evidence map[string]any) bool {
	seen := make(map[string]bool)
	for _, key := range []string{"capturedFields", "missingFields", "redactedFields", "truncatedFields"} {
		if _, present := evidence[key]; !present {
			continue
		}
		fields, valid := evidence[key].([]any)
		if !valid {
			return false
		}
		for _, value := range fields {
			field, valid := value.(string)
			if !valid || seen[field] {
				return false
			}
			seen[field] = true
		}
	}
	return true
}

func eventRelativePath(path string) bool {
	normalized := strings.ReplaceAll(strings.TrimSpace(path), `\`, "/")
	for part := range strings.SplitSeq(normalized, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}
