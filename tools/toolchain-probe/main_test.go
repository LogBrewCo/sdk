package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const (
	expectedTimedOut       = "timed out"
	testProbeTimeout       = 250 * time.Millisecond
	processExitPoll        = 10 * time.Millisecond
	concurrentTestWorkers  = 2
	extraTestCommands      = 6
	closedArgumentFixture  = "bad-args-closed"
	childFixture           = "child"
	fixtureFailureCode     = 7
	fixtureExecutableIndex = 0
	fixturePIDFileIndex    = 2
	fixtureReceiptMode     = 0o600
	wantUsageExit          = 2
	wantWriteExit          = 1
	oneActiveProbe         = 1
	aliasCount             = 1
)

func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "_exec" {
		if run() != exitOK {
			panic("limited fixture execution failed")
		}
		return
	}
	if len(os.Args) > 1 &&
		strings.HasPrefix(os.Args[1], "fixture:") {
		// Fixture modes bypass m.Run; their exit code belongs to the fixture.
		// Reviewed 2026-09-03; TestArgumentDiagnosticWriteFailure checks exits.
		//nolint:revive // Fixture exit is not the redundant m.Run exit pattern.
		os.Exit(runFixture(strings.TrimPrefix(os.Args[1], "fixture:")))
	}

	m.Run()
}

func runFixture(mode string) int {
	switch mode {
	case "stdout":
		return writeText(os.Stdout, "fixture 1.2.3\nignored second line\n", exitOK)
	case "stderr":
		return writeText(os.Stderr, "fixture 4.5.6\n", exitOK)
	case "failure":
		return writeText(os.Stderr, "diagnostic must not become a version\n", fixtureFailureCode)
	case "control":
		return writeText(os.Stdout, "fixture\x1b[31m", exitOK)
	case "long":
		return writeText(os.Stdout, strings.Repeat("x", lineLimit+1), exitOK)
	case "empty":
		return writeText(os.Stdout, "", exitOK)
	}

	switch mode {
	case "bad-args", closedArgumentFixture:
		return runArgumentFixture(mode)
	case "flood":
		for {
			code := writeText(os.Stdout, strings.Repeat("x", lineLimit), exitOK)
			if code != exitOK {
				return code
			}
		}
	case childFixture, "background":
		return runChildFixture(mode)
	case "sleep":
		time.Sleep(time.Minute)
	default:
		return exitUsage
	}

	return exitOK
}

func runArgumentFixture(mode string) int {
	if mode == closedArgumentFixture {
		err := os.Stderr.Close()
		if err != nil {
			return exitFailure
		}
	}

	os.Args = []string{os.Args[fixtureExecutableIndex], "--unexpected"}

	return run()
}

func runChildFixture(mode string) int {
	// Reviewed 2026-09-03: TestProbeReapsChild needs a child to outlive its
	// parent. The child self-exits in one minute; the probe kills its group.
	//nolint:gosec,noctx // G204: owned fixture with an independent lifetime.
	child := exec.Command(os.Args[fixtureExecutableIndex], "fixture:sleep")
	child.Stdout, child.Stderr = os.Stdout, os.Stderr

	err := child.Start()
	if err != nil {
		return exitFailure
	}

	data := []byte(strconv.Itoa(child.Process.Pid))

	// Reviewed 2026-09-03: TestProbeReapsChild passes its own t.TempDir file.
	//nolint:gosec // G703: writes only the parent fixture's child-PID receipt.
	err = os.WriteFile(os.Args[fixturePIDFileIndex], data, fixtureReceiptMode)
	if err != nil {
		return exitFailure
	}

	if mode == childFixture {
		time.Sleep(time.Minute)
	}

	return exitOK
}

func TestArgumentDiagnosticWriteFailure(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		mode   string
		output string
		code   int
	}{
		{"bad-args", "toolchain-probe accepts inventory, clock, summary, or deadline mode\n", wantUsageExit},
		{closedArgumentFixture, "", wantWriteExit},
	} {
		t.Run(test.mode, func(t *testing.T) {
			t.Parallel()

			ctx, cancel := context.WithTimeout(t.Context(), time.Second)
			defer cancel()

			// Reviewed 2026-09-03: modes above select this test binary only.
			//nolint:gosec // G204: fixed fixtures exercise real exit behavior.
			command := exec.CommandContext(ctx,
				os.Args[fixtureExecutableIndex], "fixture:"+test.mode)

			output, err := command.CombinedOutput()
			if err == nil || command.ProcessState.ExitCode() != test.code ||
				string(output) != test.output {
				t.Fatalf("diagnostic %q: code=%v error=%v output=%q",
					test.mode, command.ProcessState, err, output)
			}
		})
	}
}

