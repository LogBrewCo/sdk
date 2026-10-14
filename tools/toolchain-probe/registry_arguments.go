package main

import "strings"

const registryArgumentPairWidth = 2

type registryArguments struct {
	values   map[string][]string
	switches map[string]bool
}

func registryArgumentKinds() map[string]bool {
	values := make(map[string]bool)

	for name := range strings.FieldsSeq("version target npm-package npm-version pypi-version nuget-version " +
		"maven-artifact maven-version maven-plan maven-plan-scope timeout retries retry-delay") {
		values[name] = false
	}
	for name := range strings.FieldsSeq("include-unity-npm require-npm-provenance include-pypi-extras include-crates " +
		"include-packagist include-maven include-openupm include-go require-released-package-set expect-absent") {
		values[name] = true
	}
	return values
}

func parseRegistryArguments(arguments []string) *registryArguments {
	options := &registryArguments{values: make(map[string][]string), switches: make(map[string]bool)}
	kinds := registryArgumentKinds()
	for len(arguments) > 0 {
		consumed := registryConsumeArgument(arguments, kinds, options)
		if consumed == 0 {
			return nil
		}
		arguments = arguments[consumed:]
	}
	return options
}

func registryConsumeArgument(arguments []string, kinds map[string]bool, options *registryArguments) int {
	raw := arguments[0]
	if !strings.HasPrefix(raw, "--") {
		return 0
	}
	name, value, inline := strings.Cut(strings.TrimPrefix(raw, "--"), "=")
	isSwitch, known := kinds[name]
	if !known {
		return 0
	}
	if isSwitch {
		if inline {
			return 0
		}
		options.switches[name] = true
		return 1
	}
	consumed := 1
	if !inline {
		if len(arguments) < registryArgumentPairWidth {
			return 0
		}
		value = arguments[1]
		consumed = registryArgumentPairWidth
	}
	if value == "" || len(value) > outputLimit || strings.HasPrefix(value, "--") {
		return 0
	}
	options.values[name] = append(options.values[name], value)
	return consumed
}
