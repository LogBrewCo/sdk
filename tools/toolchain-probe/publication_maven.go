package main

import (
	"strings"

	"go.yaml.in/yaml/v3"
)

const mavenUploadEndpoint = "https://central.sonatype.com/api/v1/publisher/upload"

func validPublicationMaven(data []byte) bool {
	steps := yamlField(parseMetadataYAML(data), "jobs", "maven", "steps")
	if steps == nil || steps.Kind != yaml.SequenceNode || !validMavenCheckoutAuthentication(steps) {
		return false
	}
	var scripts []string
	var names []string
	bound := false
	for _, step := range steps.Content {
		if name := yamlField(step, pythonPublicName); name != nil {
			names = append(names, name.Value)
		}
		if yamlScalar(yamlField(step, "id"), yamlStringTag, "maven-release-control") {
			bound = true
		}
		if script := yamlField(step, "run"); script != nil {
			if !validMavenPlanScript(step, script) {
				return false
			}
			scripts = append(scripts, script.Value)
		}
	}
	text := strings.Join(scripts, "\n")
	return bound && validMavenPublicationOrder(names) &&
		strings.Count(text, mavenUploadEndpoint) == 1 &&
		strings.Count(text, `sha256sum "$control_script"`) == 3 && strings.Count(text, "verify_control_script") == 3
}

func validMavenCheckoutAuthentication(steps *yaml.Node) bool {
	checkouts := 0
	for _, step := range steps.Content {
		action := yamlField(step, "uses")
		if action == nil || !strings.HasPrefix(action.Value, "actions/checkout@") {
			continue
		}
		if !yamlScalar(checkoutPersistence(step), yamlBooleanTag, "false") {
			return false
		}
		checkouts++
	}
	return checkouts == reconciliationJobCount
}

func validMavenPlanScript(step, script *yaml.Node) bool {
	return !yamlScalar(yamlField(step, pythonPublicName), yamlStringTag, "Plan selected Maven artifacts") ||
		!strings.Contains(script.Value, "${{ inputs.maven_artifacts }}")
}

func validMavenPublicationOrder(names []string) bool {
	requiredNames := []string{
		"Upload Maven Central deployment bundle", "Wait for Maven Central deployment",
		"Verify Maven Central publication", "Verify public Maven Central install",
	}
	position := 0
	for _, name := range names {
		for index, required := range requiredNames {
			if name == required {
				if position != index {
					return false
				}
				position++
			}
		}
	}
	return position == len(requiredNames)
}
