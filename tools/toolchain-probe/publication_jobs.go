package main

import "slices"

func publicationJobsMatch(document any, family string) bool {
	contract, supported := publicationFamilyContract(family)
	jobs, valid := eventObject(document)["jobs"].([]any)
	if !supported || !valid || len(jobs) != len(contract.siblings)+1 ||
		!publicationRunNumber(eventObject(document)["total_count"], int64(len(jobs))) {
		return false
	}
	seen := make(map[string]bool)
	for _, value := range jobs {
		job := eventObject(value)
		name, named := job[publicationName].(string)
		if !named || seen[name] {
			return false
		}
		seen[name] = true
		if name == contract.job {
			if job[publicationConclusion] != publicationFailure || !publicationStepsMatch(job["steps"], contract) {
				return false
			}
		} else if !slices.Contains(contract.siblings, name) ||
			job[publicationConclusion] != publicationSkipped && job[publicationConclusion] != "neutral" {
			return false
		}
	}
	return seen[contract.job]
}

func publicationStepsMatch(document any, contract publicationContract) bool {
	steps, valid := document.([]any)
	if !valid {
		return false
	}
	results := make(map[string]string)
	for _, value := range steps {
		step := eventObject(value)
		name, named := step[publicationName].(string)
		conclusion, concluded := step[publicationConclusion].(string)
		if _, duplicate := results[name]; !named || !concluded || duplicate ||
			conclusion == publicationFailure && name != contract.failed {
			return false
		}
		results[name] = conclusion
	}
	for name, conclusion := range contract.required {
		if results[name] != conclusion {
			return false
		}
	}
	return true
}
