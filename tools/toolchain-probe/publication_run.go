package main

import (
	"encoding/json"
	"strconv"
)

const (
	publicationFailure = "failure"
	publicationPathKey = "path"
)

type publicationRunIdentity struct {
	repository  string
	family      string
	workflowSHA string
	sourceSHA   string
	runID       int64
}

func publicationRunMatches(document any, expected publicationRunIdentity) bool {
	run := eventObject(document)
	if !publicationRunNumber(run["id"], expected.runID) ||
		!publicationRunNumber(run["run_attempt"], 1) ||
		run["event"] != "workflow_dispatch" || run["path"] != publishWorkflowPath ||
		run["head_branch"] != "main" || run["head_sha"] != expected.workflowSHA ||
		run["display_title"] != "Publish "+expected.family+" from "+expected.sourceSHA ||
		run["conclusion"] != "failure" ||
		eventObject(run["head_repository"])["full_name"] != expected.repository {
		return false
	}
	references, valid := run["referenced_workflows"].([]any)
	if !valid || len(references) != 1 {
		return false
	}
	reference := eventObject(references[0])
	return reference["path"] == expected.repository+"/.github/workflows/publish-nuget.yml@"+expected.workflowSHA &&
		reference["ref"] == "refs/heads/main" && reference["sha"] == expected.workflowSHA
}

func publicationRunNumber(value any, expected int64) bool {
	number, valid := value.(json.Number)
	return valid && number.String() == strconv.FormatInt(expected, 10)
}
