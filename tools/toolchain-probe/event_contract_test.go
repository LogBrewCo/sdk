package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"testing"
)

const (
	fixtureStackFramesKey  = "stackFrames"
	fixtureNativeFramesKey = "nativeStackFrames"
	fixtureBlankJSON       = `"   "`
	fixtureFunctionKey     = "function"
	fixtureModuleKey       = "module"
	fixtureMetricKind      = "metric"
	fixtureReleaseKind     = "release"
	fixtureIssueKind       = "issue"
	fixtureLogKind         = "log"
	fixtureContextKey      = "context"
	fixtureMetadataKey     = "metadata"
	fixtureNullJSON        = "null"
	fixtureTrueJSON        = "true"
	fixtureUnknown         = "unknown"
	fixtureBreadcrumbsKey  = "breadcrumbs"
	fixtureEvidenceKey     = "evidence"
	fixtureDescriptionKey  = "description"
	fixtureExceptionKey    = "exception"
	fixtureMessageKey      = "message"
	fixtureEventTimestamp  = "2026-06-02T10:00:00Z"
	contractFrame          = `{"filename":"/assets/app.js","line":12,"column":34,` +
		`"function":"checkout","module":"@example/checkout","inApp":true,` +
		`"debugId":"11111111-2222-4333-8444-555555555555"}`
	contractBreadcrumb = `{"timestamp":"2026-06-02T09:59:58.123Z","type":"navigation",` +
		`"category":"navigation","level":"info","message":"Opened /checkout/:step",` +
		`"data":{"route":"/checkout/:step","cached":false,"attempt":2}}`
	contractSpanEvent = `{"name":"db.pool.wait","timestamp":"2026-06-02T10:00:04Z",` +
		`"metadata":{"phase":"before_query","attempt":1,"retryable":false}}`
	contractSpanLink = `{"traceId":"11111111111111111111111111111111","spanId":"2222222222222222",` +
		`"sampled":true,"metadata":{"relation":"batch_item","shard":3}}`
	contractNativeFrame = `{"imageUuid":"01234567-89ab-cdef-0123-456789abcdef",` +
		`"architecture":"arm64","instructionOffset":"0000000000001234"}`
	contractContext = `{"schemaVersion":1,"resource":{` +
		`"service":{"name":"checkout-api","version":"2.4.0"},` +
		`"deployment":{"environment":"production","release":"checkout@2.4.0"},` +
		`"runtime":{"name":"node","version":"22"},"framework":{"name":"fastify","version":"5"},` +
		`"operatingSystem":{"name":"linux","version":"6"},"device":{"architecture":"arm64"},` +
		`"application":{"name":"checkout","build":"240"}},` +
		`"trace":{"traceId":"4bf92f3577b34da6a3ce929d0e0e4736","spanId":"b7ad6b7169203331","sampled":true},` +
		`"session":{"id":"session_01","previousId":"session_00"},` +
		`"subject":{"id":"subject_01","kind":"user"},"tags":{"plan":"team","region":"eu"}}`
)

type eventField struct{ key, value string }

type eventContract struct{ kind, required, attributes string }

func eventContracts() []eventContract {
	return []eventContract{
		{fixtureReleaseKind, "version", `{"version":"1.2.3","commit":"abc123def456","notes":"Public release marker"}`},
		{"environment", "name", `{"name":"production","region":"global"}`},
		{fixtureIssueKind, "title level", `{"title":"Checkout timeout","level":"error","message":"Request timed out"}`},
		{fixtureLogKind, "message level", `{"message":"worker started","level":"info","logger":"job-runner"}`},
		{checkSpanKind, "name traceId spanId status", `{"name":"GET /health","traceId":"trace_001",` +
			`"spanId":"span_001","status":"ok","durationMs":12.5}`},
		{"action", "name status", `{"name":"deploy","status":"success"}`},
		{fixtureMetricKind, "name kind value unit temporality", `{"name":"checkout.requests","kind":"counter",` +
			`"value":42,"unit":"{request}","temporality":"delta",` +
			`"description":"Number of checkout requests accepted by the application."}`},
	}
}

