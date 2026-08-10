package logbrewgin

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/LogBrewCo/sdk/go/logbrew"
	"github.com/gin-gonic/gin"
)

func TestMiddlewareCapturesRouteTraceAndOptInMetricWithoutSensitiveRequestData(t *testing.T) {
	gin.SetMode(gin.TestMode)
	client := testClient(t)
	baseTime := time.Date(2026, 8, 1, 10, 0, 0, 0, time.UTC)
	nowCalls := 0
	middleware, err := NewMiddleware(Config{
		Client:                client,
		CaptureRequestMetrics: true,
		EventIDPrefix:         "go_gin_test",
		Metadata: map[string]any{
			"service":       "checkout-api",
			"authorization": "Bearer fixture-value",
			"requestBody":   "private configuration body",
			"nested":        map[string]any{"drop": true},
		},
		SpanIDFactory: func() string { return "b7ad6b7169203331" },
		Now: func() time.Time {
			nowCalls++
			if nowCalls == 1 {
				return baseTime
			}
			return baseTime.Add(25 * time.Millisecond)
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	router := gin.New()
	router.Use(middleware)
	router.POST("/articles/:slug", func(c *gin.Context) {
		trace, ok := TraceFromContext(c)
		if !ok {
			t.Fatal("expected Gin request trace")
		}
		if trace.TraceID != "4bf92f3577b34da6a3ce929d0e0e4736" ||
			trace.ParentSpanID != "00f067aa0ba902b7" ||
			trace.SpanID != "b7ad6b7169203331" || !trace.Sampled {
			t.Fatalf("unexpected request trace: %#v", trace)
		}
		contextTrace, contextOK := logbrew.LogBrewTraceFromContext(c.Request.Context())
		if !contextOK || contextTrace != trace {
			t.Fatalf("request context missing Gin trace: %#v", contextTrace)
		}
		if err := client.Log(
			"evt_handler_log",
			baseTime.Format(time.RFC3339Nano),
			logbrew.LogAttributesWithTrace(c.Request.Context(), logbrew.LogAttributes{
				Message: "handler reached",
				Level:   "info",
				Logger:  "gin-test",
			}),
		); err != nil {
			t.Fatal(err)
		}
		c.Status(http.StatusNoContent)
	})

	request := httptest.NewRequest(
		http.MethodPost,
		"https://private.example.test/articles/private-article?token=private-query-value",
		strings.NewReader("private request body"),
	)
	request.Header.Add("traceparent", "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01")
	request.Header.Set("Authorization", "Bearer request-fixture")
	request.Header.Set("Cookie", "session=private-cookie")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("unexpected status: %d", response.Code)
	}

	events, payload := previewEvents(t, client)
	if got, want := len(events), 3; got != want {
		t.Fatalf("unexpected event count: got %d want %d\n%s", got, want, payload)
	}
	if events[0].Type != "log" || events[1].Type != "span" || events[2].Type != "metric" {
		t.Fatalf("unexpected event order: %#v", events)
	}
	span := events[1].Attributes
	if span["name"] != "POST /articles/:slug" || span["status"] != "ok" || span["durationMs"] != float64(25) {
		t.Fatalf("unexpected Gin request span: %#v", span)
	}
	metadata := requireMetadata(t, span)
	assertMetadata(t, metadata, map[string]any{
		"framework":       "gin",
		"method":          "POST",
		"routeTemplate":   "/articles/:slug",
		"service":         "checkout-api",
		"source":          "gin.request",
		"statusCode":      float64(http.StatusNoContent),
		"statusCodeClass": "2xx",
	})
	metric := events[2].Attributes
	if metric["name"] != "http.server.duration" || metric["kind"] != "histogram" ||
		metric["description"] != "Duration of one completed server request." ||
		metric["value"] != float64(25) || metric["unit"] != "ms" || metric["temporality"] != "delta" {
		t.Fatalf("unexpected Gin request metric: %#v", metric)
	}
	metricMetadata := requireMetadata(t, metric)
	if metricMetadata["traceId"] != "4bf92f3577b34da6a3ce929d0e0e4736" ||
		metricMetadata["spanId"] != "b7ad6b7169203331" {
		t.Fatalf("metric missing request trace: %#v", metricMetadata)
	}
	for _, unsafe := range []string{
		"private.example.test",
		"private-article",
		"private-query-value",
		"private request body",
		"request-fixture",
		"private-cookie",
		"fixture-value",
		"private configuration body",
		"traceparent",
		"authorization",
		"requestBody",
		"nested",
	} {
		if strings.Contains(payload, unsafe) {
			t.Fatalf("Gin telemetry leaked %q: %s", unsafe, payload)
		}
	}
}

func TestMiddlewareUsesStableUnmatchedRouteAndFallsBackFromUnsafeTraceparents(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, testCase := range []struct {
		name    string
		headers []string
	}{
		{name: "malformed", headers: []string{"private-malformed-traceparent"}},
		{name: "duplicate", headers: []string{
			"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
			"private-duplicate-traceparent",
		}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			client := testClient(t)
			var reported []error
			middleware, err := NewMiddleware(Config{
				Client:        client,
				OnError:       func(err error) { reported = append(reported, err) },
				SpanIDFactory: func() string { return "b7ad6b7169203331" },
			})
			if err != nil {
				t.Fatal(err)
			}
			router := gin.New()
			router.Use(middleware)
			request := httptest.NewRequest(http.MethodGet, "/profiles/private-user?token=private", nil)
			for _, value := range testCase.headers {
				request.Header.Add("traceparent", value)
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != http.StatusNotFound {
				t.Fatalf("unexpected status: %d", response.Code)
			}
			if len(reported) != 1 || strings.Contains(reported[0].Error(), "private") {
				t.Fatalf("expected one redacted propagation diagnostic, got %#v", reported)
			}
			events, payload := previewEvents(t, client)
			if len(events) != 1 || events[0].Type != "span" {
				t.Fatalf("unexpected events: %#v\n%s", events, payload)
			}
			span := events[0].Attributes
			if span["name"] != "GET <unmatched>" || span["parentSpanId"] != nil {
				t.Fatalf("unexpected unmatched-route span: %#v", span)
			}
			metadata := requireMetadata(t, span)
			if metadata["routeTemplate"] != "<unmatched>" || metadata["statusCode"] != float64(http.StatusNotFound) {
				t.Fatalf("unexpected unmatched-route metadata: %#v", metadata)
			}
			for _, unsafe := range append([]string{"private-user", "token=private", "traceparent"}, testCase.headers...) {
				if strings.Contains(payload, unsafe) {
					t.Fatalf("fallback telemetry leaked %q: %s", unsafe, payload)
				}
			}
		})
	}
}

func TestMiddlewareContinuesAnActiveLogBrewTraceWhenNoHeaderIsPresent(t *testing.T) {
	gin.SetMode(gin.TestMode)
	client := testClient(t)
	parent, err := logbrew.NewTraceContext(logbrew.TraceContextInput{
		Traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
		SpanID:      "1111111111111111",
	})
	if err != nil {
		t.Fatal(err)
	}
	middleware, err := NewMiddleware(Config{
		Client:        client,
		SpanIDFactory: func() string { return "b7ad6b7169203331" },
	})
	if err != nil {
		t.Fatal(err)
	}
	router := gin.New()
	router.Use(middleware)
	router.GET("/nested", func(c *gin.Context) {
		trace, ok := TraceFromContext(c)
		if !ok || trace.TraceID != parent.TraceID || trace.ParentSpanID != parent.SpanID ||
			trace.SpanID != "b7ad6b7169203331" || !trace.Sampled {
			t.Fatalf("Gin request did not continue active trace: %#v", trace)
		}
		c.Status(http.StatusNoContent)
	})
	request := httptest.NewRequest(http.MethodGet, "/nested", nil)
	request = request.WithContext(logbrew.ContextWithLogBrewTrace(request.Context(), parent))
	router.ServeHTTP(httptest.NewRecorder(), request)
	events, payload := previewEvents(t, client)
	if len(events) != 1 || events[0].Attributes["traceId"] != parent.TraceID ||
		events[0].Attributes["parentSpanId"] != parent.SpanID {
		t.Fatalf("unexpected nested Gin span: %#v\n%s", events, payload)
	}
}

func TestMiddlewareCapturesGenericPanicIssueAndPreservesGinRecovery(t *testing.T) {
	gin.SetMode(gin.TestMode)
	client := testClient(t)
	middleware, err := NewMiddleware(Config{
		Client:        client,
		EventIDPrefix: "go_gin_panic",
		SpanIDFactory: func() string { return "b7ad6b7169203331" },
	})
	if err != nil {
		t.Fatal(err)
	}
	router := gin.New()
	router.Use(gin.RecoveryWithWriter(io.Discard), middleware)
	router.GET("/panic/:id", func(_ *gin.Context) {
		panic("private panic value")
	})
	request := httptest.NewRequest(http.MethodGet, "/panic/private-id?token=private", nil)
	request.Header.Set("Authorization", "Bearer private")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("Gin recovery status changed: %d", response.Code)
	}

	events, payload := previewEvents(t, client)
	if len(events) != 2 || events[0].Type != "span" || events[1].Type != "issue" {
		t.Fatalf("unexpected panic events: %#v\n%s", events, payload)
	}
	span := events[0].Attributes
	if span["status"] != "error" || span["name"] != "GET /panic/:id" {
		t.Fatalf("unexpected panic span: %#v", span)
	}
	spanMetadata := requireMetadata(t, span)
	if spanMetadata["panic"] != true || spanMetadata["panicType"] != "string" ||
		spanMetadata["statusCode"] != float64(http.StatusInternalServerError) {
		t.Fatalf("panic span missing type-only diagnostics: %#v", spanMetadata)
	}
	issue := events[1].Attributes
	if issue["title"] != "Gin request panicked" || issue["level"] != "error" || issue["message"] != nil {
		t.Fatalf("unexpected generic panic issue: %#v", issue)
	}
	exception, ok := issue["exception"].(map[string]any)
	if !ok || exception["type"] != "string" {
		t.Fatalf("panic issue missing type-only exception identity: %#v", issue)
	}
	mechanism, ok := exception["mechanism"].(map[string]any)
	if !ok || mechanism["type"] != "gin.recovery" || mechanism["handled"] != false {
		t.Fatalf("panic issue missing escape mechanism: %#v", exception)
	}
	chain, ok := issue["exceptionChain"].(map[string]any)
	if !ok {
		t.Fatalf("panic issue missing exception chain: %#v", issue)
	}
	chainEntries, ok := chain["entries"].([]any)
	if !ok || len(chainEntries) != 1 {
		t.Fatalf("panic issue has invalid exception chain: %#v", chain)
	}
	reported := chainEntries[0].(map[string]any)
	if reported["type"] != "string" || reported["relationship"] != "reported" ||
		reported["messageState"] != "redacted" || reported["stackFramesState"] != "captured" {
		t.Fatalf("panic chain lost reported evidence: %#v", reported)
	}
	frames, ok := issue["stackFrames"].([]any)
	if !ok || len(frames) == 0 || len(frames) > 32 {
		t.Fatalf("panic issue missing bounded structured frames: %#v", issue)
	}
	foundHandlerFrame := false
	for _, value := range frames {
		frame, frameOK := value.(map[string]any)
		if !frameOK {
			t.Fatalf("panic issue has invalid frame: %#v", value)
		}
		filename, _ := frame["filename"].(string)
		if filename == "middleware_test.go" {
			foundHandlerFrame = true
		}
		if strings.ContainsAny(filename, `/\\?#`) {
			t.Fatalf("panic frame leaked a path: %#v", frame)
		}
	}
	if !foundHandlerFrame {
		t.Fatalf("panic frames omitted the application handler: %#v", frames)
	}
	issueMetadata := requireMetadata(t, issue)
	if issueMetadata["traceId"] != span["traceId"] || issueMetadata["spanId"] != span["spanId"] {
		t.Fatalf("panic issue missing trace correlation: %#v", issueMetadata)
	}
	for _, unsafe := range []string{"private panic value", "private-id", "token=private", "Bearer private", "Authorization"} {
		if strings.Contains(payload, unsafe) {
			t.Fatalf("panic telemetry leaked %q: %s", unsafe, payload)
		}
	}
}

func TestMiddlewarePreservesCommittedStatusWhenAHandlerLaterPanics(t *testing.T) {
	gin.SetMode(gin.TestMode)
	client := testClient(t)
	middleware, err := NewMiddleware(Config{
		Client:        client,
		SpanIDFactory: func() string { return "b7ad6b7169203331" },
	})
	if err != nil {
		t.Fatal(err)
	}
	router := gin.New()
	router.Use(gin.RecoveryWithWriter(io.Discard), middleware)
	router.GET("/accepted", func(c *gin.Context) {
		c.Status(http.StatusAccepted)
		c.Writer.WriteHeaderNow()
		panic("private panic after response")
	})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/accepted", nil))
	if response.Code != http.StatusAccepted {
		t.Fatalf("middleware changed committed response: %d", response.Code)
	}
	events, payload := previewEvents(t, client)
	if len(events) != 2 || events[0].Attributes["status"] != "error" {
		t.Fatalf("unexpected committed-response panic events: %#v\n%s", events, payload)
	}
	metadata := requireMetadata(t, events[0].Attributes)
	if metadata["statusCode"] != float64(http.StatusAccepted) || metadata["panic"] != true {
		t.Fatalf("committed response status was not preserved: %#v", metadata)
	}
	if strings.Contains(payload, "private panic after response") {
		t.Fatalf("committed-response panic value leaked: %s", payload)
	}
}

func TestMiddlewareServerErrorIssuesAreOptIn(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, testCase := range []struct {
		name          string
		captureIssues bool
		wantEvents    int
	}{
		{name: "default span only", captureIssues: false, wantEvents: 1},
		{name: "opt in issue", captureIssues: true, wantEvents: 2},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			client := testClient(t)
			middleware, err := NewMiddleware(Config{
				Client:                   client,
				CaptureServerErrorIssues: testCase.captureIssues,
				SpanIDFactory:            func() string { return "b7ad6b7169203331" },
			})
			if err != nil {
				t.Fatal(err)
			}
			router := gin.New()
			router.Use(middleware)
			router.GET("/upstream", func(c *gin.Context) { c.Status(http.StatusBadGateway) })
			router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/upstream", nil))
			events, payload := previewEvents(t, client)
			if len(events) != testCase.wantEvents {
				t.Fatalf("unexpected event count: got %d want %d\n%s", len(events), testCase.wantEvents, payload)
			}
			if events[0].Attributes["status"] != "error" {
				t.Fatalf("5xx request span should be error: %#v", events[0])
			}
			if testCase.captureIssues {
				if events[1].Type != "issue" || events[1].Attributes["title"] != "Gin request returned a server error" {
					t.Fatalf("unexpected server error issue: %#v", events[1])
				}
				if events[1].Attributes["exception"] != nil || events[1].Attributes["stackFrames"] != nil {
					t.Fatalf("ordinary 5xx issue should not invent panic diagnostics: %#v", events[1])
				}
			}
		})
	}
}

