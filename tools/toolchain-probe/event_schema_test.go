package main

import (
	"encoding/json"
	"strings"
	"testing"
)

const closedSchemaObject = "additionalProperties=false"

func eventSchemaDefinitions(tb testing.TB) map[string]any {
	tb.Helper()
	data, readable := readCheckFile(canonicalSchemaPath)
	document, valid := decodeCheckJSON(data)
	definitions := eventObject(eventObject(document)["$defs"])
	if !readable || !valid || definitions == nil {
		tb.Fatal("canonical schema definitions unavailable")
	}
	return definitions
}

func eventAttributeSchema(tb testing.TB, definitions map[string]any, kind string) map[string]any {
	tb.Helper()
	definition := eventObject(definitions[kind+"Event"])
	clauses, valid := definition["allOf"].([]any)
	if !valid || len(clauses) != 2 {
		tb.Fatal("event schema must retain its base and attribute contracts")
	}
	properties := eventObject(eventObject(clauses[1])["properties"])
	attributes := eventObject(properties["attributes"])
	if attributes == nil {
		tb.Fatal("event attribute schema unavailable")
	}
	return attributes
}

func assertSchemaFields(tb testing.TB, object map[string]any, fields ...string) {
	tb.Helper()
	for _, field := range fields {
		if !checkExpectedFields([]map[string]any{object}, []string{field}, jsonEventFields) {
			tb.Fatalf("schema contract mismatch: %s", field)
		}
	}
}

func TestEventSchemaFamiliesAndRequiredFields(t *testing.T) {
	t.Parallel()
	definitions := eventSchemaDefinitions(t)
	assertSchemaFields(t, eventObject(definitions["eventBase"]),
		`properties.type.enum=["release","environment","issue","log","span","action","metric"]`)
	for _, contract := range eventContracts() {
		attributes := eventAttributeSchema(t, definitions, contract.kind)
		required, err := json.Marshal(strings.Fields(contract.required))
		if err != nil {
			t.Fatal(err)
		}
		assertSchemaFields(t, attributes, "required="+string(required),
			`properties.context={"$ref":"#/$defs/telemetryContext"}`)
	}
	assertSchemaFields(t, eventObject(definitions["telemetryContext"]),
		closedSchemaObject, `required=["schemaVersion"]`, "minProperties=2")
	assertSchemaFields(t, eventObject(definitions["telemetryTags"]), "maxProperties=32")
	assertSchemaFields(t, eventAttributeSchema(t, definitions, fixtureIssueKind),
		`properties.level.enum=["info","warning","error","critical"]`)
	assertSchemaFields(t, eventAttributeSchema(t, definitions, fixtureLogKind),
		`properties.level.enum=["debug","info","warning","error"]`)
	assertSchemaFields(t, eventAttributeSchema(t, definitions, checkSpanKind),
		`properties.status.enum=["ok","error"]`)
	assertSchemaFields(t, eventAttributeSchema(t, definitions, "action"),
		`properties.status.enum=["queued","running","success","failure"]`)
	metric := eventAttributeSchema(t, definitions, fixtureMetricKind)
	assertSchemaFields(t, metric,
		`properties.kind.enum=["counter","gauge","histogram"]`,
		`properties.temporality.enum=["delta","cumulative","instant"]`,
		`properties.description.type="string"`, "properties.description.minLength=1",
		"properties.description.maxLength=1024")
	value, found := checkField(metric, []string{"properties", fixtureDescriptionKey, "pattern"})
	pattern, isString := value.(string)
	if !found || !isString || !strings.Contains(pattern, `\S`) || !strings.Contains(pattern, `\ud800-\udfff`) {
		t.Fatal("metric description lost its nonblank or surrogate restriction")
	}
}

