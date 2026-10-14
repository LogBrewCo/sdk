package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

const publicationSHAKey = "sha"

func publicationBoundRunFixture(identity publicationRunIdentity) map[string]any {
	run, _ := publicationRunFixture()
	run["head_sha"] = identity.workflowSHA
	run["display_title"] = "Publish " + identity.family + " from " + identity.sourceSHA
	run["referenced_workflows"] = []any{map[string]any{
		publicationPathKey: identity.repository + "/.github/workflows/publish-nuget.yml@" + identity.workflowSHA,
		workflowRefKey:     "refs/heads/main", publicationSHAKey: identity.workflowSHA,
	}}
	return run
}

func TestPublicationVerificationSequence(t *testing.T) {
	t.Parallel()
	for _, family := range []string{registryPythonFamily, nugetJobName} {
		for _, jobsValid := range []bool{true, false} {
			identity := publicationHTTPIdentity()
			identity.family = family
			run := publicationBoundRunFixture(identity)
			jobs := publicationJobsFixture(family)
			if !jobsValid {
				jobs["total_count"] = json.Number("0")
			}
			client := new(http.Client)
			requests := 0
			client.Transport = publicationSequenceTransport(t, run, jobs, &requests)
			passed := verifyPublicationRun(context.Background(), client, identity, "sequence-fixture-auth")
			if passed != jobsValid || requests != 2 {
				t.Fatalf("publication %s sequence = %t, requests %d", family, passed, requests)
			}
		}
	}
}

func publicationSequenceTransport(t *testing.T, run, jobs map[string]any,
	requests *int,
) pythonRegistryFixtureTransport {
	t.Helper()
	return func(request *http.Request) (*http.Response, error) {
		*requests++
		var payload any = run
		const jobsRequestIndex = 2
		if *requests == jobsRequestIndex {
			payload = jobs
			if !strings.HasSuffix(request.URL.Path, "/jobs") {
				t.Error("publication jobs read lost endpoint order")
			}
		} else if strings.HasSuffix(request.URL.Path, "/jobs") {
			t.Error("publication jobs read preceded run binding")
		}
		data, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		response := new(http.Response)
		response.StatusCode = http.StatusOK
		response.Body = io.NopCloser(strings.NewReader(string(data)))
		return response, nil
	}
}
