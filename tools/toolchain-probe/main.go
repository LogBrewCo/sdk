// Toolchain-probe emits a bounded version inventory for the SDK verifier.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	outputLimit           = 4096
	lineLimit             = 1024
	commandTimeout        = 2 * time.Second
	inventoryTimeout      = 3 * time.Second
	maximumDeadline       = 60 * time.Second
	maximumOutputFile     = 32 << 20
	pipeWait              = 100 * time.Millisecond
	probeWorkers          = 4
	deadlineArgumentCount = 3
	summaryArgumentCount  = 11
	versionFlag           = "--version"
	exitOK                = 0
	exitFailure           = 1
	exitUsage             = 2
	timedOut              = "timed out"
	commandSeparator      = "\x00"
)

type checkSummary struct {
	SchemaVersion       string            `json:"schema_version"`
	Message             string            `json:"message"`
	StartedAt           string            `json:"started_at"`
	FinishedAt          string            `json:"finished_at"`
	FailureReason       string            `json:"failure_reason,omitempty"`
	FailedStepLabel     string            `json:"failed_step_label,omitempty"`
	ToolchainVersions   map[string]string `json:"toolchain_versions"`
	ExitCode            *int              `json:"exit_code,omitempty"`
	FailedStepNumber    *int              `json:"failed_step_number,omitempty"`
	StepLabels          []string          `json:"step_labels"`
	CompletedStepLabels []string          `json:"completed_step_labels"`
	StepsCompleted      int               `json:"steps_completed"`
	StepsTotal          int               `json:"steps_total"`
	DurationMS          int               `json:"duration_ms"`
	OK                  bool              `json:"ok"`
}

func writeText(output io.Writer, text string, code int) int {
	if _, err := io.WriteString(output, text); err != nil {
		return exitFailure
	}

	return code
}

type boundedOutput struct {
	cancel  context.CancelFunc
	data    []byte
	limited bool
}

func (output *boundedOutput) Write(data []byte) (int, error) {
	count := min(len(data), outputLimit-len(output.data))

	output.data = append(output.data, data[:count]...)
	if count != len(data) {
		output.limited = true
		output.cancel()
	}

	return len(data), nil
}

func probe(
	parent context.Context, command []string, timeout time.Duration,
) string {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	// Reviewed 2026-09-03: only inventoryCommands or fixture inputs reach here.
	//nolint:gosec // G204: argument tests prove CLI input is rejected.
	cmd := exec.CommandContext(ctx, command[0], command[1:]...)

	stop, err := configureProcess(cmd)
	if err != nil {
		return "unsupported platform"
	}

	stdout, stderr := new(boundedOutput), new(boundedOutput)
	stdout.cancel, stderr.cancel = cancel, cancel
	cmd.Stdout, cmd.Stderr = stdout, stderr
	cmd.Cancel, cmd.WaitDelay = stop, pipeWait
	err = cmd.Run()

	if stopError := stop(); stopError != nil && !errors.Is(stopError, os.ErrProcessDone) {
		return "cleanup failed"
	}

	switch {
	case stdout.limited || stderr.limited:
		return "output limit exceeded"
	case ctx.Err() != nil:
		return timedOut
	case errors.Is(err, exec.ErrNotFound), errors.Is(err, os.ErrNotExist):
		return "not installed"
	case err != nil:
		return "failed"
	}

	return versionLine(stdout.data, stderr.data)
}

func versionLine(stdout, stderr []byte) string {
	output := strings.TrimSpace(string(stdout))
	if output == "" {
		output = strings.TrimSpace(string(stderr))
	}

	line, _, _ := strings.Cut(output, "\n")
	if line == "" {
		return "empty output"
	}

	if len(line) > lineLimit || !utf8.ValidString(line) ||
		strings.ContainsFunc(line, unicode.IsControl) {
		return "invalid output"
	}

	return line
}

func collect(
	ctx context.Context,
	commands map[string][]string,
	workers int,
	read func(context.Context, []string) string,
) map[string]string {
	jobs := make(chan string, len(commands))
	seen := make(map[string]bool)

	for _, command := range commands {
		key := strings.Join(command, commandSeparator)
		if !seen[key] {
			seen[key] = true
			jobs <- key
		}
	}

	close(jobs)

	type response struct{ key, value string }
	responses := make(chan response, len(seen))

	workers = min(workers, len(seen))
	for range workers {
		go func() {
			for key := range jobs {
				value := timedOut
				if ctx.Err() == nil {
					value = read(ctx, strings.Split(key, commandSeparator))
				}
				responses <- response{key, value}
			}
		}()
	}

	versions := make(map[string]string, len(seen))
	for range seen {
		response := <-responses
		versions[response.key] = response.value
	}

	result := make(map[string]string, len(commands))
	for name, command := range commands {
		result[name] = versions[strings.Join(command, commandSeparator)]
	}

	return result
}

func inventoryCommands() map[string][]string {
	commands := map[string][]string{
		"go":        {"go", "version"},
		"swiftlint": {"swiftlint", "version"},
		"bundler":   {"bundle", versionFlag},
		"pip":       {"python3", "-m", "pip", versionFlag},
	}
	for name := range strings.FieldsSeq(
		"bun cc clang c++ clang++ make python3 jar jdeps dotnet gradle " +
			"swift swiftformat cargo rustc php composer ruby gem",
	) {
		commands[name] = []string{name, versionFlag}
	}

	for name := range strings.FieldsSeq("java javac kotlinc") {
		commands[name] = []string{name, "-version"}
	}

	commands["objc"] = commands["clang"]

	return commands
}

