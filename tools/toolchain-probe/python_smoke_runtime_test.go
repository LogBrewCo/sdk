package main

import (
	"encoding/json"
	"maps"
	"slices"
	"strings"
	"testing"
)

const (
	pythonSmokeFixtureBody = "body"
	pythonMetricMissing    = "missing-context"
	pythonRuntimeEvents    = "events"
)

func TestPythonPublicRuntimeRejectsUnlinkedFlaskMetrics(t *testing.T) {
	t.Parallel()
	checker := canonicalEventSchema(t)
	for _, key := range []string{pythonFlaskBody, pythonFlaskBlockedBody, pythonFlaskErrorBody} {
		for _, mutation := range []string{pythonMetricMissing, "trace", "span"} {
			document, options := pythonSmokeRuntimeFixture(t)
			batch := eventObject(document[key])
			events, valid := batch[pythonRuntimeEvents].([]any)
			if !valid || len(events) == 0 {
				t.Fatal("Flask events missing")
			}
			metric := eventObject(eventObject(events[len(events)-1])["attributes"])
			trace := eventObject(eventObject(metric["context"])["trace"])
			switch mutation {
			case pythonMetricMissing:
				delete(metric, "context")
			case "trace":
				trace[pythonTraceID] = "dddddddddddddddddddddddddddddddd"
			case "span":
				trace[pythonSpanID] = "dddddddddddddddd"
			default:
				t.Fatal("unknown correlation mutation")
			}
			if validPythonPublicRuntime(
				pythonSmokeRuntimeJSON(t, document), options.versions, checker, pythonRuntimeNormal,
			) {
				t.Errorf("accepted %s metric correlation in %s", mutation, key)
			}
		}
	}
}

func TestPythonPublicRuntimeRejectsDuplicateFlaskMetrics(t *testing.T) {
	t.Parallel()
	checker := canonicalEventSchema(t)
	document, options := pythonSmokeRuntimeFixture(t)
	batch := eventObject(document[pythonFlaskBody])
	events, valid := batch[pythonRuntimeEvents].([]any)
	if !valid || len(events) == 0 {
		t.Fatal("Flask events missing")
	}
	duplicate := maps.Clone(eventObject(events[len(events)-1]))
	if eventObject(duplicate["attributes"])["name"] != "http.server.duration" {
		t.Fatal("Flask duration metric missing")
	}
	duplicate["id"] = "evt_duplicate_duration"
	batch[pythonRuntimeEvents] = append(events, duplicate)
	if validPythonPublicRuntime(pythonSmokeRuntimeJSON(t, document), options.versions, checker, pythonRuntimeNormal) {
		t.Fatal("duplicate request-duration metrics accepted")
	}
}

func pythonSmokeRuntimeFixture(t *testing.T) (map[string]any, pythonSmokeOptions) {
	t.Helper()
	data, readable := readCheckFile("testdata/python_public_runtime.json")
	value, decoded := decodeCheckDocument(data)
	document, object := value.(map[string]any)
	if !readable || !decoded || !object {
		t.Fatal("runtime fixture unavailable")
	}
	versions := make(map[string]string)
	for _, id := range []string{pythonCoreID, pythonFastAPIID, pythonFixturePackage, pythonDjangoID} {
		version, valid := eventObject(document["versions"])[id].(string)
		if !valid {
			t.Fatal("runtime fixture version missing")
		}
		versions[id] = version
	}
	return document, pythonSmokeOptions{versions: versions, manifest: "", artifacts: "", receipt: false}
}

func pythonSmokeRuntimeJSON(t *testing.T, document map[string]any) []byte {
	t.Helper()
	for _, key := range []string{
		pythonSmokeFixtureBody, pythonFlaskBody, pythonFlaskErrorBody, pythonFlaskBlockedBody,
	} {
		document[key] = string(pythonManifestJSON(t, document[key]))
	}
	return pythonManifestJSON(t, document)
}

func TestPythonPublicRuntimeRequiresCompleteEvidence(t *testing.T) {
	t.Parallel()
	checker := canonicalEventSchema(t)
	document, versions := pythonSmokeRuntimeFixture(t)
	if !validPythonPublicRuntime(pythonSmokeRuntimeJSON(t, document), versions.versions, checker, pythonRuntimeNormal) {
		t.Fatal("complete runtime evidence rejected")
	}
	for _, field := range []string{
		"flush_status", "flush_attempts", "recorded_bodies", "pending_events", "db_rows", "otel_exporter_result",
		"flask_status", "flask_response", "flask_recorded_bodies", "django_config_type", "fastapi_middleware_count",
		"flask_error_status", "flask_closed", "flask_pending_events", pythonFlaskErrorBody,
		"flask_blocked_status", "flask_order_calls", pythonFlaskBlockedBody,
		"shutdown_status", "shutdown_attempts", "shutdown_accepted_events",
		"shutdown_recorded_bodies", "shutdown_closed",
		"versions", "requirements", "optimized",
	} {
		document, versions := pythonSmokeRuntimeFixture(t)
		delete(document, field)
		if validPythonPublicRuntime(
			pythonSmokeRuntimeJSON(t, document), versions.versions, checker, pythonRuntimeNormal,
		) {
			t.Errorf("missing runtime evidence accepted: %s", field)
		}
	}
}

