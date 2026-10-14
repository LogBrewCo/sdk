package main

import "strconv"

func publicationOptions(arguments []string) *publicationRunIdentity {
	kinds := map[string]bool{
		"repository": false, "run-id": false, "family": false, "workflow-sha": false, "source-sha": false,
	}
	parsed := &registryArguments{values: make(map[string][]string), switches: make(map[string]bool)}
	for len(arguments) > 0 {
		consumed := registryConsumeArgument(arguments, kinds, parsed)
		if consumed == 0 {
			return nil
		}
		arguments = arguments[consumed:]
	}
	values := make(map[string]string)
	for name := range kinds {
		entries := parsed.values[name]
		if len(entries) == 0 {
			return nil
		}
		values[name] = entries[len(entries)-1]
	}
	runID, err := strconv.ParseInt(values["run-id"], 10, 64)
	if err != nil {
		return nil
	}
	identity := &publicationRunIdentity{
		repository: values["repository"], family: values["family"], workflowSHA: values["workflow-sha"],
		sourceSHA: values["source-sha"], runID: runID,
	}
	if !publicationIdentityValid(*identity) {
		return nil
	}
	return identity
}
