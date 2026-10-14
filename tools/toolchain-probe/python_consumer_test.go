package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestPythonConsumerPlanPreservesPackageChecks(t *testing.T) {
	t.Parallel()
	for framework := range strings.FieldsSeq("flask django fastapi") {
		t.Run(framework, func(t *testing.T) {
			t.Parallel()
			plan := pythonConsumerExamples(framework, "/fixture")
			if len(plan) != pythonExampleCount {
				t.Fatal("need both repository entry points, four installed examples, and the default")
			}
			assertPythonPlanEvidence(t, plan)
			module := "logbrew_" + framework + ".examples"
			if !reflect.DeepEqual(plan[2].arguments, []string{"-m", module, "readme-example"}) ||
				!reflect.DeepEqual(plan[6].arguments, []string{"-m", module}) {
				t.Fatal("installed entry points must not use the source tree")
			}
			if framework == pythonFlask && (len(plan[4].forbidden) != 2 || len(plan[5].checks) != 3) {
				t.Fatal("lost outbound redaction or dependency operation checks")
			}
		})
	}
}

func assertPythonPlanEvidence(t *testing.T, plan []pythonConsumerExample) {
	t.Helper()
	for _, example := range plan {
		if len(example.checks) == 0 || example.checks[0].mode != jsonEventKinds {
			t.Fatal("every example must preserve emitted kinds")
		}
		if strings.Contains(example.name, "smoke") || example.name == pythonDefault {
			check := example.checks[len(example.checks)-1]
			if !check.stderr || len(check.expected) != 5 {
				t.Fatal("smoke must bind trace, parent, span, route and event count")
			}
		}
	}
}

func pythonFrozenConsumerFields(framework string) []string {
	fields := []string{
		"status=200", `traceId="4bf92f3577b34da6a3ce929d0e0e4736"`,
		`parentSpanId="00f067aa0ba902b7"`, `spanId="b7ad6b7169203331"`,
		`outboundParentSpanId="b7ad6b7169203331"`, `outboundSpanId="c8ad6b7169203332"`,
		`databaseParentSpanId="b7ad6b7169203331"`, `databaseSpanId="c8ad6b7169203332"`,
		`cacheParentSpanId="b7ad6b7169203331"`, `cacheSpanId="d9ad6b7169203333"`,
		`queueParentSpanId="b7ad6b7169203331"`, `queueSpanId="e0ad6b7169203334"`,
	}
	if framework == pythonFlask {
		return append(fields, `routeTemplate="/health"`, "events=4",
			`outboundTraceparent="00-4bf92f3577b34da6a3ce929d0e0e4736-c8ad6b7169203332-01"`,
			`attributes.name="POST /payments/authorize"`, `attributes.name="sqlite SELECT inventory"`,
			`attributes.name="memory-cache GET inventory"`, `attributes.name="memory-queue PUBLISH checkout.completed"`)
	}
	fields = append(fields, "events=3", `requestSpanId="b7ad6b7169203331"`, "traceparentMatchesSpan=true")
	if framework == pythonDjango {
		return append(fields, `path="/health/"`)
	}
	return append(fields, `path="/health"`, "ok=true")
}

func TestPythonConsumerFrozenEvidence(t *testing.T) {
	t.Parallel()
	for framework := range strings.FieldsSeq("flask django fastapi") {
		plan := pythonPlanExpectations(framework)
		for _, field := range pythonFrozenConsumerFields(framework) {
			if !plan[field] {
				t.Errorf("%s lost frozen consumer evidence %s", framework, field)
			}
		}
	}
}

func pythonPlanExpectations(framework string) map[string]bool {
	expected := make(map[string]bool)
	for _, example := range pythonConsumerExamples(framework, "/fixture") {
		for _, check := range example.checks {
			for _, value := range check.expected {
				expected[value] = true
			}
		}
	}
	return expected
}