func TestMiddlewareFilterAndCaptureFailuresDoNotChangeResponses(t *testing.T) {
	gin.SetMode(gin.TestMode)
	client := testClient(t)
	if _, err := client.Shutdown(logbrew.AlwaysAcceptTransport()); err != nil {
		t.Fatal(err)
	}
	var reported []error
	middleware, err := NewMiddleware(Config{
		Client: client,
		Filter: func(c *gin.Context) bool {
			return c.FullPath() != "/health"
		},
		OnError: func(err error) {
			reported = append(reported, err)
			panic("reporter must not affect app")
		},
		SpanIDFactory: func() string { return "b7ad6b7169203331" },
	})
	if err != nil {
		t.Fatal(err)
	}
	router := gin.New()
	router.Use(middleware)
	router.GET("/health", func(c *gin.Context) {
		if _, ok := TraceFromContext(c); ok {
			t.Fatal("filtered request should not have a LogBrew trace")
		}
		c.Status(http.StatusNoContent)
	})
	router.GET("/ready", func(c *gin.Context) { c.Status(http.StatusAccepted) })

	health := httptest.NewRecorder()
	router.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/health", nil))
	if health.Code != http.StatusNoContent || len(reported) != 0 {
		t.Fatalf("filtered response changed: status=%d reported=%d", health.Code, len(reported))
	}
	ready := httptest.NewRecorder()
	router.ServeHTTP(ready, httptest.NewRequest(http.MethodGet, "/ready", nil))
	if ready.Code != http.StatusAccepted || len(reported) != 1 {
		t.Fatalf("capture failure changed response: status=%d reported=%d", ready.Code, len(reported))
	}
}

