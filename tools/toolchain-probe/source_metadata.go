package main

import (
	"os"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

const (
	cMetadataFamily              = "c"
	cppMetadataFamily            = "cpp"
	rootMetadataFamily           = "root"
	metadataMakefile             = "Makefile"
	metadataExampleMakefile      = "examples/Makefile"
	metadataConfigurationExample = "LOGBREW_API_KEY"
	metadataCardinalityGuidance  = "low-cardinality"
	metadataMetricsHeading       = "Metrics"
)

func sourceMetadataPolicies() map[string]sourceMetadataPolicy {
	return map[string]sourceMetadataPolicy{
		"go": goMetadataPolicy(), rubyMetadataFamily: rubyMetadataPolicy(),
		cMetadataFamily: cMetadataPolicy(), cppMetadataFamily: cppMetadataPolicy(),
		objcMetadataFamily: objcMetadataPolicy(), areaSwift: swiftMetadataPolicy(),
		rootMetadataFamily: {
			prefix: "", files: []string{policyRootGuide}, text: map[string][]string{"LICENSE": {"MIT License"}},
			patterns: nil,
		},
	}
}

type sourceMetadataPolicy struct {
	text     map[string][]string
	patterns map[string][]string
	prefix   string
	files    []string
}

func (policy sourceMetadataPolicy) check(root *os.Root) bool {
	for _, name := range policy.files {
		if !releaseMetadataFileExists(root, policy.prefix+name) {
			return false
		}
	}
	for name, required := range policy.text {
		data, readable := readReleaseMetadata(root, policy.prefix+name)
		if !readable || !validMetadataText(data, required) {
			return false
		}
	}
	for name, required := range policy.patterns {
		data, readable := readReleaseMetadata(root, policy.prefix+name)
		if !readable || !validMetadataPatterns(data, required) {
			return false
		}
	}
	return true
}

func validMetadataPatterns(data []byte, patterns []string) bool {
	if !validMetadataText(data, nil) {
		return false
	}
	for _, pattern := range patterns {
		compiled, err := regexp.Compile(pattern)
		if err != nil || !compiled.Match(data) {
			return false
		}
	}
	return true
}

func validMetadataText(data []byte, required []string) bool {
	if len(data) > pythonManifestLimit || !utf8.Valid(data) {
		return false
	}
	text := string(data)
	for _, phrase := range required {
		if !strings.Contains(text, phrase) {
			return false
		}
	}
	return true
}

func cMetadataPolicy() sourceMetadataPolicy {
	common := []string{
		"logbrew_client_flush", "LogBrewMetricAttributes", "logbrew_client_metric",
		"logbrew_client_product_action", "logbrew_client_network_milestone", "logbrew_http_transport_init",
		"logbrew_client_issue_with_details", "logbrew_client_span_with_evidence",
	}
	return sourceMetadataPolicy{
		prefix:   "c/logbrew-c/",
		patterns: nil,
		files: []string{
			"src/logbrew.c", "src/logbrew_json.c", "src/logbrew_context.c", "src/logbrew_evidence.c",
			"src/logbrew_metric.c", metadataMakefile, metadataExampleMakefile, "examples/readme_example.c",
			"examples/real_user_smoke.c", "tests/test_logbrew.c", "tests/test_rich_telemetry.c",
		},
		text: map[string][]string{
			"include/logbrew.h": slices.Concat(common, []string{
				`#define LOGBREW_C_VERSION "0.2.2"`, "typedef struct LogBrewClient LogBrewClient;",
				"LogBrewRecordingTransport", "LogBrewProductTimelineContext",
				"LogBrewHttpTransport", "LogBrewTelemetryContext",
			}),
			policyRootGuide: slices.Concat(common, []string{
				"Public C99 SDK", metadataConfigurationExample, "Rich investigation context",
				"copy into your own native application",
			}),
		},
	}
}

func cppMetadataPolicy() sourceMetadataPolicy {
	trace := []string{
		"OpenTelemetrySpanContext", "open_telemetry_span_context", "trace_context_from_opentelemetry_span_context",
	}
	common := slices.Concat(trace, []string{
		"MetricAttributes", "capture_product_action", "capture_network_milestone", "TelemetryContext",
		"IssueDetails", "SpanEvidence", "TraceScope", "trace_context_from_traceparent",
		"try_open_telemetry_span_context_from_span_pointer", "trace_span_attributes_from_opentelemetry_span_context",
		"traceparent_headers",
	})
	return sourceMetadataPolicy{
		prefix:   "cpp/logbrew-cpp/",
		patterns: nil,
		files: []string{
			"src/logbrew.cpp", "src/logbrew_http_transport.cpp", "CMakeLists.txt", "cmake/LogBrewConfig.cmake.in",
			metadataMakefile, metadataExampleMakefile, "examples/readme_example.cpp", "examples/real_user_smoke.cpp",
			"examples/http_transport.cpp", "tests/test_logbrew.cpp", "tests/test_rich_context.cpp",
		},
		text: map[string][]string{
			"include/logbrew.hpp": slices.Concat(common, []string{
				`inline constexpr const char *version = "0.2.3"`, "class LogBrewClient", "MetadataValue",
				"ProductTimelineContext", "TraceContext", "TelemetryScope", "EventOptions", "IssueStackFrame",
				"IssueBreadcrumb", "SpanEvent", "SpanLink", "issue_frame_from_location", "metric(",
				"class HttpTransport", "class RecordingTransport", "http_transport_default_endpoint",
				"class SdkException",
			}),
			policyRootGuide: slices.Concat(common, []string{
				"Public C++17 SDK", metadataConfigurationExample, "FetchContent",
				"LogBrew::LogBrew", "LogBrew::HttpTransport", metadataMetricsHeading, "client.metric",
				metadataCardinalityGuidance, "Product Timelines", "Sending To LogBrew",
				"W3C Trace Correlation", "Rich Investigation Context", "Issue Evidence", "Span Evidence",
				"HttpTransport", "do not patch HTTP clients", "client.flush", "copy into your own native application",
			}),
			"examples/trace_correlation.cpp": trace,
		},
	}
}