// A blank replacement removes a field; the JSON string literal "" is distinct.
// RawMessage preserves lexical integers and deliberately invalid Unicode in
// negative fixtures without rounding through float64 or replacing surrogates.
func eventContractFixture(tb testing.TB, kind string, changes ...eventField) []byte {
	tb.Helper()
	for _, contract := range eventContracts() {
		if contract.kind == kind {
			encoded := eventObjectFixture(tb, contract.attributes, changes...)
			return fmt.Appendf(nil, `{"sdk":{"name":"test","language":"go","version":"1.0.0"},`+
				`"events":[{"type":%q,"id":"event_001","timestamp":"2026-06-02T10:00:00Z","attributes":%s}]}`,
				kind, encoded)
		}
	}
	tb.Fatal("unknown fixture event family")
	return nil
}

func eventObjectFixture(tb testing.TB, source string, changes ...eventField) []byte {
	tb.Helper()
	var attributes map[string]json.RawMessage
	if err := json.Unmarshal([]byte(source), &attributes); err != nil || attributes == nil {
		tb.Fatal("invalid fixture object")
	}
	for _, field := range changes {
		if field.value == "" {
			if _, present := attributes[field.key]; !present {
				tb.Fatal("fixture removal did not target an existing field")
			}
			delete(attributes, field.key)
		} else {
			attributes[field.key] = json.RawMessage(field.value)
		}
	}
	encoded, err := json.Marshal(attributes)
	if err != nil {
		tb.Fatal(err)
	}
	return encoded
}

// Reviewed 2026-09-05: expected is an assertion oracle, not a behavior switch.
//
//revive:disable-next-line:flag-parameter Both allowed/rejected cases run the same validator and require no error.
func assertEventContract(tb testing.TB, checker *checkedSchema, data []byte, expected bool) {
	tb.Helper()
	valid, err := checker.validateEventBatch(data)
	if valid != expected || err != nil {
		tb.Fatalf("event contract: valid=%v want=%v error=%v", valid, expected, err)
	}
}

func TestEventContractRequiredFieldsAndContext(t *testing.T) {
	t.Parallel()
	checker := canonicalEventSchema(t)
	for _, contract := range eventContracts() {
		t.Run(contract.kind, func(t *testing.T) {
			t.Parallel()
			assertEventContract(t, checker, eventContractFixture(t, contract.kind), true)
			for _, field := range []eventField{
				{fixtureContextKey, contractContext},
				{fixtureMetadataKey, `{"text":"value","count":1,"fraction":1.5,"flag":false,"missing":null}`},
			} {
				assertEventContract(t, checker, eventContractFixture(t, contract.kind, field), true)
			}
			for key := range strings.FieldsSeq(contract.required) {
				for _, value := range []string{"", fixtureNullJSON, "false", `""`} {
					data := eventContractFixture(t, contract.kind, eventField{key, value})
					assertEventContract(t, checker, data, false)
				}
			}
			for _, field := range []eventField{
				{"unexpected", `true`},
				{fixtureMetadataKey, `[]`},
				{fixtureMetadataKey, fixtureNullJSON},
				{fixtureMetadataKey, `{"nested":{"nope":true}}`},
				{fixtureContextKey, fixtureNullJSON},
				{fixtureContextKey, `{"schemaVersion":1,"session":{"id":"same","previousId":" same "}}`},
			} {
				assertEventContract(t, checker, eventContractFixture(t, contract.kind, field), false)
			}
		})
	}
}

