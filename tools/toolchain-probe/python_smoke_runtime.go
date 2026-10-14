package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"strconv"
	"strings"
	"sync"
)

//go:embed testdata/python_public_runtime.py
var pythonPublicRuntime string

const (
	pythonSmokeDependencyVersionLimit = 128
	pythonFlaskErrorBody              = "flask_error_body"
	pythonFlaskBlockedBody            = "flask_blocked_body"
	pythonFlaskBody                   = "flask_body"
	pythonTraceID                     = "traceId"
	pythonSpanID                      = "spanId"
)

type pythonRuntimeMode string

const (
	pythonRuntimeNormal    pythonRuntimeMode = ""
	pythonRuntimeOptimized pythonRuntimeMode = "-O"
)

func checkPythonPublicRuntime(
	ctx context.Context, python, directory string, versions map[string]string, checker *checkedSchema,
) pythonConsumerOutput {
	return runPythonRuntimePair(ctx, func(ctx context.Context, mode pythonRuntimeMode) pythonConsumerOutput {
		result := runPythonConsumerProcess(ctx, python, directory, pythonPublicRuntimeArguments(versions, mode))
		result.valid = result.valid && validPythonPublicRuntime(result.stdout, versions, checker, mode)
		return result
	})
}

func runPythonRuntimePair(
	ctx context.Context, run func(context.Context, pythonRuntimeMode) pythonConsumerOutput,
) pythonConsumerOutput {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	modes := [2]pythonRuntimeMode{pythonRuntimeNormal, pythonRuntimeOptimized}
	results := make(chan pythonConsumerOutput, len(modes))
	var work sync.WaitGroup
	for _, mode := range modes {
		work.Go(func() {
			results <- run(ctx, mode)
		})
	}
	result := pythonConsumerOutput{stdout: nil, stderr: nil, valid: true}
	for range modes {
		if next := <-results; !next.valid && result.valid {
			result = next
			cancel()
		}
	}
	work.Wait()
	return result
}

func pythonPublicRuntimeArguments(versions map[string]string, mode pythonRuntimeMode) []string {
	arguments := []string{"-I", "-B"}
	if mode == pythonRuntimeOptimized {
		arguments = append(arguments, string(mode))
	}
	arguments = append(arguments, "-c", pythonPublicRuntime)
	for _, extra := range []string{pythonExtraARQ, pythonExtraDramatiq, pythonExtraCelery} {
		id := pythonCoreID
		if extra == pythonExtraCelery {
			id = pythonFastAPIID
		}
		flag := "0"
		if strings.Contains(pythonSmokeExtras(id, versions[id]), extra) {
			flag = "1"
		}
		arguments = append(arguments, flag)
	}
	return arguments
}

func validPythonPublicRuntime(
	data []byte, versions map[string]string, checker *checkedSchema, mode pythonRuntimeMode,
) bool {
	if !checkPackageDocument(data, jsonFields, []string{
		"flush_status=202", "flush_attempts=1", "recorded_bodies=1", "pending_events=0",
		"shutdown_status=202", "shutdown_attempts=1", "shutdown_accepted_events=1",
		"shutdown_recorded_bodies=1", "shutdown_closed=true",
		`db_rows=[["checkout"]]`, `otel_exporter_result="SUCCESS"`, "flask_status=200",
		`flask_response={"orderId":42}`, "flask_recorded_bodies=3", `django_config_type="LogBrewDjangoConfig"`,
		"flask_blocked_status=403", "flask_order_calls=[42]",
		"flask_error_status=500", "flask_closed=true", "flask_pending_events=0",
		"optimized=" + strconv.FormatBool(mode == pythonRuntimeOptimized),
	}) {
		return false
	}
	value, readable := decodeCheckDocument(data)
	document, object := value.(map[string]any)
	core, hasCore := document["body"].(string)
	middleware, isNumber := document["fastapi_middleware_count"].(json.Number)
	count, err := strconv.ParseUint(string(middleware), 10, 64)
	return readable && object && hasCore &&
		isNumber && err == nil && count > 0 &&
		validPythonPublicVersions(document, versions) &&
		validPythonSmokeBody([]byte(core), checker, []string{
			"blocked@example.test", "payload", "connection", ":memory:", "CREATE TABLE", "INSERT INTO", "SELECT name",
		}) &&
		validPythonFlaskRequests(document, checker) &&
		validPythonPublicSpans([]byte(core))
}

func validPythonFlaskRequests(document map[string]any, checker *checkedSchema) bool {
	for _, request := range []struct{ key, status, route string }{
		{"flask_body", "200", "/orders/<int:order_id>"},
		{pythonFlaskBlockedBody, "403", "/orders/<int:order_id>"},
		{pythonFlaskErrorBody, "500", "/failure"},
	} {
		body, present := document[request.key].(string)
		if !present || !validPythonFlaskRequest([]byte(body), checker, request.status, request.route) {
			return false
		}
	}
	return true
}

