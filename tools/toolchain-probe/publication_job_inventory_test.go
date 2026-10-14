package main

import "testing"

func TestPublicationJobInventoryRejections(t *testing.T) {
	t.Parallel()
	for _, family := range []string{registryPythonFamily, nugetJobName} {
		for _, mutation := range []string{
			"duplicate-job", "malformed-job", "unknown-job", "selected-success", "no-steps",
		} {
			payload := publicationJobsFixture(family)
			jobs, valid := payload["jobs"].([]any)
			if !valid {
				t.Fatal("invalid publication inventory fixture")
			}
			switch mutation {
			case "duplicate-job":
				jobs[1] = jobs[0]
			case "malformed-job":
				jobs[1] = nil
			case "unknown-job":
				eventObject(jobs[1])[publicationName] = "Unrelated publication job"
			case "selected-success":
				eventObject(jobs[0])[publicationConclusion] = publicationSuccess
			case "no-steps":
				eventObject(jobs[0])["steps"] = nil
			default:
				t.Fatal("unknown publication mutation")
			}
			if publicationJobsMatch(payload, family) {
				t.Fatalf("%s accepted %s job inventory", family, mutation)
			}
		}
	}
}

func TestPublicationJobNeutralSiblings(t *testing.T) {
	t.Parallel()
	payload := publicationJobsFixture(nugetJobName)
	jobs, valid := payload["jobs"].([]any)
	if !valid {
		t.Fatal("invalid neutral sibling fixture")
	}
	for _, job := range jobs[1:] {
		eventObject(job)[publicationConclusion] = "neutral"
	}
	if !publicationJobsMatch(payload, nugetJobName) || publicationJobsMatch(payload, "unknown-family") {
		t.Fatal("publication sibling or family policy changed")
	}
}
