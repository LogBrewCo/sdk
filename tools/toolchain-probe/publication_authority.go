package main

import (
	"regexp"
	"strings"
)

var publicationRevision = regexp.MustCompile(`^[0-9a-f]{40}$`)

func publicationIdentityValid(identity publicationRunIdentity) bool {
	parts := strings.Split(identity.repository, "/")
	if len(parts) != 2 || !githubRepositoryPart(parts[0]) || !githubRepositoryPart(parts[1]) ||
		identity.runID <= 0 || !publicationRevision.MatchString(identity.workflowSHA) ||
		!publicationRevision.MatchString(identity.sourceSHA) {
		return false
	}
	_, supported := publicationFamilyContract(identity.family)
	return supported
}
