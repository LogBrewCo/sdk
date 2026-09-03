//go:build darwin || linux

package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"testing"
	"time"
)

const (
	repeatStops         = 3
	unstartedProcessPID = 0
)

func TestProcessStopIsIdempotent(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithTimeout(t.Context(), testProbeTimeout)
	defer cancel()

	// Reviewed 2026-09-03: this test invokes its own compiled sleep fixture.
	//nolint:gosec // G204: no caller-selected executable or arguments.
	command := exec.CommandContext(ctx, os.Args[0], "fixture:sleep")

	stop, err := configureProcess(command)
	if err != nil {
		t.Fatal(err)
	}

	command.Cancel, command.WaitDelay = stop, pipeWait

	err = command.Start()
	if err != nil {
		t.Fatal(err)
	}

	first := stop()

	time.Sleep(processExitPoll)

	for range repeatStops {
		err = stop()
		if !errors.Is(err, first) {
			t.Errorf("stop changed result for owned process %d: %v, want %v",
				command.Process.Pid, err, first)
		}
	}

	err = command.Wait()
	if first != nil || err == nil {
		t.Fatalf("expected successful stop and failed process: stop=%v wait=%v",
			first, err)
	}
}

func TestProcessStopRejectsNonChildIDs(t *testing.T) {
	t.Parallel()

	for _, pid := range []int{
		-systemProcessPID, unstartedProcessPID, systemProcessPID,
	} {
		command := &exec.Cmd{Process: &os.Process{Pid: pid}}

		stop, err := configureProcess(command)
		if err != nil {
			t.Fatal(err)
		}

		err = stop()
		if !errors.Is(err, os.ErrProcessDone) {
			t.Errorf("invalid process %d: %v", pid, err)
		}
	}
}