func TestMiddlewareInitializationFailureDoesNotChangeResponse(t *testing.T) {
	gin.SetMode(gin.TestMode)
	client := testClient(t)
	var reported []error
	middleware, err := NewMiddleware(Config{
		Client: client,
		Now: func() time.Time {
			panic("private clock failure")
		},
		OnError: func(err error) { reported = append(reported, err) },
	})
	if err != nil {
		t.Fatal(err)
	}
	router := gin.New()
	router.Use(middleware)
	router.GET("/ready", func(c *gin.Context) { c.Status(http.StatusAccepted) })
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/ready", nil))
	if response.Code != http.StatusAccepted {
		t.Fatalf("initialization failure changed response: %d", response.Code)
	}
	if len(reported) != 1 || strings.Contains(reported[0].Error(), "private") {
		t.Fatalf("expected one redacted initialization diagnostic, got %#v", reported)
	}
	events, _ := previewEvents(t, client)
	if len(events) != 0 {
		t.Fatalf("initialization failure should skip automatic events: %#v", events)
	}
}

func TestMiddlewareIsSafeForConcurrentRequests(t *testing.T) {
	gin.SetMode(gin.TestMode)
	client := testClient(t)
	middleware, err := NewMiddleware(Config{Client: client})
	if err != nil {
		t.Fatal(err)
	}
	router := gin.New()
	router.Use(middleware)
	router.GET("/work/:id", func(c *gin.Context) { c.Status(http.StatusNoContent) })

	const requestCount = 100
	var wait sync.WaitGroup
	errors := make(chan string, requestCount)
	for index := 0; index < requestCount; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/work/private-id", nil))
			if response.Code != http.StatusNoContent {
				errors <- response.Result().Status
			}
		}()
	}
	wait.Wait()
	close(errors)
	for responseError := range errors {
		t.Fatalf("concurrent response changed: %s", responseError)
	}
	events, payload := previewEvents(t, client)
	if len(events) != requestCount {
		t.Fatalf("unexpected concurrent event count: got %d want %d\n%s", len(events), requestCount, payload)
	}
	ids := make(map[string]struct{}, requestCount)
	for _, event := range events {
		if event.Type != "span" {
			t.Fatalf("unexpected concurrent event: %#v", event)
		}
		ids[event.ID] = struct{}{}
	}
	if len(ids) != requestCount {
		t.Fatalf("concurrent event IDs were not unique: %d", len(ids))
	}
	if strings.Contains(payload, "private-id") {
		t.Fatalf("concurrent request path leaked: %s", payload)
	}
}

