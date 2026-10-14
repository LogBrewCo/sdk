package main

import (
	"path/filepath"
	"strings"
)

const githubDefaultBranch = "main"

type githubSafetyOptions struct {
	request                                         githubSafetyRequest
	branchFile, environmentFile, evidence, fallback string
}

func githubSafetyArguments(arguments []string) *registryArguments {
	kinds := map[string]bool{"allow-public-branch-summary": true}
	for name := range strings.FieldsSeq("repo branch environment required-context branch-protection-json " +
		"branch-summary-json environment-json") {
		kinds[name] = false
	}
	options := &registryArguments{values: make(map[string][]string), switches: make(map[string]bool)}
	for len(arguments) > 0 {
		consumed := registryConsumeArgument(arguments, kinds, options)
		if consumed == 0 {
			return nil
		}
		arguments = arguments[consumed:]
	}
	return options
}

func githubSafetyOptionsFor(arguments []string) *githubSafetyOptions {
	parsed := githubSafetyArguments(arguments)
	if parsed == nil {
		return nil
	}
	options := &githubSafetyOptions{
		request: githubSafetyRequest{
			repository: "LogBrewCo/sdk", branch: githubDefaultBranch,
			environment: "release", requiredContext: "Contract checks",
		},
		branchFile: "", environmentFile: "", evidence: githubFullEvidence, fallback: githubFullEvidence,
	}
	for name, values := range parsed.values {
		value := values[len(values)-1]
		switch name {
		case "repo":
			options.request.repository = value
		case "branch":
			options.request.branch = value
		case "environment":
			options.request.environment = value
		case "required-context":
			options.request.requiredContext = value
		case "branch-protection-json", "branch-summary-json":
			if options.branchFile != "" {
				return nil
			}
			options.branchFile = value
			if name == "branch-summary-json" {
				options.evidence = githubSummaryEvidence
			}
		case "environment-json":
			options.environmentFile = value
		default:
			return nil
		}
	}
	if parsed.switches["allow-public-branch-summary"] {
		options.fallback = githubSummaryEvidence
	}
	if !githubSafetyOptionsValid(options) {
		return nil
	}
	return options
}

func githubSafetyOptionsValid(options *githubSafetyOptions) bool {
	return githubSafetyRequestValid(options.request) && githubFixturePath(options.branchFile) &&
		githubFixturePath(options.environmentFile)
}

func githubFixturePath(path string) bool {
	return path == "" || filepath.IsAbs(path) && githubSafetyText(path)
}