func main() {
	os.Exit(run())
}

func run() int {
	if len(os.Args) == 1 {
		return writeInventory()
	}
	if len(os.Args) == 2 && os.Args[1] == "clock" {
		return writeText(os.Stdout, strconv.FormatInt(time.Now().UnixNano(), 10)+"\n", exitOK)
	}
	if os.Args[1] == "summary" {
		return writeSummary(os.Args[2:], time.Now())
	}
	if os.Args[1] == "deadline" {
		return runDeadline(os.Args[2:])
	}
	if os.Args[1] == "_exec" {
		return executeLimited(os.Args[2:])
	}
	return writeText(os.Stderr,
		"toolchain-probe accepts inventory, clock, summary, or deadline mode\n", exitUsage)
}

func runDeadline(arguments []string) int {
	timeout, fileLimit, valid := deadlineLimits(arguments)
	if !valid {
		return exitUsage
	}
	executable, commandError := exec.LookPath(arguments[2])
	self, selfError := os.Executable()
	if commandError != nil || selfError != nil {
		return exitFailure
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	childArguments := append([]string{"_exec", strconv.FormatUint(fileLimit, 10), executable},
		arguments[deadlineArgumentCount:]...)
	// Reviewed 2026-09-03: deadline mode intentionally executes its caller's
	// bounded command through the isolated, limited child mode below.
	//nolint:gosec // G204: timeout, process group, output, and file size are bounded.
	command := exec.CommandContext(ctx, self, childArguments...)
	stop, err := configureProcess(command)
	if err != nil {
		return exitFailure
	}
	command.Stdout, command.Stderr, command.Cancel, command.WaitDelay = os.Stdout, os.Stderr, stop, pipeWait
	err = command.Run()
	stopError := stop()
	if stopError != nil && !errors.Is(stopError, os.ErrProcessDone) ||
		ctx.Err() != nil || err != nil {
		return exitFailure
	}
	return exitOK
}

func deadlineLimits(arguments []string) (time.Duration, uint64, bool) {
	if len(arguments) < deadlineArgumentCount {
		return 0, 0, false
	}
	timeoutMS, timeoutError := strconv.ParseInt(arguments[0], 10, 64)
	fileLimit, limitError := strconv.ParseUint(arguments[1], 10, 64)
	valid := timeoutError == nil && limitError == nil && timeoutMS > 0 &&
		timeoutMS <= int64(maximumDeadline/time.Millisecond) &&
		fileLimit > 0 && fileLimit <= maximumOutputFile
	return time.Duration(timeoutMS) * time.Millisecond, fileLimit, valid
}

func writeInventory() int {
	ctx, cancel := context.WithTimeout(context.Background(), inventoryTimeout)
	defer cancel()

	result := collect(ctx, inventoryCommands(), probeWorkers,
		func(ctx context.Context, command []string) string {
			return probe(ctx, command, commandTimeout)
		})
	for _, name := range []string{"node", "npm", "pnpm"} {
		result[name] = "unsupported: use bun"
	}

	return writeJSON(result, "toolchain inventory output failed\n")
}

func writeSummary(arguments []string, now time.Time) int {
	summary, valid := parseSummary(arguments, now)
	if !valid {
		return writeText(os.Stderr,
			"toolchain summary input invalid\n", exitUsage)
	}
	return writeJSON(summary, "toolchain summary output failed\n")
}

func writeJSON[T map[string]string | checkSummary](value T, note string) int {
	data, err := json.Marshal(value)
	if err != nil {
		return writeText(os.Stderr, note, exitFailure)
	}
	return writeText(os.Stdout, string(data)+"\n", exitOK)
}

func parseSummary(arguments []string, now time.Time) (checkSummary, bool) {
	if len(arguments) < summaryArgumentCount {
		return checkSummary{}, false
	}
	stepsCompleted, stepsError := strconv.Atoi(arguments[1])
	stepsTotal, totalError := strconv.Atoi(arguments[2])
	startNanos, timeError := strconv.ParseInt(arguments[7], 10, 64)
	labels := arguments[summaryArgumentCount:]
	toolchains := make(map[string]string)
	if stepsError != nil || totalError != nil || timeError != nil || startNanos <= 0 ||
		stepsCompleted < 0 || stepsCompleted > stepsTotal || stepsTotal != len(labels) ||
		(arguments[0] != "true" && arguments[0] != "false") ||
		json.Unmarshal([]byte(arguments[6]), &toolchains) != nil {
		return checkSummary{}, false
	}
	optional := [2]*int{}
	for index, position := range []int{9, 4} {
		if arguments[position] != "" {
			value, err := strconv.Atoi(arguments[position])
			if err != nil {
				return checkSummary{}, false
			}
			optional[index] = &value
		}
	}
	duration := int((now.UnixNano() - startNanos + int64(time.Millisecond)/2) / int64(time.Millisecond))
	return checkSummary{
		SchemaVersion: arguments[10], OK: arguments[0] == "true",
		StepsCompleted: stepsCompleted, StepsTotal: stepsTotal, Message: arguments[3],
		StepLabels: labels, CompletedStepLabels: labels[:stepsCompleted], ToolchainVersions: toolchains,
		StartedAt:  time.Unix(0, startNanos).UTC().Format(time.RFC3339),
		FinishedAt: now.UTC().Format(time.RFC3339), DurationMS: max(duration, 0),
		FailureReason: arguments[8], ExitCode: optional[0],
		FailedStepNumber: optional[1], FailedStepLabel: arguments[5],
	}, true
}