func TestPythonPublicRuntimeBindsOptimizationMode(t *testing.T) {
	t.Parallel()
	checker := canonicalEventSchema(t)
	for _, mode := range []pythonRuntimeMode{pythonRuntimeNormal, pythonRuntimeOptimized} {
		document, options := pythonSmokeRuntimeFixture(t)
		optimized := mode == pythonRuntimeOptimized
		arguments := pythonPublicRuntimeArguments(options.versions, mode)
		if !slices.Contains(arguments, "-I") || !slices.Contains(arguments, "-B") ||
			slices.Contains(arguments, "-O") != optimized {
			t.Fatal("runtime arguments do not enforce isolated bytecode-free execution in the selected mode")
		}
		document["optimized"] = optimized
		data := pythonSmokeRuntimeJSON(t, document)
		if !validPythonPublicRuntime(data, options.versions, checker, mode) {
			t.Fatal("matching optimization mode rejected")
		}
		other := pythonRuntimeOptimized
		if optimized {
			other = pythonRuntimeNormal
		}
		if validPythonPublicRuntime(data, options.versions, checker, other) {
			t.Fatal("evidence from the wrong optimization mode accepted")
		}
	}
}

func TestPythonPublicRuntimeRejectsMalformedBatches(t *testing.T) {
	t.Parallel()
	checker := canonicalEventSchema(t)
	for _, key := range []string{
		pythonSmokeFixtureBody, pythonFlaskBody, pythonFlaskErrorBody, pythonFlaskBlockedBody,
	} {
		for _, mutation := range []string{"missing-language", "nested-metadata", "privacy-marker"} {
			document, versions := pythonSmokeRuntimeFixture(t)
			batch := eventObject(document[key])
			switch mutation {
			case "missing-language":
				delete(eventObject(batch["sdk"]), "language")
			case "nested-metadata":
				events, valid := batch[pythonRuntimeEvents].([]any)
				if !valid || len(events) == 0 {
					t.Fatal("runtime fixture events missing")
				}
				eventObject(eventObject(events[0])["attributes"])["metadata"] = map[string]any{"invalid": []any{}}
			case "privacy-marker":
				eventObject(batch["sdk"])["name"] = "blocked@example.test /orders/42"
			default:
				t.Fatal("unknown batch mutation")
			}
			if validPythonPublicRuntime(
				pythonSmokeRuntimeJSON(t, document), versions.versions, checker, pythonRuntimeNormal,
			) {
				t.Errorf("accepted %s in %s", mutation, key)
			}
		}
	}
}

func TestPythonPublicRuntimeRejectsContradictions(t *testing.T) {
	t.Parallel()
	checker := canonicalEventSchema(t)
	for _, field := range []string{
		"flush_status", "pending_events", "fastapi_middleware_count",
		"flask_blocked_status", "flask_order_calls",
		"shutdown_status", "shutdown_attempts", "shutdown_accepted_events",
		"shutdown_recorded_bodies", "shutdown_closed", "flask_closed", "flask_pending_events",
	} {
		for _, value := range []any{nil, json.Number("-1"), false} {
			document, versions := pythonSmokeRuntimeFixture(t)
			document[field] = value
			if validPythonPublicRuntime(
				pythonSmokeRuntimeJSON(t, document), versions.versions, checker, pythonRuntimeNormal,
			) {
				t.Errorf("invalid %s accepted", field)
			}
		}
	}
	for _, key := range []string{pythonCoreID, "rq", "arq", "dramatiq", "celery"} {
		document, versions := pythonSmokeRuntimeFixture(t)
		delete(eventObject(document["versions"]), key)
		if validPythonPublicRuntime(
			pythonSmokeRuntimeJSON(t, document), versions.versions, checker, pythonRuntimeNormal,
		) {
			t.Errorf("missing installed version accepted: %s", key)
		}
	}
	document, versions := pythonSmokeRuntimeFixture(t)
	data := pythonSmokeRuntimeJSON(t, document)
	for _, corrupted := range []string{
		strings.Replace(string(data), `"flask_order_calls":[42]`, `"flask_order_calls":[42,42]`, 1),
		strings.Replace(string(data), `"flask_blocked_status":403`, `"flask_blocked_status":200`, 1),
		strings.Replace(string(data), "fan_in", "other", 1),
		strings.ReplaceAll(string(data), "dbapi", "other"),
		strings.Replace(string(data), `"pending_events":0`, `"pending_events":0,"pending_events":0`, 1),
	} {
		if validPythonPublicRuntime([]byte(corrupted), versions.versions, checker, pythonRuntimeNormal) {
			t.Error("contradictory span evidence or duplicate JSON member accepted")
		}
	}
}