func TestEventContractTopLevelAndEnums(t *testing.T) {
	t.Parallel()
	checker := canonicalEventSchema(t)
	base := string(eventContractFixture(t, fixtureReleaseKind))
	for _, change := range []struct{ before, after string }{
		{`"sdk":`, `"extra":true,"sdk":`},
		{`"name":"test"`, `"name":"test","extra":true`},
		{`"id":"event_001"`, `"id":"event_001","unexpected":true`},
		{`"type":"release"`, `"type":"unknown"`},
		{`"name":"test"`, `"name":""`},
		{`"id":"event_001"`, `"id":false`},
		{fixtureEventTimestamp, `2026-06-02T10:00:00`},
		{fixtureEventTimestamp, `2026-06-02 10:00:00+00:00`},
		{fixtureEventTimestamp, `20260602T100000+0000`},
	} {
		data := strings.Replace(base, change.before, change.after, 1)
		if data == base {
			t.Fatal("fixture mutation did not apply")
		}
		assertEventContract(t, checker, []byte(data), false)
	}
	for _, item := range []struct{ kind, field, allowed string }{
		{fixtureIssueKind, "level", "info warning error critical"},
		{fixtureLogKind, "level", "debug info warning error"},
		{checkSpanKind, "status", "ok error"},
		{"action", "status", "queued running success failure"},
	} {
		for value := range strings.FieldsSeq(item.allowed + " unknown") {
			data := eventContractFixture(t, item.kind, eventField{item.field, strconv.Quote(value)})
			assertEventContract(t, checker, data, value != fixtureUnknown)
		}
	}
}

type eventAttributeCase struct{ name, kind, field, value string }

func rejectedEventAttributes() []eventAttributeCase {
	return []eventAttributeCase{
		{"metadata-shape", fixtureReleaseKind, fixtureMetadataKey, `["not","an","object"]`},
		{"empty-commit", fixtureReleaseKind, "commit", `""`},
		{"logger-shape", fixtureLogKind, "logger", `{"name":"job-runner"}`},
		{"boolean-duration", checkSpanKind, "durationMs", `true`},
		{"context-version", fixtureReleaseKind, fixtureContextKey, `{"schemaVersion":2,"tags":{"plan":"team"}}`},
		{"context-unknown", fixtureReleaseKind, fixtureContextKey, `{"schemaVersion":1,"email":"person@example.test"}`},
		{"context-empty-device", fixtureReleaseKind, fixtureContextKey, `{"schemaVersion":1,"resource":{"device":{}}}`},
		{
			"context-zero-trace", fixtureReleaseKind, fixtureContextKey,
			`{"schemaVersion":1,"trace":{"traceId":"00000000000000000000000000000000"}}`,
		},
		{
			"context-subject-kind", fixtureReleaseKind, fixtureContextKey,
			`{"schemaVersion":1,"subject":{"id":"subject_01","kind":"identified"}}`,
		},
		{"context-tag-key", fixtureReleaseKind, fixtureContextKey, `{"schemaVersion":1,"tags":{"unsafe key":"value"}}`},
		{
			"context-tag-control", fixtureReleaseKind, fixtureContextKey,
			`{"schemaVersion":1,"tags":{"plan":"safe\u0085unsafe"}}`,
		},
		{
			"frame-shape", fixtureIssueKind, fixtureStackFramesKey,
			`[{"filename":"/assets/app.js?private=value","line":0,"column":2}]`,
		},
		{
			"exception-mechanism", fixtureIssueKind, fixtureExceptionKey,
			`{"type":"CheckoutError","mechanism":{"type":"react.error_boundary"}}`,
		},
		{"empty-breadcrumbs", fixtureIssueKind, fixtureBreadcrumbsKey, `[]`},
		{
			"breadcrumb-data", fixtureIssueKind, fixtureBreadcrumbsKey,
			`[{"timestamp":"2026-06-02T09:59:58Z","category":"navigation","data":{"nested":{"private":true}}}]`,
		},
		{
			"breadcrumb-timezone", fixtureIssueKind, fixtureBreadcrumbsKey,
			`[{"timestamp":"2026-06-02T09:59:58","category":"navigation"}]`,
		},
		{"breadcrumb-truncation", fixtureIssueKind, "breadcrumbsTruncated", `"yes"`},
		{
			"span-event-metadata", checkSpanKind, "events",
			`[{"name":"db.pool.wait","metadata":{"nested":{"nope":true}}}]`,
		},
		{
			"span-link-metadata", checkSpanKind, "links",
			`[{"traceId":"11111111111111111111111111111111","spanId":"2222222222222222",` +
				`"metadata":{"nested":{"nope":true}}}]`,
		},
		{"empty-native-frames", fixtureIssueKind, fixtureNativeFramesKey, `[]`},
		{"empty-evidence", fixtureIssueKind, fixtureEvidenceKey, `{}`},
		{"missing-fix-location", fixtureIssueKind, fixtureEvidenceKey, `{"likelyFixArea":{"inApp":true}}`},
		{
			"spaced-absolute-fix", fixtureIssueKind, fixtureEvidenceKey,
			`{"likelyFixArea":{"file":" /srv/example/app.py"}}`,
		},
	}
}