func TestPythonConsumerOutputRejectsMissingEvidence(t *testing.T) {
	t.Parallel()
	check := pythonOutputCheck{stderr: true, mode: jsonTrailingFields, expected: []string{`events=4`}}
	example := pythonConsumerExample{
		name: "smoke", arguments: nil, checks: []pythonOutputCheck{check}, forbidden: []string{"secret-marker"},
	}
	const emptyDocument = `{}`
	for _, sample := range []struct {
		stdout, stderr string
		valid          bool
	}{
		{`{"events":[]}`, "expected error\n{\"events\":4}\n", true},
		{emptyDocument, `{"events":3}`, false},
		{emptyDocument, `{"events":4,"events":4}`, false},
		{emptyDocument, `{"events":4} trailing`, false},
		{`secret-marker`, `{"events":4}`, false},
		{emptyDocument, "secret-marker\n{\"events\":4}", false},
	} {
		if got := example.validOutput([]byte(sample.stdout), []byte(sample.stderr)); got != sample.valid {
			t.Errorf("output accepted=%v, want %v", got, sample.valid)
		}
	}
}

func TestPythonConsumerListIsExact(t *testing.T) {
	t.Parallel()
	for framework := range strings.FieldsSeq("flask django fastapi") {
		listing := pythonExamplesList(framework)
		lines := strings.Split(strings.TrimSpace(listing), "\n")
		second := "outbound-http"
		if framework == pythonFlask {
			second = "real-user-smoke"
		}
		if len(lines) != 5 || !strings.HasPrefix(lines[1], second+" -> ") ||
			!strings.HasPrefix(lines[4], "default (real-user-smoke) -> ") {
			t.Fatal("example listing changed order or default")
		}
	}
}

func TestPythonConsumerProcessBounds(t *testing.T) {
	t.Parallel()
	for index, mode := range []string{"fixture:empty", "fixture:failure", "fixture:flood", "fixture:sleep"} {
		ctx, cancel := context.WithTimeout(t.Context(), testProbeTimeout)
		result := runPythonConsumerProcess(ctx, os.Args[0], t.TempDir(), []string{mode})
		cancel()
		if result.valid != (index == 0) ||
			len(result.stdout) > maximumOutputFile || len(result.stderr) > maximumOutputFile {
			t.Errorf("mode %s: valid=%v", mode, result.valid)
		}
	}
}

func TestPythonConsumerRejectsInvalidInputs(t *testing.T) {
	t.Parallel()
	for _, args := range [][]string{
		nil,
		{pythonFlask},
		{"../flask", "/fixture", "/python"},
		{pythonFlask, t.TempDir(), os.Args[0]},
		{"flask django", "/fixture", os.Args[0]},
		{pythonFlask, "relative", os.Args[0]},
	} {
		var output, diagnostic bytes.Buffer
		if runPythonConsumer(args, &output, &diagnostic) == exitOK || output.Len() != 0 {
			t.Fatal("invalid consumer invocation produced success")
		}
	}
}

func TestPythonConsumerReapsDescendants(t *testing.T) {
	t.Parallel()
	for _, mode := range []string{"fixture:child", "fixture:background"} {
		folder := t.TempDir()
		pidFile := filepath.Join(folder, "child.pid")
		ctx, cancel := context.WithTimeout(t.Context(), testProbeTimeout)
		_ = runPythonConsumerProcess(ctx, os.Args[0], folder, []string{mode, pidFile})
		cancel()
		assertChildStopped(t, pidFile)
	}
}

func TestPythonConsumerSuiteNeedsExecutedTests(t *testing.T) {
	t.Parallel()
	for _, sample := range []struct {
		output string
		valid  bool
	}{
		{"Ran 19 tests in 0.081s\n\nOK\n", true},
		{"Ran 1 test in 0.001s\n\nOK\n", true},
		{"Ran 0 tests in 0.000s\n\nOK\n", false},
		{"Ran 19 tests in 0.081s\n\nFAILED\n", false},
		{"Ran 19 tests in 0.081s\n\nOK (skipped=1)\n", false},
		{"OK\n", false},
	} {
		if pythonSuitePassed([]byte(sample.output)) != sample.valid {
			t.Errorf("wrong suite receipt for %q", sample.output)
		}
	}
}
