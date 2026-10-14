package main

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

const (
	pythonConsumerMode    = "python-consumer"
	pythonConsumerTimeout = 20 * time.Second
	pythonConsumerLimit   = 1 << 20
	pythonExampleCount    = 7
	pythonFlask           = "flask"
	pythonDjango          = "django"
	pythonFastAPI         = "fastapi"
	pythonRootReadme      = "root-readme"
	pythonRootSmoke       = "root-smoke"
	pythonDefault         = "default"
	pythonSmoke           = "real-user-smoke"
	pythonReadme          = "readme-example"
	pythonOutbound        = "outbound-http"
	pythonDependency      = "dependency-spans"
	pythonRequestSpan     = `"b7ad6b7169203331"`
	pythonChildSpan       = `"c8ad6b7169203332"`
)

type pythonOutputCheck struct {
	mode     string
	expected []string
	stderr   bool
}

type pythonConsumerExample struct {
	name      string
	arguments []string
	checks    []pythonOutputCheck
	forbidden []string
}

type pythonConsumerOutput struct {
	stdout, stderr []byte
	valid          bool
}

func pythonConsumerExamples(framework, root string) []pythonConsumerExample {
	module := "logbrew_" + framework + ".examples"
	plan := make([]pythonConsumerExample, 0, pythonExampleCount)
	for _, name := range []string{
		pythonRootReadme, pythonRootSmoke, pythonReadme, pythonSmoke,
		pythonOutbound, pythonDependency, pythonDefault,
	} {
		arguments := []string{"-m", module, name}
		switch name {
		case pythonRootReadme, pythonRootSmoke:
			entry := "readme_example.py"
			if name == pythonRootSmoke {
				entry = "real_user_smoke.py"
			}
			arguments = []string{filepath.Join(root, "python", "logbrew_"+framework, "examples", entry)}
		case pythonDefault:
			arguments = arguments[:2]
		default:
		}
		checks := pythonExampleChecks(framework, name)
		var forbidden []string
		if framework == pythonFlask && name == pythonOutbound {
			forbidden = []string{"payments.example.test", "debug_marker=drop"}
		}
		plan = append(plan, pythonConsumerExample{
			name: name, arguments: arguments, checks: checks, forbidden: forbidden,
		})
	}
	return plan
}

func pythonExampleChecks(framework, name string) []pythonOutputCheck {
	checks := []pythonOutputCheck{{mode: jsonEventKinds, expected: []string{"span"}, stderr: false}}
	fields := []string{}
	mode := jsonFields
	switch name {
	case pythonRootReadme:
		fields = append(fields, "status=200")
		if framework == pythonFastAPI {
			fields = append(fields, "ok=true")
		}
	case pythonRootSmoke, pythonSmoke, pythonDefault:
		checks[0].expected = append(checks[0].expected, "issue")
		fields = pythonSmokeFields(framework)
		if framework != pythonFastAPI {
			mode = jsonTrailingFields
		}
	case pythonOutbound:
		fields = []string{"outboundParentSpanId=" + pythonRequestSpan, "outboundSpanId=" + pythonChildSpan}
		if framework == pythonFlask {
			fields = append(fields, `outboundTraceparent="00-4bf92f3577b34da6a3ce929d0e0e4736-c8ad6b7169203332-01"`)
			checks = append(checks, pythonOutputCheck{
				mode:     jsonEventFields,
				expected: []string{`attributes.name="POST /payments/authorize"`}, stderr: false,
			})
		} else {
			fields = append(fields, "requestSpanId="+pythonRequestSpan, "traceparentMatchesSpan=true")
		}
	case pythonDependency:
		fields = []string{
			"databaseParentSpanId=" + pythonRequestSpan, "databaseSpanId=" + pythonChildSpan,
			"cacheParentSpanId=" + pythonRequestSpan, `cacheSpanId="d9ad6b7169203333"`,
			"queueParentSpanId=" + pythonRequestSpan, `queueSpanId="e0ad6b7169203334"`,
		}
		if framework == pythonFlask {
			checks = append(checks, pythonOutputCheck{mode: jsonEventFields, expected: []string{
				`attributes.name="sqlite SELECT inventory"`, `attributes.name="memory-cache GET inventory"`,
				`attributes.name="memory-queue PUBLISH checkout.completed"`,
			}, stderr: false})
		} else {
			fields = append(fields, "requestSpanId="+pythonRequestSpan)
		}
	default:
	}
	if len(fields) != 0 {
		checks = append(checks, pythonOutputCheck{mode: mode, expected: fields, stderr: true})
	}
	return checks
}

func pythonSmokeFields(framework string) []string {
	fields := []string{
		`traceId="4bf92f3577b34da6a3ce929d0e0e4736"`,
		`parentSpanId="00f067aa0ba902b7"`, "spanId=" + pythonRequestSpan,
	}
	switch framework {
	case pythonFlask:
		return append(fields, `routeTemplate="/health"`, "events=4")
	case pythonDjango:
		return append(fields, `path="/health/"`, "events=3")
	default:
		return append(fields, `path="/health"`, "events=3")
	}
}

func pythonExamplesList(framework string) string {
	module := "logbrew_" + framework + ".examples"
	names := []string{pythonReadme, pythonOutbound, pythonDependency, pythonSmoke, ""}
	if framework == pythonFlask {
		names = []string{pythonReadme, pythonSmoke, pythonOutbound, pythonDependency, ""}
	}
	for index, name := range names[:4] {
		names[index] = name + " -> python -m " + module + " " + name
	}
	names[4] = "default (real-user-smoke) -> python -m " + module
	return strings.Join(names, "\n") + "\n"
}

