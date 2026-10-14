package main

import (
	"encoding/json"
	"strconv"
	"testing"
)

func publicationJobsFixture(family string) map[string]any {
	contract, _ := publicationFamilyContract(family)
	steps := make([]any, 0, len(contract.required))
	for name, conclusion := range contract.required {
		steps = append(steps, map[string]any{publicationName: name, publicationConclusion: conclusion})
	}
	jobs := make([]any, 0, 1+len(contract.siblings))
	jobs = append(jobs, map[string]any{
		publicationName: contract.job, publicationConclusion: publicationFailure, "steps": steps,
	})
	for _, name := range contract.siblings {
		jobs = append(jobs, map[string]any{publicationName: name, publicationConclusion: publicationSkipped})
	}
	return map[string]any{"jobs": jobs, "total_count": json.Number(strconv.Itoa(len(jobs)))}
}

func TestPublicationJobsContracts(t *testing.T) {
	t.Parallel()
	for _, family := range []string{registryPythonFamily, nugetJobName} {
		payload := publicationJobsFixture(family)
		if !publicationJobsMatch(payload, family) {
			t.Fatalf("valid %s publication jobs rejected", family)
		}
		jobs, valid := payload["jobs"].([]any)
		if !valid {
			t.Fatal("invalid jobs fixture")
		}
		eventObject(jobs[1])[publicationConclusion] = publicationSuccess
		if publicationJobsMatch(payload, family) {
			t.Fatal("active sibling publication accepted")
		}
		payload = publicationJobsFixture(family)
		jobs, valid = payload["jobs"].([]any)
		if !valid {
			t.Fatal("invalid replacement jobs fixture")
		}
		steps, valid := eventObject(jobs[0])["steps"].([]any)
		if !valid {
			t.Fatal("invalid steps fixture")
		}
		eventObject(jobs[0])["steps"] = append(steps, steps[0])
		if publicationJobsMatch(payload, family) {
			t.Fatal("duplicate publication step accepted")
		}
		payload = publicationJobsFixture(family)
		payload["total_count"] = json.Number("100")
		if publicationJobsMatch(payload, family) {
			t.Fatal("partial publication jobs accepted")
		}
	}
}