func validPythonFlaskRequest(data []byte, checker *checkedSchema, status, route string) bool {
	forbidden := []string{"/orders/42", "proof_marker", "excluded", "private-error-marker"}
	if !validPythonSmokeBody(data, checker, forbidden) {
		return false
	}
	value, _ := decodeCheckJSON(data)
	events, isArray := eventObject(value)["events"].([]any)
	if !isArray {
		return false
	}
	attributes := make(map[string]map[string]any)
	for _, raw := range events {
		event := eventObject(raw)
		kind, isString := event["type"].(string)
		if !isString {
			return false
		}
		if _, duplicate := attributes[kind]; duplicate {
			return false
		}
		attributes[kind] = eventObject(event["attributes"])
	}
	span, metric := attributes["span"], attributes["metric"]
	metricTrace := eventObject(eventObject(metric["context"])["trace"])
	if metricTrace[pythonTraceID] != span[pythonTraceID] || metricTrace[pythonSpanID] != span[pythonSpanID] {
		return false
	}
	spanStatus := "ok"
	expectedCount := 2
	if status == "500" {
		spanStatus, expectedCount = "error", 3
		issue := attributes["issue"]
		link := eventObject(issue["metadata"])
		if issue["message"] != "Unhandled exception" || link[pythonTraceID] != span[pythonTraceID] ||
			link[pythonSpanID] != span[pythonSpanID] {
			return false
		}
	}
	return len(attributes) == expectedCount && metric["value"] == span["durationMs"] &&
		checkExpectedFields([]map[string]any{span}, []string{
			"name=" + strconv.Quote("GET "+route), "status=" + strconv.Quote(spanStatus),
			"metadata.status_code=" + status,
		}, jsonEventFields) &&
		checkExpectedFields([]map[string]any{metric}, []string{
			`name="http.server.duration"`, `kind="histogram"`, `temporality="delta"`, `unit="ms"`,
			"metadata.statusCode=" + status, "metadata.routeTemplate=" + strconv.Quote(route),
		}, jsonEventFields)
}

func validPythonSmokeBody(data []byte, checker *checkedSchema, forbidden []string) bool {
	if checker == nil {
		return false
	}
	for _, marker := range forbidden {
		if bytes.Contains(data, []byte(marker)) {
			return false
		}
	}
	valid, err := checker.validateEventBatch(data)
	return err == nil && valid
}

func validPythonPublicVersions(document map[string]any, expected map[string]string) bool {
	versions, object := document["versions"].(map[string]any)
	requirements, hasRequirements := document["requirements"].(map[string]any)
	if !object || !hasRequirements || len(expected) != len(pythonReleaseCatalog()) {
		return false
	}
	for _, spec := range pythonReleaseCatalog() {
		if versions[spec.id] != expected[spec.id] || !validPythonPackageVersion(expected[spec.id]) {
			return false
		}
		for extra := range strings.SplitSeq(strings.Trim(pythonSmokeExtras(spec.id, expected[spec.id]), "[]"), ",") {
			if extra != "" && !validPythonOptionalRuntime(versions, requirements, spec.id, extra) {
				return false
			}
		}
	}
	return true
}

func validPythonOptionalRuntime(versions, requirements map[string]any, id, extra string) bool {
	version, present := versions[extra].(string)
	entries, array := requirements[id].([]any)
	if !present || version == "" || len(version) > pythonSmokeDependencyVersionLimit || !array {
		return false
	}
	dependency := map[string]string{
		"rq": "rq<3,>=2", pythonExtraARQ: "arq<1,>=0.28", pythonExtraDramatiq: "dramatiq<3,>=2.2.1",
		pythonExtraCelery: "logbrew-sdk[celery]",
	}[extra]
	for _, entry := range entries {
		text, isString := entry.(string)
		if isString && strings.Contains(text, dependency) && strings.Contains(text, `extra == "`+extra+`"`) {
			return true
		}
	}
	return false
}

func validPythonPublicSpans(data []byte) bool {
	document, decoded := decodeCheckJSON(data)
	root, object := document.(map[string]any)
	events, array := root["events"].([]any)
	if !decoded || !object || !array {
		return false
	}
	database, links := 0, 0
	for _, raw := range events {
		event, valid := raw.(map[string]any)
		if !valid || event["type"] != "span" {
			continue
		}
		framework, _ := checkField(event, []string{"attributes", "metadata", "framework"})
		if framework == "dbapi" {
			database++
		}
		if event["id"] == "evt_public_pypi_span_links" {
			if !checkExpectedFields([]map[string]any{event}, []string{
				`attributes.links=[{"traceId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","spanId":"bbbbbbbbbbbbbbbb",` +
					`"sampled":true,"metadata":{"relation":"fan_in"}}]`,
			}, jsonEventFields) {
				return false
			}
			links++
		}
	}
	return database >= 5 && links == 1
}