func (example *pythonConsumerExample) validOutput(stdout, stderr []byte) bool {
	for _, value := range example.forbidden {
		if bytes.Contains(stdout, []byte(value)) || bytes.Contains(stderr, []byte(value)) {
			return false
		}
	}
	for _, check := range example.checks {
		data := stdout
		if check.stderr {
			data = stderr
		}
		if !checkPackageDocument(data, check.mode, check.expected) {
			return false
		}
	}
	return true
}

func runPythonConsumer(arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) != 3 || !slices.Contains([]string{pythonFlask, pythonDjango, pythonFastAPI}, arguments[0]) ||
		!filepath.IsAbs(arguments[1]) || !filepath.IsAbs(arguments[2]) {
		return writeText(diagnostic, "python consumer requires framework, repository and installed Python\n", exitUsage)
	}
	framework, root, python := arguments[0], arguments[1], arguments[2]
	schema, _ := readCheckFile(filepath.Join(root, "spec", "event-batch.schema.json"))
	checker, err := compileCheckSchema(schema)
	if err != nil {
		return writeText(diagnostic, "python consumer failed: schema unavailable\n", exitFailure)
	}
	directory, err := os.MkdirTemp("", "logbrew-python-consumer-")
	if err != nil {
		return writeText(diagnostic, "python consumer failed: temporary directory unavailable\n", exitFailure)
	}
	ctx, cancel := context.WithTimeout(context.Background(), pythonConsumerTimeout)
	defer cancel()
	failure := checkPythonConsumer(ctx, []string{framework, root, python, directory}, checker)
	if err = os.RemoveAll(directory); err != nil {
		failure = "temporary directory cleanup"
	}
	if failure != "" {
		return writeText(diagnostic, "python consumer failed: "+failure+"\n", exitFailure)
	}
	return writeText(output, `{"scope":"installed_python_consumer","framework":"`+framework+
		`","test_runs":2,"examples":7,"valid":true}`+"\n", exitOK)
}

func checkPythonConsumer(ctx context.Context, settings []string, checker *checkedSchema) string {
	framework, root, python, directory := settings[0], settings[1], settings[2], settings[3]
	call := func(arguments []string) pythonConsumerOutput {
		return runPythonConsumerProcess(ctx, python, directory, append([]string{"-I", "-B"}, arguments...))
	}
	for _, optimized := range []bool{false, true} {
		arguments := []string{
			"-m", "unittest", "discover", "-s",
			filepath.Join(root, "python", "logbrew_"+framework, "tests"), "-p", "test_*.py",
		}
		if optimized {
			arguments = append([]string{"-O"}, arguments...)
		}
		result := call(arguments)
		if !result.valid || !pythonSuitePassed(result.stderr) {
			return "installed tests, optimized=" + strconv.FormatBool(optimized)
		}
	}
	listing := call([]string{"-m", "logbrew_" + framework + ".examples", "--list"})
	if !listing.valid || string(listing.stdout) != pythonExamplesList(framework) {
		return "installed example listing"
	}
	for _, example := range pythonConsumerExamples(framework, root) {
		result := call(example.arguments)
		if !result.valid || !example.validOutput(result.stdout, result.stderr) {
			return example.name
		}
		if valid, err := checker.validateEventBatch(result.stdout); err != nil || !valid {
			return example.name + " event contract"
		}
	}
	return ""
}

func pythonSuitePassed(output []byte) bool {
	return regexp.MustCompile(`(?m)^Ran [1-9]\d* tests? in [0-9.]+s$`).Match(output) &&
		strings.HasSuffix(strings.TrimSpace(string(output)), "\nOK")
}

func runPythonConsumerProcess(
	ctx context.Context, python, directory string, arguments []string,
) pythonConsumerOutput {
	return runPythonConsumerEnvironment(ctx, python, directory, arguments, nil)
}

func runPythonConsumerEnvironment(
	ctx context.Context, python, directory string, arguments, environment []string,
) pythonConsumerOutput {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	self, selfError := os.Executable()
	resolved, pathError := exec.LookPath(python)
	if selfError != nil || pathError != nil {
		return pythonConsumerOutput{}
	}
	limited := append([]string{limitedExecutionMode, strconv.Itoa(maximumOutputFile), resolved}, arguments...)
	// Reviewed 2026-09-05: the caller selects an installed runtime, never shell text.
	//nolint:gosec // G204: deadline, child cleanup, output and file bounds have executable tests.
	command := exec.CommandContext(ctx, self, limited...)
	command.Dir = directory
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "TMPDIR=" + directory, "GORACE=" + os.Getenv("GORACE")}
	command.Env = append(command.Env, environment...)
	stdout, stderr := new(boundedOutput), new(boundedOutput)
	stdout.cancel, stderr.cancel = cancel, cancel
	stdout.limit, stderr.limit = pythonConsumerLimit, pythonConsumerLimit
	command.Stdout, command.Stderr = stdout, stderr
	err := runManagedProcess(command)
	return pythonConsumerOutput{
		stdout: stdout.data, stderr: stderr.data,
		valid: err == nil && ctx.Err() == nil && !stdout.limited && !stderr.limited,
	}
}
