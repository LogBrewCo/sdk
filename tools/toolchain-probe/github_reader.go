package main

import (
	"context"
	"os/exec"
	"time"
)

const githubEnvironmentRead = "environment"

type githubAPIRunner func(context.Context, []string) ([]byte, bool)

func githubSafetyLive(ctx context.Context, request githubSafetyRequest) (githubSafetyResult, bool) {
	return githubSafetyExecute(ctx, request, githubFullEvidence, githubAPIProcess)
}

func githubSafetyRead(ctx context.Context, request githubSafetyRequest, kind string, run githubAPIRunner) (any, bool) {
	outcome := githubSafetyReadOutcome(ctx, request, kind, run)
	return outcome.document, outcome.valid
}

type githubReadOutcome struct {
	document           any
	valid, unavailable bool
}

func githubSafetyReadOutcome(ctx context.Context, request githubSafetyRequest,
	kind string, run githubAPIRunner,
) githubReadOutcome {
	paths := githubSafetyPaths(request)
	if paths == nil || ctx.Err() != nil || run == nil {
		return githubReadOutcome{document: nil, valid: false, unavailable: false}
	}
	index := 0
	switch kind {
	case githubFullEvidence:
	case githubSummaryEvidence:
		index = 1
	case githubEnvironmentRead:
		index = 2
	default:
		return githubReadOutcome{document: nil, valid: false, unavailable: false}
	}
	data, completed := run(ctx, []string{"api", "--method", "GET", paths[index]})
	if ctx.Err() != nil {
		return githubReadOutcome{document: nil, valid: false, unavailable: false}
	}
	if !completed {
		return githubReadOutcome{document: nil, valid: false, unavailable: true}
	}
	if len(data) > pythonManifestLimit {
		return githubReadOutcome{document: nil, valid: false, unavailable: false}
	}
	document, valid := decodeCheckDocument(data)
	return githubReadOutcome{document: document, valid: valid, unavailable: false}
}

func githubAPIProcess(parent context.Context, arguments []string) ([]byte, bool) {
	const timeout = 20 * time.Second
	executable, err := exec.LookPath("gh")
	if err != nil || parent.Err() != nil {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	stdout := &boundedOutput{cancel: cancel, data: nil, limited: false, limit: pythonManifestLimit}
	stderr := &boundedOutput{cancel: cancel, data: nil, limited: false, limit: outputLimit}
	//nolint:gosec // G204: only validated fixed GET paths from githubSafetyRead; no shell or mutations.
	command := exec.CommandContext(ctx, executable, arguments...)
	command.Stdout, command.Stderr = stdout, stderr
	if runManagedProcess(command) != nil || ctx.Err() != nil || stdout.limited || stderr.limited {
		return nil, false
	}
	return stdout.data, true
}