func TestNewMiddlewareRejectsMissingClient(t *testing.T) {
	if middleware, err := NewMiddleware(Config{}); err == nil || middleware != nil {
		t.Fatalf("expected missing-client configuration error, got middleware=%v err=%v", middleware, err)
	}
}

func testClient(t *testing.T) *logbrew.Client {
	t.Helper()
	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:     "LOGBREW_API_KEY",
		SDKName:    "gin-test",
		SDKVersion: "0.1.0",
	})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func previewEvents(t *testing.T, client *logbrew.Client) ([]logbrew.Event, string) {
	t.Helper()
	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	var batch struct {
		Events []logbrew.Event `json:"events"`
	}
	if err := json.Unmarshal([]byte(payload), &batch); err != nil {
		t.Fatal(err)
	}
	return batch.Events, payload
}

func requireMetadata(t *testing.T, attributes map[string]any) map[string]any {
	t.Helper()
	metadata, ok := attributes["metadata"].(map[string]any)
	if !ok {
		t.Fatalf("missing event metadata: %#v", attributes)
	}
	return metadata
}

func assertMetadata(t *testing.T, actual, expected map[string]any) {
	t.Helper()
	for key, value := range expected {
		if actual[key] != value {
			t.Fatalf("unexpected metadata %s: got %#v want %#v (%#v)", key, actual[key], value, actual)
		}
	}
}