func TestEventContractAttributeRejections(t *testing.T) {
	t.Parallel()
	checker := canonicalEventSchema(t)
	for _, item := range rejectedEventAttributes() {
		t.Run(item.name, func(t *testing.T) {
			t.Parallel()
			data := eventContractFixture(t, item.kind, eventField{item.field, item.value})
			assertEventContract(t, checker, data, false)
		})
	}
}

func TestEventContractMetricKindsAndDescriptions(t *testing.T) {
	t.Parallel()
	checker := canonicalEventSchema(t)
	for kind := range strings.FieldsSeq("counter gauge histogram unknown") {
		for temporality := range strings.FieldsSeq("delta cumulative instant unknown") {
			data := eventContractFixture(t, fixtureMetricKind, eventField{"kind", strconv.Quote(kind)},
				eventField{"temporality", strconv.Quote(temporality)})
			valid := kind != fixtureUnknown && temporality != fixtureUnknown &&
				((kind == "gauge") == (temporality == "instant"))
			assertEventContract(t, checker, data, valid)
		}
	}
	for _, value := range []string{fixtureTrueJSON, "-1"} {
		assertEventContract(t, checker, eventContractFixture(t, fixtureMetricKind, eventField{"value", value}), false)
	}
	for _, description := range []string{
		fixtureNullJSON, `""`, fixtureBlankJSON, strconv.Quote(strings.Repeat("M", longDescriptionSize)),
		`"request\u0085count"`, `"request\u2028count"`,
	} {
		data := eventContractFixture(t, fixtureMetricKind, eventField{fixtureDescriptionKey, description})
		assertEventContract(t, checker, data, false)
	}
	data := eventContractFixture(t, fixtureMetricKind,
		eventField{fixtureDescriptionKey, strconv.Quote(strings.Repeat("M", longDescriptionSize-1))})
	assertEventContract(t, checker, data, true)
	data = eventContractFixture(t, fixtureMetricKind, eventField{fixtureDescriptionKey, `"request\ud800count"`})
	if valid, err := checker.validateEventBatch(data); valid || !errors.Is(err, errCheckInput) {
		t.Fatal("unpaired surrogate was not an input error")
	}
}

func fixtureArray(value string, count int) string {
	return "[" + strings.TrimSuffix(strings.Repeat(value+",", count), ",") + "]"
}

func TestEventContractCollectionBounds(t *testing.T) {
	t.Parallel()
	checker := canonicalEventSchema(t)
	const (
		frameLimit       = 32
		breadcrumbLimit  = 64
		spanSummaryLimit = 8
	)
	for _, item := range []struct {
		kind, field, element string
		minimum, maximum     int
	}{
		{fixtureIssueKind, fixtureStackFramesKey, contractFrame, 1, frameLimit},
		{fixtureIssueKind, fixtureNativeFramesKey, contractNativeFrame, 1, frameLimit},
		{fixtureIssueKind, fixtureBreadcrumbsKey, contractBreadcrumb, 1, breadcrumbLimit},
		{checkSpanKind, "events", contractSpanEvent, 0, spanSummaryLimit},
		{checkSpanKind, "links", contractSpanLink, 0, spanSummaryLimit},
	} {
		t.Run(item.field, func(t *testing.T) {
			t.Parallel()
			for _, count := range []int{0, 1, item.maximum, item.maximum + 1} {
				field := eventField{item.field, fixtureArray(item.element, count)}
				data := eventContractFixture(t, item.kind, field)
				assertEventContract(t, checker, data, count >= item.minimum && count <= item.maximum)
			}
		})
	}
}