func TestEventSchemaDiagnosticDefinitions(t *testing.T) {
	t.Parallel()
	definitions := eventSchemaDefinitions(t)
	for _, item := range []struct {
		name   string
		fields []string
	}{
		{"issueExceptionChain", []string{"properties.entries.maxItems=8"}},
		{"issueExceptionChainEntry", []string{
			`properties.messageState.enum=["captured","truncated","redacted","not_captured"]`,
			`properties.stackFramesState.enum=["captured","truncated","not_captured"]`,
		}},
		{"issueException", []string{
			closedSchemaObject, `required=["type"]`,
			`properties.mechanism={"$ref":"#/$defs/issueExceptionMechanism"}`,
		}},
		{"issueExceptionMechanism", []string{closedSchemaObject, `required=["type","handled"]`}},
		{"issueBreadcrumb", []string{
			closedSchemaObject, `required=["timestamp","category"]`,
			`properties.data={"$ref":"#/$defs/issueBreadcrumbData"}`,
		}},
		{"issueBreadcrumbData", []string{"maxProperties=8"}},
		{"issueDiagnosticEvidence", []string{
			closedSchemaObject,
			`properties.likelyFixArea={"$ref":"#/$defs/issueLikelyFixArea"}`,
		}},
		{"issueEvidenceFields", []string{"maxItems=32"}},
		{"nativeStackFrame", []string{`required=["imageUuid","architecture","instructionOffset"]`}},
		{"spanLinkSummary", []string{
			closedSchemaObject, `required=["traceId","spanId"]`,
			`properties.sampled={"type":"boolean"}`, `properties.metadata={"$ref":"#/$defs/metadata"}`,
			`properties.traceId.pattern="^[0-9a-fA-F]{32}$"`,
			`properties.traceId.not={"const":"00000000000000000000000000000000"}`,
			`properties.spanId.pattern="^[0-9a-fA-F]{16}$"`, `properties.spanId.not={"const":"0000000000000000"}`,
		}},
	} {
		t.Run(item.name, func(t *testing.T) {
			t.Parallel()
			assertSchemaFields(t, eventObject(definitions[item.name]), item.fields...)
		})
	}
	assertSchemaFields(t, eventAttributeSchema(t, definitions, fixtureIssueKind),
		`properties.exceptionChain={"$ref":"#/$defs/issueExceptionChain"}`,
		`properties.exception={"$ref":"#/$defs/issueException"}`,
		`properties.breadcrumbs={"type":"array","minItems":1,"maxItems":64,"items":{"$ref":"#/$defs/issueBreadcrumb"}}`,
		`properties.breadcrumbsTruncated={"type":"boolean"}`,
		`properties.evidence={"$ref":"#/$defs/issueDiagnosticEvidence"}`,
		`properties.stackFrames={"type":"array","minItems":1,"maxItems":32,"items":{"$ref":"#/$defs/issueStackFrame"}}`,
		"properties.nativeStackFrames.maxItems=32",
		`properties.nativeStackFrames.items={"$ref":"#/$defs/nativeStackFrame"}`)
	assertSchemaFields(t, eventAttributeSchema(t, definitions, checkSpanKind),
		`properties.links={"type":"array","maxItems":8,"items":{"$ref":"#/$defs/spanLinkSummary"}}`)
}

func TestEventSchemaStackFrameContract(t *testing.T) {
	t.Parallel()
	definitions := eventSchemaDefinitions(t)
	assertSchemaFields(t, eventObject(definitions["issueStackFrame"]), `type="object"`,
		closedSchemaObject, `required=["filename","line","column"]`,
		`properties={"filename":{"type":"string","minLength":1,"maxLength":2048,`+
			`"pattern":"^[^?#\\u0000-\\u001f\\u007f]+$"},`+
			`"line":{"type":"integer","minimum":1,"maximum":2147483647},`+
			`"column":{"type":"integer","minimum":1,"maximum":2147483647},`+
			`"function":{"type":"string","minLength":1,"maxLength":256,`+
			`"pattern":"^(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$"},`+
			`"module":{"type":"string","minLength":1,"maxLength":512,`+
			`"pattern":"^(?=.*\\S)[^?#\\u0000-\\u001f\\u007f]+$"},`+
			`"inApp":{"type":"boolean"},"debugId":{"type":"string",`+
			`"pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"}}`)
}
