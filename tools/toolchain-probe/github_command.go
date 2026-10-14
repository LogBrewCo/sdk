package main

import (
	"context"
	"io"
	"time"
)

const githubSafetyMode = "github-release-safety"

func runGitHubSafety(arguments []string, output, diagnostic io.Writer) int {
	options := githubSafetyOptionsFor(arguments)
	if options == nil {
		return writeText(diagnostic, "invalid GitHub release safety arguments\n", exitUsage)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	result, complete := githubSafetyOptionsExecute(ctx, options, githubAPIProcess)
	if !complete {
		result.Passed = false
	}
	return writeGitHubSafetyResult(output, result)
}

func githubSafetyOptionsExecute(ctx context.Context, options *githubSafetyOptions,
	run githubAPIRunner,
) (githubSafetyResult, bool) {
	if options.branchFile == "" && options.environmentFile == "" {
		return githubSafetyExecute(ctx, options.request, options.fallback, run)
	}
	branch := githubSafetyBranchSource(ctx, options, run)
	if !branch.read {
		return githubSafetyEvaluate(nil, nil, branch.evidence,
			options.request.environment, options.request.requiredContext), false
	}
	environment, environmentRead := githubSafetySource(ctx, options,
		options.environmentFile, githubEnvironmentRead, run)
	return githubSafetyEvaluate(branch.document, environment, branch.evidence,
		options.request.environment, options.request.requiredContext), environmentRead
}

type githubBranchSource struct {
	document any
	evidence string
	read     bool
}

func githubSafetyBranchSource(ctx context.Context, options *githubSafetyOptions,
	run githubAPIRunner,
) githubBranchSource {
	if options.branchFile != "" {
		branch, valid := githubSafetySource(ctx, options, options.branchFile, options.evidence, run)
		return githubBranchSource{document: branch, evidence: options.evidence, read: valid}
	}
	outcome := githubSafetyReadOutcome(ctx, options.request, options.evidence, run)
	branch, valid := outcome.document, outcome.valid
	evidence := options.evidence
	if outcome.unavailable && options.fallback == githubSummaryEvidence && ctx.Err() == nil {
		branch, valid = githubSafetyRead(ctx, options.request, githubSummaryEvidence, run)
		evidence = githubSummaryEvidence
	}
	return githubBranchSource{document: branch, evidence: evidence, read: valid}
}

func githubSafetySource(ctx context.Context, options *githubSafetyOptions,
	path, kind string, run githubAPIRunner,
) (any, bool) {
	if ctx.Err() != nil {
		return nil, false
	}
	if path == "" {
		return githubSafetyRead(ctx, options.request, kind, run)
	}
	data, readable := readCheckFile(path)
	if !readable {
		return nil, false
	}
	return decodeCheckDocument(data)
}
