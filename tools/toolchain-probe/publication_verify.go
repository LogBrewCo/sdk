package main

import (
	"context"
	"net/http"
)

const publicationVerificationTimeout = 2 * publicationReadTimeout

func verifyPublicationRun(ctx context.Context, client *http.Client,
	identity publicationRunIdentity, authorization string,
) bool {
	if !publicationIdentityValid(identity) || !publicationAuthorizationValid(authorization) || ctx.Err() != nil {
		return false
	}
	bounded, cancel := context.WithTimeout(ctx, publicationVerificationTimeout)
	defer cancel()
	run, valid := publicationRunRead(bounded, client, identity, authorization, publicationReadRun)
	if !valid || !publicationRunMatches(run, identity) {
		return false
	}
	jobs, valid := publicationRunRead(bounded, client, identity, authorization, "jobs")
	return valid && publicationJobsMatch(jobs, identity.family) && bounded.Err() == nil
}