func TestDeadlineRunsBoundsAndReaps(t *testing.T) {
	t.Parallel()
	temp := t.TempDir()
	if code := runDeadline([]string{"1000", "4096", os.Args[0], "fixture:empty"}); code != exitOK {
		t.Fatalf("successful deadline returned %d", code)
	}

	pidFile := filepath.Join(temp, "child.pid")
	if code := runDeadline([]string{"250", "4096", os.Args[0], "fixture:child", pidFile}); code != exitFailure {
		t.Fatalf("timed deadline returned %d", code)
	}
	assertChildStopped(t, pidFile)

	for _, arguments := range [][]string{nil, {"0", "1", os.Args[0]},
		{"60001", "1", os.Args[0]}} {
		if code := runDeadline(arguments); code != exitUsage {
			t.Errorf("invalid deadline returned %d", code)
		}
	}
}

func TestProbeResults(t *testing.T) {
	t.Parallel()

	for _, test := range []struct{ mode, want string }{
		{"stdout", "fixture 1.2.3"},
		{"stderr", "fixture 4.5.6"},
		{"failure", "failed"},
		{"empty", "empty output"},
		{"control", "invalid output"},
		{"long", "invalid output"},
		{"flood", "output limit exceeded"},
		{"sleep", expectedTimedOut},
	} {
		t.Run(test.mode, func(t *testing.T) {
			t.Parallel()

			started := time.Now()

			command := []string{os.Args[fixtureExecutableIndex], "fixture:" + test.mode}

			got := probe(t.Context(), command, testProbeTimeout)
			if got != test.want || time.Since(started) > time.Second {
				t.Fatalf("got %q after %s, want %q within one second",
					got, time.Since(started), test.want)
			}
		})
	}

	command := []string{filepath.Join(t.TempDir(), "absent")}

	got := probe(t.Context(), command, time.Second)
	if got != "not installed" {
		t.Fatalf("missing executable: %q", got)
	}
}

func TestProbeReapsChild(t *testing.T) {
	t.Parallel()

	for mode, want := range map[string]string{
		childFixture: expectedTimedOut, "background": "failed",
	} {
		t.Run(mode, func(t *testing.T) {
			t.Parallel()

			pidFile := filepath.Join(t.TempDir(), "child.pid")
			command := []string{os.Args[fixtureExecutableIndex], "fixture:" + mode, pidFile}

			got := probe(t.Context(), command, testProbeTimeout)
			if got != want {
				t.Fatalf("got %q", got)
			}

			assertChildStopped(t, pidFile)
		})
	}
}

func assertChildStopped(t *testing.T, pidFile string) {
	t.Helper()

	// Reviewed 2026-09-03: TestProbeReapsChild supplies its own t.TempDir file.
	//nolint:gosec // G304: bounded fixture PID receipt, not an external path.
	data, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}

	pid, err := strconv.Atoi(string(data))
	if err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(time.Second)
	for processAlive(pid) && time.Now().Before(deadline) {
		time.Sleep(processExitPoll)
	}

	if processAlive(pid) {
		t.Fatalf("child %d survived probe cancellation", pid)
	}
}

func TestInventoryDeduplicatesAndBoundsConcurrency(t *testing.T) {
	t.Parallel()

	commands := map[string][]string{
		"first": {"same"}, "alias": {"same"}, "other": {"other"},
	}

	for index := range extraTestCommands {
		name := strconv.Itoa(index)
		commands[name] = []string{name}
	}

	calls := make(chan string, len(commands))

	var active atomic.Int32

	read := func(_ context.Context, args []string) string {
		if active.Add(oneActiveProbe) > concurrentTestWorkers {
			t.Error("probe concurrency limit exceeded")
		}
		defer active.Add(-oneActiveProbe)

		time.Sleep(time.Millisecond)

		calls <- args[fixtureExecutableIndex]

		return args[fixtureExecutableIndex] + " version"
	}

	got := collect(t.Context(), commands, concurrentTestWorkers, read)
	if len(calls) != len(commands)-aliasCount || len(got) != len(commands) ||
		got["first"] != got["alias"] {
		t.Fatalf("deduplication failed: %v, %d calls", got, len(calls))
	}
}

func TestCancelledInventory(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	commands := inventoryCommands()
	read := func(context.Context, []string) string {
		t.Error("cancelled inventory started a probe")

		return "unexpected execution"
	}

	got := collect(ctx, commands, concurrentTestWorkers, read)
	if len(got) != len(commands) {
		t.Fatalf("cancelled inventory returned %d entries", len(got))
	}

	for name, value := range got {
		if value != expectedTimedOut {
			t.Errorf("cancelled %s reported %q", name, value)
		}
	}
}
