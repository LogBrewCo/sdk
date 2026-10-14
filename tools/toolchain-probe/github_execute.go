package main

import "context"

func githubSafetyExecute(ctx context.Context, request githubSafetyRequest,
	fallbackPolicy string, run githubAPIRunner,
) (githubSafetyResult, bool) {
	outcome := githubSafetyReadOutcome(ctx, request, githubFullEvidence, run)
	branch, branchRead := outcome.document, outcome.valid
	evidence := githubFullEvidence
	if outcome.unavailable && fallbackPolicy == githubSummaryEvidence && ctx.Err() == nil {
		branch, branchRead = githubSafetyRead(ctx, request, githubSummaryEvidence, run)
		evidence = githubSummaryEvidence
	}
	if !branchRead {
		return githubSafetyEvaluate(nil, nil, evidence, request.environment, request.requiredContext), false
	}
	environment, environmentRead := githubSafetyRead(ctx, request, githubEnvironmentRead, run)
	return githubSafetyEvaluate(branch, environment, evidence, request.environment, request.requiredContext),
		environmentRead
}
