package main

const (
	npmPublisherPath = "tools/npm-publish/publish.mjs"
	npmExchangePath  = "/-/npm/v1/oidc/token/exchange/package/"
)

func validPublicationNPM(workflow, publisher []byte) bool {
	permissions := yamlField(parseMetadataYAML(workflow), "jobs", "npm", "permissions")
	return yamlScalar(yamlField(permissions, "id-token"), yamlStringTag, "write") &&
		validMetadataText(workflow, npmWorkflowRequirements()) &&
		validMetadataText(publisher, npmPublisherRequirements())
}

func npmPublisherRequirements() []string {
	return []string{
		"npm:registry.npmjs.org", npmExchangePath, "provenance: true",
	}
}

func npmWorkflowRequirements() []string {
	return []string{
		"npm trusted publishing requires existing package pages",
		"Bun publication requires an explicit npm_packages selection", "--require-npm-provenance",
	}
}