func TestEventContractFrameIdentity(t *testing.T) {
	t.Parallel()
	checker := canonicalEventSchema(t)
	const functionLimit = 256
	for _, field := range []eventField{
		{fixtureFunctionKey, strconv.Quote(strings.Repeat("x", functionLimit+1))},
		{fixtureFunctionKey, strconv.Quote(strings.Repeat("🧪", functionLimit+1))},
		{fixtureFunctionKey, fixtureNullJSON},
		{fixtureFunctionKey, fixtureBlankJSON},
		{fixtureModuleKey, `"@example/checkout?private=value"`},
		{fixtureModuleKey, fixtureNullJSON},
		{fixtureModuleKey, fixtureBlankJSON},
		{"inApp", `"yes"`},
		{"inApp", fixtureNullJSON},
		{"debugId", `"not-a-uuid"`},
		{"line", "1.0"},
		{"column", "2e0"},
	} {
		frame := eventObjectFixture(t, contractFrame, field)
		data := eventContractFixture(t, fixtureIssueKind,
			eventField{fixtureStackFramesKey, fixtureArray(string(frame), 1)})
		assertEventContract(t, checker, data, false)
	}
	frame := eventObjectFixture(t, contractFrame,
		eventField{fixtureFunctionKey, strconv.Quote(strings.Repeat("🧪", functionLimit))})
	data := eventContractFixture(t, fixtureIssueKind, eventField{fixtureStackFramesKey, fixtureArray(string(frame), 1)})
	assertEventContract(t, checker, data, true)
	for _, field := range []eventField{
		{"imageUuid", `"01234567-89AB-CDEF-0123-456789ABCDEF"`},
		{"architecture", `"arm64-v8a"`},
		{"instructionOffset", `"1234"`},
	} {
		native := eventObjectFixture(t, contractNativeFrame, field)
		data := eventContractFixture(t, fixtureIssueKind,
			eventField{fixtureNativeFramesKey, fixtureArray(string(native), 1)})
		assertEventContract(t, checker, data, false)
	}
}

func TestEventContractContextAndBreadcrumbFieldBounds(t *testing.T) {
	t.Parallel()
	checker := canonicalEventSchema(t)
	const tagLimit = 32
	for _, count := range []int{8, 9, tagLimit, tagLimit + 1} {
		fields := make(map[string]string, count)
		for index := range count {
			fields["field_"+strconv.Itoa(index)] = "value"
		}
		encoded, err := json.Marshal(fields)
		if err != nil {
			t.Fatal(err)
		}
		context := `{"schemaVersion":1,"tags":` + string(encoded) + `}`
		data := eventContractFixture(t, fixtureReleaseKind, eventField{fixtureContextKey, context})
		assertEventContract(t, checker, data, count <= tagLimit)
		breadcrumb := eventObjectFixture(t, contractBreadcrumb, eventField{"data", string(encoded)})
		data = eventContractFixture(t, fixtureIssueKind,
			eventField{fixtureBreadcrumbsKey, fixtureArray(string(breadcrumb), 1)})
		assertEventContract(t, checker, data, count <= 8)
	}
}

func TestEventContractExceptionChainBounds(t *testing.T) {
	t.Parallel()
	checker := canonicalEventSchema(t)
	const chainLimit = 8
	for _, count := range []int{0, 1, 2, chainLimit, chainLimit + 1} {
		entries := make([]string, count)
		for index := range count {
			if index == 0 {
				entries[index] = `{"id":0,"relationship":"reported","type":"CheckoutError",` +
					`"message":"Checkout could not complete","messageState":"captured","module":"checkout.api",` +
					`"mechanism":{"type":"manual","handled":true},"stackFramesState":"captured",` +
					`"stackFrames":` + fixtureArray(contractFrame, 1) + `}`
			} else {
				entries[index] = fmt.Sprintf(`{"id":%d,"parentId":%d,"relationship":"cause",`+
					`"type":"PaymentTimeout","messageState":"redacted","module":"checkout.payments",`+
					`"mechanism":{"type":"python.cause","handled":true},"stackFramesState":"truncated",`+
					`"stackFrames":%s}`, index, index-1, fixtureArray(contractFrame, 1))
			}
		}
		chain := `{"entries":[` + strings.Join(entries, ",") + `],"truncated":false}`
		data := eventContractFixture(t, fixtureIssueKind,
			eventField{fixtureExceptionKey, `{"type":"CheckoutError","mechanism":{"type":"manual","handled":true}}`},
			eventField{fixtureStackFramesKey, fixtureArray(contractFrame, 1)}, eventField{"exceptionChain", chain})
		assertEventContract(t, checker, data, count > 0 && count <= chainLimit)
	}
}

