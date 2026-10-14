package main

import "testing"

func publicationStepsFixture(contract publicationContract) []any {
	steps := make([]any, 0, len(contract.required))
	for name, conclusion := range contract.required {
		steps = append(steps, map[string]any{publicationName: name, publicationConclusion: conclusion})
	}
	return steps
}

func TestPublicationRequiredStepRejections(t *testing.T) {
	t.Parallel()
	for _, family := range []string{registryPythonFamily, nugetJobName} {
		contract, _ := publicationFamilyContract(family)
		checkPublicationRequiredSteps(t, contract)
	}
}

func checkPublicationRequiredSteps(t *testing.T, contract publicationContract) {
	t.Helper()
	for name := range contract.required {
		steps := publicationStepsFixture(contract)
		for index, value := range steps {
			if eventObject(value)[publicationName] != name {
				continue
			}
			missing := append(append([]any{}, steps[:index]...), steps[index+1:]...)
			if publicationStepsMatch(missing, contract) {
				t.Fatalf("accepted missing step %s", name)
			}
			eventObject(value)[publicationConclusion] = "cancelled"
			if publicationStepsMatch(steps, contract) {
				t.Fatalf("accepted changed step %s", name)
			}
		}
	}
	steps := publicationStepsFixture(contract)
	steps = append(steps, map[string]any{
		publicationName: "Unexpected failed step", publicationConclusion: publicationFailure,
	})
	if publicationStepsMatch(steps, contract) || publicationStepsMatch([]any{nil}, contract) {
		t.Fatal("unexpected failure or malformed step accepted")
	}
}

func TestPublicationReferenceRejections(t *testing.T) {
	t.Parallel()
	for _, field := range []string{publicationPathKey, workflowRefKey, "sha"} {
		run, identity := publicationRunFixture()
		references, valid := run["referenced_workflows"].([]any)
		if !valid {
			t.Fatal("invalid reusable workflow fixture")
		}
		eventObject(references[0])[field] = "unbound-reference"
		if publicationRunMatches(run, identity) {
			t.Fatalf("unbound reusable workflow %s accepted", field)
		}
	}
	run, identity := publicationRunFixture()
	run["referenced_workflows"] = []any{nil, nil}
	if publicationRunMatches(run, identity) {
		t.Fatal("multiple reusable workflow references accepted")
	}
}