func TestEventContractDiagnosticEvidence(t *testing.T) {
	t.Parallel()
	checker := canonicalEventSchema(t)
	const typeLimit = 256
	for _, count := range []int{typeLimit, typeLimit + 1} {
		data := eventContractFixture(t, fixtureIssueKind,
			eventField{fixtureExceptionKey, `{"type":` + strconv.Quote(strings.Repeat("x", count)) + `}`})
		assertEventContract(t, checker, data, count == typeLimit)
	}
	data := eventContractFixture(t, fixtureIssueKind,
		eventField{
			fixtureExceptionKey,
			`{"type":"CheckoutError","mechanism":{"type":"react.error_boundary","handled":true}}`,
		},
		eventField{fixtureBreadcrumbsKey, fixtureArray(contractBreadcrumb, 1)},
		eventField{"breadcrumbsTruncated", fixtureTrueJSON},
		eventField{fixtureEvidenceKey, `{"likelyRootCause":"The payment provider exhausted its retry budget.",` +
			`"likelyFixArea":{"component":"checkout-api","file":"src/payments/gateway.py","line":42,"inApp":true},` +
			`"impact":{"failedAction":"checkout.submit","userVisibleOutcome":"The order was not confirmed."},` +
			`"capturedFields":["provider.status"],"redactedFields":["provider.message"]}`})
	assertEventContract(t, checker, data, true)
}

func TestEventContractExceptionEvidencePresence(t *testing.T) {
	t.Parallel()
	checker := canonicalEventSchema(t)
	for _, item := range []struct {
		field, state string
		present      bool
	}{
		{fixtureMessageKey, "captured", true},
		{fixtureMessageKey, "truncated", true},
		{fixtureMessageKey, "redacted", false},
		{fixtureMessageKey, "not_captured", false},
		{fixtureStackFramesKey, "captured", true},
		{fixtureStackFramesKey, "truncated", true},
		{fixtureStackFramesKey, "not_captured", false},
	} {
		before, evidence := fixtureMessageRedacted, `"Request failed"`
		if item.field == fixtureStackFramesKey {
			before, evidence = fixtureUncapturedStack, fixtureArray(contractFrame, 1)
		}
		for _, value := range []eventField{
			{"absent", ""}, {"null", fixtureNullJSON}, {"empty-string", `""`}, {"populated", evidence},
		} {
			t.Run(item.field+"/"+item.state+"/"+value.key, func(t *testing.T) {
				t.Parallel()
				replacement := `"` + item.field + `State":"` + item.state + `"`
				if value.value != "" {
					replacement += `,"` + item.field + `":` + value.value
				}
				data := strings.Replace(semanticBatchFixture, before, replacement, 1)
				valid := item.present && value.key == "populated" || !item.present && value.key == "absent"
				assertEventContract(t, checker, []byte(data), valid)
			})
		}
	}
}

func TestEventContractOmittedAttributesStayTyped(t *testing.T) {
	t.Parallel()
	checker := canonicalEventSchema(t)
	for kind, fields := range map[string]string{
		fixtureIssueKind: "nativeStackFrames stackFrames exception exceptionChain breadcrumbs evidence",
		checkSpanKind:    "events links",
	} {
		for field := range strings.FieldsSeq(fields) {
			t.Run(kind+"/"+field, func(t *testing.T) {
				t.Parallel()
				data := eventContractFixture(t, kind, eventField{field, fixtureNullJSON})
				assertEventContract(t, checker, data, false)
			})
		}
	}
}
